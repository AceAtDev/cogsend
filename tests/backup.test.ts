import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { newId, parseJson, type AppDb } from '#lib/server/db/client.js';
import { brands, users } from '#lib/server/db/schema.js';
import { createTestDb } from '#lib/server/db/test.js';
import { memoryMediaStore } from '#lib/server/media.js';
import { readAppSetting, writeAppSetting } from '#lib/server/app-settings.js';
import { SubrequestBudget } from '#lib/server/budget.js';
import {
	BACKUP_INTERVAL_MS,
	BACKUP_PAGE_ROWS,
	BACKUP_SETTING,
	BACKUPS_KEPT,
	runBackupStep,
	sqlLiteral
} from '#lib/server/backup.js';

const DAY = 24 * 60 * 60_000;

describe('database backups', () => {
	let db: AppDb;
	let close: () => void;
	const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
	const store = memoryMediaStore(objects);
	const start = Date.UTC(2026, 10, 1, 12);
	const userId = newId();

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const at = new Date(start - DAY);
		await db.insert(users).values({
			id: userId,
			email: "o'brien@localhost",
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: at,
			updatedAt: at
		});
		// Enough rows to need more than one page.
		const rows = Array.from({ length: BACKUP_PAGE_ROWS + 5 }, (_, i) => ({
			id: newId(),
			userId,
			name: `Brand ${i}`,
			slug: `brand-${i}`,
			color: '#000000',
			createdAt: at,
			updatedAt: at
		}));
		for (let i = 0; i < rows.length; i += 200)
			await db.insert(brands).values(rows.slice(i, i + 200));
	});
	afterAll(() => close());

	const text = (key: string) => new TextDecoder().decode(objects.get(key)!.bytes);

	it('quotes values so a restore reads them back exactly', () => {
		expect(sqlLiteral(null)).toBe('NULL');
		expect(sqlLiteral(12)).toBe('12');
		expect(sqlLiteral("it's")).toBe("'it''s'");
		expect(sqlLiteral(new Uint8Array([0, 255]))).toBe("X'00ff'");
	});

	it('writes a backup across ticks on small budgets, and it restores into an empty database', async () => {
		let finished = false;
		let ticks = 0;
		while (!finished && ticks < 50) {
			const budget = new SubrequestBudget(50);
			budget.count(43); // what a busy tick leaves over
			({ finished } = await runBackupStep(db, store, { now: start + ticks * 60_000, budget }));
			ticks++;
		}
		expect(finished).toBe(true);
		expect(ticks).toBeGreaterThan(1);

		const state = parseJson<{ done: { id: string; keys: string[] }[] }>(
			await readAppSetting(db, BACKUP_SETTING, { fresh: true }),
			{ done: [] }
		);
		expect(state.done).toHaveLength(1);
		const keys = state.done[0].keys;
		expect(keys[0]).toMatch(/000-schema\.sql$/);
		expect(keys.at(-1)).toMatch(/manifest\.json$/);
		expect(keys.filter((k) => k.includes('-brands-'))).toHaveLength(2);
		expect(keys.some((k) => k.includes('-sessions-'))).toBe(false);
		expect(text(keys[0])).not.toMatch(/"?sessions"? \(/);

		const fresh = createClient({ url: ':memory:' });
		for (const key of keys.filter((k) => k.endsWith('.sql'))) {
			await fresh.executeMultiple(text(key));
		}
		const brandCount = await fresh.execute('SELECT count(*) AS n FROM brands');
		expect(Number(brandCount.rows[0].n)).toBe(BACKUP_PAGE_ROWS + 5);
		const user = await fresh.execute('SELECT email FROM users');
		expect(user.rows[0].email).toBe("o'brien@localhost");
		fresh.close();
	});

	it('waits a week before the next one', async () => {
		const result = await runBackupStep(db, store, { now: start + 2 * DAY });
		expect(result).toEqual({ wrote: 0, finished: false });
	});

	it(`keeps the newest ${BACKUPS_KEPT} and deletes the files of older ones`, async () => {
		await writeAppSetting(db, BACKUP_SETTING, JSON.stringify({ run: null, done: [] }));
		objects.clear();
		const ids: string[] = [];
		for (let week = 0; week < BACKUPS_KEPT + 2; week++) {
			const now = start + week * BACKUP_INTERVAL_MS;
			const result = await runBackupStep(db, store, { now });
			expect(result.finished).toBe(true);
			ids.push(new Date(now).toISOString().replace(/[:.]/g, '-'));
		}
		const kept = new Set([...objects.keys()].map((k) => k.split('/')[1]));
		expect([...kept].sort()).toEqual(ids.slice(2).sort());
	});

	it('does nothing when the tick has no calls to spare', async () => {
		const budget = new SubrequestBudget(50);
		budget.count(46);
		const result = await runBackupStep(db, store, { now: start + 99 * DAY, budget });
		expect(result.wrote).toBe(0);
	});
});
