import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { decryptJson, encryptJson } from '#lib/server/crypto.js';
import { newId, parseJson, type AppDb } from '#lib/server/db/client.js';
import { connections, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { connectionAlerts } from '#lib/server/notify/sources.js';
import type { ConnectionCredentials, FetchLike } from '#lib/server/providers/types.js';
import { reconnectDeadline, runTokenUpkeep } from '#lib/server/token-upkeep.js';

const DAY = 24 * 60 * 60_000;

describe('token upkeep', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'upkeep@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());

	async function connect(platform: string, creds: ConnectionCredentials) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId,
			platform,
			handle: `${platform}-${id.slice(0, 4)}`,
			credentialsEncrypted: await encryptJson(creds, TEST_ENV.APP_ENCRYPTION_KEY),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function row(id: string) {
		const [r] = await db.select().from(connections).where(eq(connections.id, id));
		return r;
	}

	it('refreshes an Instagram token that is about to lapse, with no post going out', async () => {
		const now = Date.now();
		const id = await connect('instagram', { accessToken: 'old', expiresAt: now + 3 * DAY });
		const calls: string[] = [];
		const fetchImpl: FetchLike = async (input) => {
			calls.push(String(input));
			return Response.json({ access_token: 'new', expires_in: 60 * 24 * 3600 });
		};
		const result = await runTokenUpkeep(db, TEST_ENV, { fetchImpl, now });
		expect(result.refreshed).toBe(1);
		expect(calls[0]).toContain('refresh_access_token');
		const creds = await decryptJson<ConnectionCredentials>(
			(await row(id)).credentialsEncrypted,
			TEST_ENV.APP_ENCRYPTION_KEY
		);
		expect(creds.accessToken).toBe('new');
		expect(creds.expiresAt).toBeGreaterThan(now + 50 * DAY);
	});

	it('leaves a token with plenty of time alone', async () => {
		const now = Date.now();
		await db.delete(connections);
		await connect('instagram', { accessToken: 'fine', expiresAt: now + 40 * DAY });
		let called = 0;
		const result = await runTokenUpkeep(db, TEST_ENV, {
			fetchImpl: async () => {
				called++;
				return Response.json({});
			},
			now
		});
		expect(result).toEqual({ refreshed: 0, expired: 0, warned: 0 });
		expect(called).toBe(0);
	});

	it('expires the account at once when the platform refuses the refresh', async () => {
		const now = Date.now();
		await db.delete(connections);
		const id = await connect('instagram', { accessToken: 'revoked', expiresAt: now + 2 * DAY });
		const result = await runTokenUpkeep(db, TEST_ENV, {
			fetchImpl: async () =>
				Response.json(
					{
						error: { message: 'Error validating access token', type: 'OAuthException', code: 190 }
					},
					{ status: 400 }
				),
			now
		});
		expect(result.expired).toBe(1);
		expect((await row(id)).status).toBe('expired');
	});

	it('keeps the token through a platform outage and tries again later', async () => {
		const now = Date.now();
		await db.delete(connections);
		const id = await connect('instagram', { accessToken: 'keep', expiresAt: now + 2 * DAY });
		const result = await runTokenUpkeep(db, TEST_ENV, {
			fetchImpl: async () => new Response('down', { status: 503 }),
			now
		});
		expect(result.expired).toBe(0);
		expect((await row(id)).status).toBe('active');
	});

	it('warns a week ahead of a LinkedIn token that cannot be refreshed, once, and alerts', async () => {
		const now = Date.now();
		await db.delete(connections);
		const expiresAt = now + 5 * DAY;
		const id = await connect('linkedin', { accessToken: 'li', expiresAt });
		expect(reconnectDeadline('linkedin', { accessToken: 'li', expiresAt })).toBe(expiresAt);

		const first = await runTokenUpkeep(db, TEST_ENV, { now });
		expect(first.warned).toBe(1);
		const meta = parseJson<Record<string, unknown>>((await row(id)).metaJson, {});
		expect(meta).toMatchObject({ reconnectBy: expiresAt, expiryWarnedAt: now });
		const again = await runTokenUpkeep(db, TEST_ENV, { now: now + 60 * 60_000 });
		expect(again.warned).toBe(0);

		const events = await connectionAlerts.collect(db, {
			users: [{ userId, since: new Date(now - 1000) }],
			now: new Date(now),
			appUrl: 'https://cogsend.example',
			limit: 20
		} as never);
		expect(events).toHaveLength(1);
		expect(events[0].line.text).toMatch(/needs reconnecting by \d{4}-\d{2}-\d{2}/);
	});

	it('warns ahead of the TikTok refresh token end, and clears the warning after a reconnect', async () => {
		const now = Date.now();
		await db.delete(connections);
		const id = await connect('tiktok', {
			accessToken: 'tt',
			refreshToken: 'r',
			expiresAt: now + DAY,
			refreshExpiresAt: now + 3 * DAY
		});
		expect((await runTokenUpkeep(db, TEST_ENV, { now })).warned).toBe(1);
		// Reconnected: a fresh year on the refresh token.
		await db
			.update(connections)
			.set({
				credentialsEncrypted: await encryptJson(
					{
						accessToken: 'tt2',
						refreshToken: 'r2',
						expiresAt: now + DAY,
						refreshExpiresAt: now + 365 * DAY
					},
					TEST_ENV.APP_ENCRYPTION_KEY
				)
			})
			.where(eq(connections.id, id));
		await runTokenUpkeep(db, TEST_ENV, { now });
		const meta = parseJson<Record<string, unknown>>((await row(id)).metaJson, {});
		expect(meta.reconnectBy).toBeUndefined();
	});
});
