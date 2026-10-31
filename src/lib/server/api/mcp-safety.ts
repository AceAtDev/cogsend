import { and, eq, isNull, lt } from 'drizzle-orm';
import { bytesToHex, randomHex, utf8Bytes } from '#lib/domain/bytes.js';
import { first, newId, parseJson, type AppDb } from '#lib/server/db/client.js';
import { mcpConfirmations, mcpIdempotency } from '#lib/server/db/schema.js';
import { isUniqueConstraintError } from '#lib/server/publish-plan.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';

/**
 * Server-side halves of the MCP write protocol.
 *
 * Confirmations: a dry run hands back a token bound to a hash of the exact
 * plan it previewed (channels resolved to account ids, times resolved to UTC,
 * the text). Committing recomputes that hash from the new call, so a token
 * cannot carry a different payload, a re-pointed channel key or a stale
 * preview into a write. Tokens are single-use and short-lived; only a hash is
 * stored.
 *
 * Idempotency keys follow Stripe: the first call with a key runs and its
 * answer is kept for a day; the same key with the same parameters replays
 * that answer; the same key with different parameters is refused.
 */

export const CONFIRM_TTL_MS = 10 * 60_000;
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
// A call that died mid-run leaves its row without an answer. Past this, a
// retry with the same key may take it over rather than wait forever.
const PENDING_STALE_MS = 5 * 60_000;

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(text) as BufferSource);
	return bytesToHex(new Uint8Array(digest));
}

/** JSON with object keys sorted, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
	if (value === undefined) return 'null';
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashPayload(value: unknown): Promise<string> {
	return sha256Hex(canonicalJson(value));
}

function refuse(message: string, code: string, status = 400): never {
	throw new ApiOperationError(message, status, { code });
}

export async function issueConfirmation(
	db: AppDb,
	userId: string,
	tool: string,
	payloadHash: string,
	now = new Date()
): Promise<{ token: string; expiresAt: Date }> {
	await db
		.delete(mcpConfirmations)
		.where(and(eq(mcpConfirmations.userId, userId), lt(mcpConfirmations.expiresAt, now)));
	const token = `cfm_${randomHex(24)}`;
	const expiresAt = new Date(now.getTime() + CONFIRM_TTL_MS);
	await db.insert(mcpConfirmations).values({
		id: newId(),
		userId,
		tokenHash: await sha256Hex(token),
		tool,
		payloadHash,
		expiresAt,
		createdAt: now
	});
	return { token, expiresAt };
}

/**
 * Spend a token on this exact payload. Spent before the write so two calls
 * racing with one token cannot both commit; `release` gives it back when the
 * write fails before changing anything.
 */
export async function consumeConfirmation(
	db: AppDb,
	userId: string,
	tool: string,
	token: string,
	payloadHash: string,
	now = new Date()
): Promise<{ release: () => Promise<void> }> {
	const redo = `Call ${tool} again with dryRun: true and the same arguments to get a new confirmToken.`;
	const row = await first(
		db
			.select()
			.from(mcpConfirmations)
			.where(
				and(
					eq(mcpConfirmations.tokenHash, await sha256Hex(token)),
					eq(mcpConfirmations.userId, userId)
				)
			)
	);
	if (!row) refuse(`confirmToken is not one this server issued. ${redo}`, 'confirm_token_invalid');
	if (row.tool !== tool)
		refuse(`confirmToken was issued by ${row.tool}, not ${tool}. ${redo}`, 'confirm_token_invalid');
	if (row.usedAt) refuse(`confirmToken was already used. ${redo}`, 'confirm_token_used');
	if (row.expiresAt.getTime() <= now.getTime())
		refuse(
			`confirmToken expired (tokens last ${CONFIRM_TTL_MS / 60_000} minutes). ${redo}`,
			'confirm_token_expired'
		);
	if (row.payloadHash !== payloadHash)
		refuse(
			`This call differs from the dry run its confirmToken was issued for: different posts, channels, times or text, or a channel key now points at another account. Nothing was written. ${redo}`,
			'confirm_payload_mismatch'
		);
	const spent = await db
		.update(mcpConfirmations)
		.set({ usedAt: now })
		.where(and(eq(mcpConfirmations.id, row.id), isNull(mcpConfirmations.usedAt)))
		.returning({ id: mcpConfirmations.id });
	if (!spent.length) refuse(`confirmToken was already used. ${redo}`, 'confirm_token_used');
	return {
		release: async () => {
			await db
				.update(mcpConfirmations)
				.set({ usedAt: null })
				.where(eq(mcpConfirmations.id, row.id));
		}
	};
}

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

