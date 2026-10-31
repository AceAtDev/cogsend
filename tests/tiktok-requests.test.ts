import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	connections,
	draftMedia,
	drafts,
	oauthPending,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { decryptJson, encryptSecret } from '#lib/server/crypto.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import { POST as schedulePOST } from '../src/routes/api/drafts/[id]/schedule/+server';
import { PATCH as connectionPATCH } from '../src/routes/api/connections/[id]/+server';
import { GET as tiktokCallback } from '../src/routes/api/connections/tiktok/callback/+server';

async function redirected(call: () => unknown): Promise<{ status: number; location: string }> {
	try {
		await call();
	} catch (e) {
		const err = e as { status?: number; location?: string };
		if (typeof err?.status === 'number')
			return { status: err.status, location: String(err.location ?? '') };
		throw e;
	}
	throw new Error('expected a redirect');
}

/**
 * TikTok takes one video and nothing else, which is known the moment someone
 * asks; its privacy and interaction settings belong to the account, and a
 * reconnect must not undo what the creator chose.
 */
describe('TikTok requests', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	const media = createTestMedia();

	const user = () => ({
		id: userId,
		email: 'tt@localhost',
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true
	});

	async function account(platform: string, metaJson = '{}') {
		const now = new Date();
		const id = newId();
		await db.insert(connections).values({
			id,
			userId,
			platform,
			handle: `${id}@${platform}.test`,
			credentialsEncrypted: '{}',
			metaJson,
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	async function draft(attachment?: { mime: string }) {
		const now = new Date();
		const id = newId();
		await db.insert(drafts).values({
			id,
			userId,
			baseBody: 'tt probe',
			status: 'draft',
			createdAt: now,
			updatedAt: now
		});
		if (attachment) {
			await db.insert(draftMedia).values({
				id: newId(),
				draftId: id,
				storageKey: `${Date.now()}-0123456789abcdef.${attachment.mime === 'video/mp4' ? 'mp4' : 'jpg'}`,
				mime: attachment.mime,
				size: 1000,
				width: 1080,
				height: 1920,
				createdAt: now
			});
		}
		return id;
	}

	async function schedule(draftId: string, connectionIds: string[]) {
		const res = (await schedulePOST({
			params: { id: draftId },
			request: new Request(`http://localhost/api/drafts/${draftId}/schedule`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					connectionIds,
					runAt: new Date(Date.now() + 60 * 60_000).toISOString()
				})
			}),
			locals: { db, env: TEST_ENV, media, bindings: {}, waitUntil: () => {}, user: user() }
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function patch(id: string, body: unknown) {
		const res = (await connectionPATCH({
			params: { id },
			request: new Request(`http://localhost/api/connections/${id}`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			}),
			locals: { db, env: TEST_ENV, user: user(), authMethod: 'session' }
		} as never)) as Response;
		return {
			status: res.status,
			body: (await res.json()) as { connection?: { metaJson?: unknown }; error?: string }
		};
	}

	const metaOf = async (id: string) =>
		JSON.parse(
			(await db.select().from(connections).where(eq(connections.id, id)))[0].metaJson ?? '{}'
		) as Record<string, unknown>;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'tt@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());
	afterEach(() => vi.unstubAllGlobals());

	it('refuses to schedule a post without a video to TikTok, and queues nothing', async () => {
		const tiktok = await account('tiktok');
		const textOnly = await draft();
		const res = await schedule(textOnly, [tiktok]);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('TikTok: TikTok needs a video');
		expect(res.body.platform).toBe('tiktok');
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.draftId, textOnly))
		).toHaveLength(0);

		const photo = await draft({ mime: 'image/jpeg' });
		expect((await schedule(photo, [tiktok])).body.error).toBe(
			'TikTok: TikTok takes a video, not photos'
		);

		const video = await draft({ mime: 'video/mp4' });
		expect((await schedule(video, [tiktok])).status).toBe(200);
	});

	it('stores the privacy and interaction settings, one at a time', async () => {
		const id = await account('tiktok', JSON.stringify({ tiktokOpenId: 'o1' }));
		expect((await patch(id, { tiktok: { privacy: 'MUTUAL_FOLLOW_FRIENDS' } })).status).toBe(200);
		const res = await patch(id, { tiktok: { allowComment: true } });
		expect(res.status).toBe(200);
		expect(res.body.connection?.metaJson).toMatchObject({
			tiktokPrivacy: 'MUTUAL_FOLLOW_FRIENDS',
			tiktokAllowComment: true
		});
		expect(await metaOf(id)).toEqual({
			tiktokOpenId: 'o1',
			tiktokPrivacy: 'MUTUAL_FOLLOW_FRIENDS',
			tiktokAllowComment: true
		});
	});

	it('refuses settings TikTok does not have, or on another platform', async () => {
		const id = await account('tiktok');
		expect((await patch(id, { tiktok: { privacy: 'EVERYONE' } })).status).toBe(400);
		expect((await patch(id, { tiktok: { allowDuet: 'yes' } })).status).toBe(400);
		expect(await metaOf(id)).toEqual({});
		const mastodon = await account('mastodon');
		expect((await patch(mastodon, { tiktok: { privacy: 'SELF_ONLY' } })).status).toBe(400);
	});

	describe('callback', () => {
		async function connect(username: string) {
			const pendingId = newId();
			await db.insert(oauthPending).values({
				id: pendingId,
				userId,
				instanceUrl: 'tiktok',
				clientId: 'tt-key',
				clientSecretEnc: await encryptSecret('tt-secret', TEST_ENV.APP_ENCRYPTION_KEY),
				expiresAt: new Date(Date.now() + 10 * 60_000),
				createdAt: new Date()
			});
			const state = await bindOAuthState({
				secret: TEST_ENV.AUTH_SECRET!,
				pendingId,
				sessionId: 'sess-tt'
			});
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: unknown) => {
					const url = String(input);
					if (url === 'https://open.tiktokapis.com/v2/oauth/token/')
						return Response.json({
							access_token: 'act.1',
							expires_in: 86400,
							open_id: 'open-77',
							refresh_token: 'rft.1',
							refresh_expires_in: 31536000,
							scope: 'user.info.basic,video.publish',
							token_type: 'Bearer'
						});
					if (url.startsWith('https://open.tiktokapis.com/v2/user/info/'))
						return Response.json({
							data: { user: { open_id: 'open-77', display_name: 'Acme' } },
							error: { code: 'ok' }
						});
					if (url.endsWith('/creator_info/query/'))
						return Response.json({
							data: {
								creator_username: username,
								creator_nickname: 'Acme',
								privacy_level_options: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
								max_video_post_duration_sec: 300
							},
							error: { code: 'ok' }
						});
					return new Response('unmocked', { status: 404 });
				})
			);
			return redirected(() =>
				tiktokCallback({
					url: new URL(
						`http://localhost/api/connections/tiktok/callback?code=C0DE&scopes=user.info.basic%2Cvideo.publish&state=${encodeURIComponent(state)}`
					),
					locals: { db, env: TEST_ENV },
					cookies: { get: () => 'sess-tt' }
				} as never)
			);
		}

		it('keeps what refresh needs, and a reconnect keeps the creator’s choices', async () => {
			const first = await connect('acme');
			expect(first.location).toContain('connected=tiktok');
			const [row] = await db
				.select()
				.from(connections)
				.where(eq(connections.platform, 'tiktok'))
				.then((rows) => rows.filter((r) => r.handle === '@acme'));
			expect(row.displayName).toBe('Acme');
			const creds = await decryptJson<Record<string, unknown>>(
				row.credentialsEncrypted,
				TEST_ENV.APP_ENCRYPTION_KEY
			);
			// TikTok's refresh needs the secret, and the access token lasts a day.
			expect(creds).toMatchObject({
				accessToken: 'act.1',
				refreshToken: 'rft.1',
				clientId: 'tt-key',
				clientSecret: 'tt-secret',
				tiktokOpenId: 'open-77',
				tiktokUsername: 'acme'
			});
			expect(await metaOf(row.id)).toMatchObject({
				tiktokOpenId: 'open-77',
				tiktokPrivacyOptions: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
				tiktokMaxVideoSec: 300
			});

			await patch(row.id, { tiktok: { privacy: 'FOLLOWER_OF_CREATOR', allowDuet: true } });
			const again = await connect('acme_renamed');
			expect(again.location).toContain('connected=tiktok');
			const rows = await db
				.select()
				.from(connections)
				.where(eq(connections.platform, 'tiktok'))
				.then((all) => all.filter((r) => r.id === row.id));
			expect(rows[0].handle).toBe('@acme_renamed');
			expect(await metaOf(row.id)).toMatchObject({
				tiktokPrivacy: 'FOLLOWER_OF_CREATOR',
				tiktokAllowDuet: true,
				tiktokOpenId: 'open-77'
			});
		});
	});
});
