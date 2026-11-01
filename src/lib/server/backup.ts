import { sql } from 'drizzle-orm';
import { parseJson, type AppDb } from './db/client';
import type { SubrequestBudget } from './budget';
import { readAppSetting, writeAppSetting } from './app-settings';
import type { MediaStore } from './media';

const DAY = 24 * 60 * 60_000;

/** How often a fresh backup starts. */
export const BACKUP_INTERVAL_MS = 7 * DAY;
/** Backups kept; older ones are deleted when a new one completes. */
export const BACKUPS_KEPT = 8;
/** Rows per file: one statement to read, one R2 write. */
export const BACKUP_PAGE_ROWS = 2000;
/** Where the backup's progress and history live, in `app_settings`. */
export const BACKUP_SETTING = 'backup_state';
/** R2 prefix of every backup, beside the media. */
export const BACKUP_PREFIX = 'backups/';

/**
 * Rows a restore does not need: sign-in sessions and challenges, connect
 * attempts in flight, MCP replay guards and the heartbeat. Restoring them
 * would only bring back expired state.
 */
const SKIPPED_TABLES = new Set([
	'sessions',
	'mfa_challenges',
	'oauth_pending',
	'mcp_idempotency',
	'mcp_confirmations',
	'scheduler_heartbeats'
]);

type BackupRun = {
	id: string;
	startedAt: number;
	tables: string[];
	/** Position of the table being read, and the last rowid written from it. */
	table: number;
	afterRowid: number;
	keys: string[];
};

type BackupState = {
	run?: BackupRun | null;
	/** Completed backups, newest last: their id and the files to delete later. */
	done?: { id: string; finishedAt: number; keys: string[] }[];
};

/** A SQL literal for one stored value. */
export function sqlLiteral(value: unknown): string {
	if (value === null || value === undefined) return 'NULL';
	if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'boolean') return value ? '1' : '0';
	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		const bytes =
			value instanceof ArrayBuffer
				? new Uint8Array(value)
				: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}'`;
	}
	return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

function insertStatements(table: string, rows: Record<string, unknown>[]): string {
	if (!rows.length) return '';
	const columns = Object.keys(rows[0]).filter((c) => c !== '__rowid');
	const head = `INSERT OR REPLACE INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) VALUES `;
	return (
		'PRAGMA defer_foreign_keys = true;\n' +
		rows.map((row) => `${head}(${columns.map((c) => sqlLiteral(row[c])).join(', ')});`).join('\n') +
		'\n'
	);
}

/**
 * Tables ordered so each comes after the tables it references, which lets a
 * restore insert parents before children. A cycle keeps its name order; the
 * deferred key check in each file covers rows within one table.
 */