/**
 * Run `operation` at most once per key. A replay answers what the first call
 * answered, with `idempotentReplay: true`. A thrown error forgets the key, so
 * a corrected retry can use it; an operation that committed part of its work
 * must return (not throw) that partial answer so the key keeps it.
 */
export async function withIdempotency<T extends Record<string, unknown>>(
	db: AppDb,
	userId: string,
	tool: string,
	key: string | undefined,
	request: unknown,
	operation: () => Promise<T>,
	now = new Date()
): Promise<T & { idempotentReplay?: boolean }> {
	if (!key) return operation();
	const requestHash = await hashPayload({ tool, request });
	await db
		.delete(mcpIdempotency)
		.where(and(eq(mcpIdempotency.userId, userId), lt(mcpIdempotency.expiresAt, now)));
	const find = () =>
		first(
			db
				.select()
				.from(mcpIdempotency)
				.where(and(eq(mcpIdempotency.userId, userId), eq(mcpIdempotency.key, key)))
		);
	let rowId: string | null = null;
	for (let attempt = 0; attempt < 2 && !rowId; attempt++) {
		const existing = await find();
		if (existing) {
			if (existing.tool !== tool || existing.requestHash !== requestHash) {
				refuse(
					`idempotencyKey "${key}" was already used with different arguments${existing.tool === tool ? '' : ` (by ${existing.tool})`}. Use a new key for a different request; reuse a key only to retry the identical call.`,
					'idempotency_key_reused'
				);
			}
			if (existing.responseJson !== null) {
				return { ...parseJson<T>(existing.responseJson, {} as T), idempotentReplay: true };
			}
			if (now.getTime() - existing.createdAt.getTime() < PENDING_STALE_MS) {
				refuse(
					`A call with idempotencyKey "${key}" is still running. Wait a few seconds and retry the identical call to get its result.`,
					'idempotency_in_progress',
					409
				);
			}
			const taken = await db
				.update(mcpIdempotency)
				.set({ createdAt: now })
				.where(
					and(
						eq(mcpIdempotency.id, existing.id),
						eq(mcpIdempotency.createdAt, existing.createdAt),
						isNull(mcpIdempotency.responseJson)
					)
				)
				.returning({ id: mcpIdempotency.id });
			if (taken.length) rowId = existing.id;
			continue;
		}
		const id = newId();
		try {
			await db.insert(mcpIdempotency).values({
				id,
				userId,
				key,
				tool,
				requestHash,
				responseJson: null,
				createdAt: now,
				expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS)
			});
			rowId = id;
		} catch (err) {
			if (!isUniqueConstraintError(err)) throw err;
		}
	}
	if (!rowId)
		refuse(
			`A call with idempotencyKey "${key}" is still running. Retry the identical call shortly.`,
			'idempotency_in_progress',
			409
		);
	let result: T;
	try {
		result = await operation();
	} catch (err) {
		await db
			.delete(mcpIdempotency)
			.where(eq(mcpIdempotency.id, rowId))
			.catch(() => {});
		throw err;
	}
	await db
		.update(mcpIdempotency)
		.set({ responseJson: JSON.stringify(result) })
		.where(eq(mcpIdempotency.id, rowId));
	return result;
}

/**
 * The answer a finished call with this key gave, or null. Checked before a
 * write re-plans anything: a replay must answer what happened even when the
 * same plan would no longer pass (its time has gone by, say).
 */
export async function peekIdempotent<T extends Record<string, unknown>>(
	db: AppDb,
	userId: string,
	tool: string,
	key: string | undefined,
	request: unknown,
	now = new Date()
): Promise<(T & { idempotentReplay: true }) | null> {
	if (!key) return null;
	const row = await first(
		db
			.select()
			.from(mcpIdempotency)
			.where(and(eq(mcpIdempotency.userId, userId), eq(mcpIdempotency.key, key)))
	);
	if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
	if (row.tool !== tool || row.requestHash !== (await hashPayload({ tool, request }))) {
		refuse(
			`idempotencyKey "${key}" was already used with different arguments${row.tool === tool ? '' : ` (by ${row.tool})`}. Use a new key for a different request; reuse a key only to retry the identical call.`,
			'idempotency_key_reused'
		);
	}
	if (row.responseJson === null) return null;
	return { ...parseJson<T>(row.responseJson, {} as T), idempotentReplay: true };
}
