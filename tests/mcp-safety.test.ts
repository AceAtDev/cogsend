import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestAdmin, createTestDb } from '#lib/server/db/test.js';
import type { AppDb } from '#lib/server/db/client.js';
import { mcpIdempotency } from '#lib/server/db/schema.js';
import {
	canonicalJson,
	consumeConfirmation,
	hashPayload,
	issueConfirmation,
	withIdempotency
} from '#lib/server/api/mcp-safety.js';

let db: AppDb;
let close: () => void;
let userId: string;

beforeEach(async () => {
	const t = await createTestDb();
	db = t.db;
	close = t.close;
	userId = (await createTestAdmin(db)).id;
});
afterEach(() => close());

describe('payload hashing', () => {
	it('ignores key order but not values', async () => {
		expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
		expect(await hashPayload({ a: 1, b: 2 })).toBe(await hashPayload({ b: 2, a: 1 }));
		expect(await hashPayload({ a: 1 })).not.toBe(await hashPayload({ a: 2 }));
	});
});

describe('confirmations', () => {
	it('is single use, bound to its payload, user and tool, and expires', async () => {
		const now = new Date('2027-01-01T00:00:00Z');
		const { token } = await issueConfirmation(db, userId, 'schedule_posts', 'hash-a', now);
		await expect(
			consumeConfirmation(db, userId, 'schedule_posts', token, 'hash-b', now)
		).rejects.toMatchObject({
			details: { code: 'confirm_payload_mismatch' }
		});
		await expect(
			consumeConfirmation(db, userId, 'move_post', token, 'hash-a', now)
		).rejects.toMatchObject({
			details: { code: 'confirm_token_invalid' }
		});
		const other = await createTestAdmin(db, { email: 'other@localhost' });
		await expect(
			consumeConfirmation(db, other.id, 'schedule_posts', token, 'hash-a', now)
		).rejects.toMatchObject({
			details: { code: 'confirm_token_invalid' }
		});
		const spent = await consumeConfirmation(db, userId, 'schedule_posts', token, 'hash-a', now);
		await expect(
			consumeConfirmation(db, userId, 'schedule_posts', token, 'hash-a', now)
		).rejects.toMatchObject({
			details: { code: 'confirm_token_used' }
		});
		// A write that failed before changing anything gives the token back.
		await spent.release();
		await consumeConfirmation(db, userId, 'schedule_posts', token, 'hash-a', now);

		const late = await issueConfirmation(db, userId, 'schedule_posts', 'hash-a', now);
		const later = new Date(now.getTime() + 11 * 60_000);
		await expect(
			consumeConfirmation(db, userId, 'schedule_posts', late.token, 'hash-a', later)
		).rejects.toMatchObject({
			details: { code: 'confirm_token_expired' }
		});
	});
});

describe('idempotency keys', () => {
	it('replays, refuses changed arguments, forgets failures and expires after a day', async () => {
		const now = new Date('2027-01-01T00:00:00Z');
		let runs = 0;
		const op = async () => ({ n: ++runs });
		expect(
			await withIdempotency(db, userId, 'schedule_posts', 'key-00001', { a: 1 }, op, now)
		).toEqual({ n: 1 });
		expect(
			await withIdempotency(db, userId, 'schedule_posts', 'key-00001', { a: 1 }, op, now)
		).toEqual({
			n: 1,
			idempotentReplay: true
		});
		await expect(
			withIdempotency(db, userId, 'schedule_posts', 'key-00001', { a: 2 }, op, now)
		).rejects.toMatchObject({
			details: { code: 'idempotency_key_reused' }
		});
		await expect(
			withIdempotency(db, userId, 'move_post', 'key-00001', { a: 1 }, op, now)
		).rejects.toMatchObject({
			details: { code: 'idempotency_key_reused' }
		});
		await expect(
			withIdempotency(
				db,
				userId,
				'schedule_posts',
				'key-00002',
				{},
				async () => {
					throw new Error('boom');
				},
				now
			)
		).rejects.toThrow('boom');
		expect(await withIdempotency(db, userId, 'schedule_posts', 'key-00002', {}, op, now)).toEqual({
			n: 2
		});
		const tomorrow = new Date(now.getTime() + 24 * 3_600_000 + 1);
		expect(
			await withIdempotency(db, userId, 'schedule_posts', 'key-00001', { a: 2 }, op, tomorrow)
		).toEqual({ n: 3 });
	});

	it('refuses a concurrent call with the same key, and lets a stale one be taken over', async () => {
		const now = new Date('2027-01-01T00:00:00Z');
		let release!: () => void;
		const slow = withIdempotency(
			db,
			userId,
			'publish_now',
			'key-race-1',
			{},
			() => new Promise<{ ok: boolean }>((resolve) => (release = () => resolve({ ok: true }))),
			now
		);
		await new Promise((r) => setTimeout(r, 20));
		await expect(
			withIdempotency(db, userId, 'publish_now', 'key-race-1', {}, async () => ({ ok: false }), now)
		).rejects.toMatchObject({ details: { code: 'idempotency_in_progress' } });
		release();
		expect(await slow).toEqual({ ok: true });

		await db.insert(mcpIdempotency).values({
			id: 'stale',
			userId,
			key: 'key-stale-1',
			tool: 'publish_now',
			requestHash: await hashPayload({ tool: 'publish_now', request: {} }),
			responseJson: null,
			createdAt: new Date(now.getTime() - 10 * 60_000),
			expiresAt: new Date(now.getTime() + 3_600_000)
		});
		expect(
			await withIdempotency(
				db,
				userId,
				'publish_now',
				'key-stale-1',
				{},
				async () => ({ ok: 'took over' }),
				now
			)
		).toEqual({ ok: 'took over' });
	});
});