export function restoreOrder(tables: { name: string; sql: string }[]): string[] {
	const names = new Set(tables.map((t) => t.name));
	const deps = new Map(
		tables.map((t) => [
			t.name,
			new Set(
				[...t.sql.matchAll(/REFERENCES\s+[`"[]?(\w+)/gi)]
					.map((m) => m[1])
					.filter((ref) => ref !== t.name && names.has(ref))
			)
		])
	);
	const order: string[] = [];
	const placed = new Set<string>();
	while (order.length < tables.length) {
		const ready =
			tables.find(
				(t) => !placed.has(t.name) && [...deps.get(t.name)!].every((d) => placed.has(d))
			) ?? tables.find((t) => !placed.has(t.name))!;
		order.push(ready.name);
		placed.add(ready.name);
	}
	return order;
}

const enc = new TextEncoder();

/**
 * Keep a copy of the database in R2, so a mistake older than D1's own
 * point-in-time window (7 days on the Free plan) can still be undone. Once a
 * week a backup starts; each tick then writes as many files as its leftover
 * calls allow (a schema file, then each table in pages of rows as INSERT
 * statements) until it is complete, and the oldest backups beyond
 * BACKUPS_KEPT are deleted. Restoring is running the files in order with
 * `wrangler d1 execute --file` (docs/backups.md).
 *
 * Runs last in the tick, never throws for want of calls, and resumes where it
 * stopped.
 */
export async function runBackupStep(
	db: AppDb,
	store: MediaStore,
	opts: { now?: number; budget?: SubrequestBudget | null } = {}
): Promise<{ wrote: number; finished: boolean }> {
	const now = opts.now ?? Date.now();
	const budget = opts.budget ?? null;
	const result = { wrote: 0, finished: false };
	const callsLeft = () => (budget ? budget.remaining : Infinity);
	if (callsLeft() < 6) return result;
	const state = parseJson<BackupState>(
		await readAppSetting(db, BACKUP_SETTING, { fresh: true }),
		{}
	);
	const done = state.done ?? [];
	let run = state.run ?? null;
	if (!run) {
		const last = done.at(-1)?.finishedAt ?? 0;
		if (now - last < BACKUP_INTERVAL_MS && last <= now) return result;
		const tables = (
			(await db.all(
				sql`SELECT name, tbl_name AS tbl, sql FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type DESC, name`
			)) as { name: string; tbl: string; sql: string }[]
		).filter((r) => !SKIPPED_TABLES.has(r.tbl));
		budget?.count(1);
		const id = new Date(now).toISOString().replace(/[:.]/g, '-');
		const schema = tables
			.map(
				(t) =>
					`${t.sql
						.replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')
						.replace(
							/^CREATE (UNIQUE )?INDEX /i,
							(_m, u) => `CREATE ${u ?? ''}INDEX IF NOT EXISTS `
						)};`
			)
			.join('\n');
		const schemaKey = `${BACKUP_PREFIX}${id}/000-schema.sql`;
		await store.put(schemaKey, enc.encode(`${schema}\n`), 'application/sql');
		budget?.count(1);
		result.wrote++;
		const tableNames = restoreOrder(tables.filter((t) => /^CREATE TABLE/i.test(t.sql)));
		run = { id, startedAt: now, tables: tableNames, table: 0, afterRowid: 0, keys: [schemaKey] };
	}
	// Each page is a read and a write; keep two calls for the state write.
	while (run.table < run.tables.length && callsLeft() >= 4) {
		const table = run.tables[run.table];
		const rows = (await db.all(
			sql.raw(
				`SELECT rowid AS __rowid, * FROM ${quoteIdent(table)} WHERE rowid > ${Math.floor(run.afterRowid)} ORDER BY rowid LIMIT ${BACKUP_PAGE_ROWS}`
			)
		)) as Record<string, unknown>[];
		budget?.count(1);
		if (rows.length) {
			const key = `${BACKUP_PREFIX}${run.id}/${String(run.table + 1).padStart(3, '0')}-${table}-${String(run.keys.length).padStart(4, '0')}.sql`;
			await store.put(key, enc.encode(insertStatements(table, rows)), 'application/sql');
			budget?.count(1);
			run.keys.push(key);
			result.wrote++;
			run.afterRowid = Number(rows.at(-1)!.__rowid);
		}
		if (rows.length < BACKUP_PAGE_ROWS) {
			run.table++;
			run.afterRowid = 0;
		}
	}
	let nextDone = done;
	if (run.table >= run.tables.length) {
		const manifestKey = `${BACKUP_PREFIX}${run.id}/manifest.json`;
		await store.put(
			manifestKey,
			enc.encode(
				JSON.stringify(
					{ id: run.id, startedAt: run.startedAt, finishedAt: now, files: run.keys },
					null,
					1
				)
			),
			'application/json'
		);
		nextDone = [...done, { id: run.id, finishedAt: now, keys: [...run.keys, manifestKey] }];
		const expired = nextDone.slice(0, Math.max(0, nextDone.length - BACKUPS_KEPT));
		nextDone = nextDone.slice(expired.length);
		for (const old of expired) {
			if (store.deleteMany) await store.deleteMany(old.keys);
			else for (const key of old.keys) await store.delete(key);
		}
		run = null;
		result.finished = true;
	}
	await writeAppSetting(db, BACKUP_SETTING, JSON.stringify({ run, done: nextDone }));
	return result;
}
