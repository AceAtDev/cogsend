import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	connections,
	draftMedia,
	drafts,
	draftVariants,
	oauthPending,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { decryptJson, encryptSecret } from '#lib/server/crypto.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import { POST as schedulePOST } from '../src/routes/api/drafts/[id]/schedule/+server';
import { POST as publishPOST } from '../src/routes/api/drafts/[id]/publish/+server';
import { buildNormalizedPost } from '#lib/server/publish.js';
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
 * asks; who sees a post, what it allows and whether it is promotional are
 * chosen for each post, with no default, as TikTok's guidelines require.
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

	async function draft(attachment?: { mime: string; durationMs?: number }) {
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
				createdAt: now,
				...(attachment.durationMs
					? { metaJson: JSON.stringify({ durationMs: attachment.durationMs, videoCodec: 'avc' }) }
					: {})
			});
		}
		return id;
	}

	async function schedule(draftId: string, connectionIds: string[], extra: object = {}) {
		const res = (await schedulePOST({
			params: { id: draftId },
			request: new Request(`http://localhost/api/drafts/${draftId}/schedule`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					connectionIds,
					runAt: new Date(Date.now() + 60 * 60_000).toISOString(),
					...extra
				})
			}),
			locals: { db, env: TEST_ENV, media, bindings: {}, waitUntil: () => {}, user: user() }
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	async function publishNow(draftId: string, connectionIds: string[], extra: object = {}) {
		const res = (await publishPOST({
			params: { id: draftId },
			request: new Request(`http://localhost/api/drafts/${draftId}/publish`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ connectionIds, ...extra })
			}),
			locals: { db, env: TEST_ENV, media, bindings: {}, waitUntil: () => {}, user: user() }
		} as never)) as Response;
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	}

	const storedChoices = async (draftId: string) => {
		const [row] = await db.select().from(draftVariants).where(eq(draftVariants.draftId, draftId));
		return row
			? (JSON.parse(row.optionsJson) as { tiktok?: Record<string, unknown> }).tiktok
			: undefined;
	};

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
		expect((await schedule(video, [tiktok], { tiktok: { privacy: 'SELF_ONLY' } })).status).toBe(
			200
		);
	});

	it('refuses a TikTok post whose privacy nobody chose, and never picks one', async () => {
		const tiktok = await account('tiktok');
		const video = await draft({ mime: 'video/mp4' });
		for (const send of [schedule, publishNow]) {
			const res = await send(video, [tiktok]);
			expect(res.status).toBe(400);
			expect(res.body.code).toBe('tiktok_privacy_required');
			expect(res.body.connectionId).toBe(tiktok);
			expect(String(res.body.error)).toContain('Choose who can see this TikTok post');
		}
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.draftId, video))
		).toHaveLength(0);
	});

	it('keeps the choices sent with a schedule on the draft, per account', async () => {
		const a = await account('tiktok');
		const b = await account('tiktok');
		const video = await draft({ mime: 'video/mp4' });
		const res = await schedule(video, [a, b], {
			tiktok: {
				[a]: { privacy: 'PUBLIC_TO_EVERYONE', allowComment: true },
				[b]: { privacy: 'SELF_ONLY', disclose: true, yourBrand: true }
			}
		});
		expect(res.status).toBe(200);
		const stored = await storedChoices(video);
		expect(stored?.[a]).toMatchObject({ privacy: 'PUBLIC_TO_EVERYONE', allowComment: true });
		expect(stored?.[b]).toMatchObject({ privacy: 'SELF_ONLY', yourBrand: true });
		// What publish hands the provider for each account is that account's choice.
		const forA = await buildNormalizedPost(db, video, 'tiktok', a);
		const forB = await buildNormalizedPost(db, video, 'tiktok', b);
		expect(forA.options?.tiktok).toMatchObject({ privacy: 'PUBLIC_TO_EVERYONE', allowDuet: false });
		expect(forB.options?.tiktok).toMatchObject({ privacy: 'SELF_ONLY', disclose: true });
		expect((await buildNormalizedPost(db, video, 'tiktok')).options?.tiktok).toBeUndefined();
	});

	it('holds the choice to what creator_info offered and to the disclosure rules', async () => {
		const tiktok = await account(
			'tiktok',
			JSON.stringify({
				tiktokPrivacyOptions: ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
				tiktokMaxVideoSec: 60
			})
		);
		const video = await draft({ mime: 'video/mp4', durationMs: 30_000 });
		const offered = await schedule(video, [tiktok], { tiktok: { privacy: 'PUBLIC_TO_EVERYONE' } });
		expect(offered.status).toBe(400);
		expect(offered.body.code).toBe('tiktok_options');
		expect(String(offered.body.error)).toContain('does not offer “Everyone”');

		const branded = await schedule(video, [tiktok], {
			tiktok: { privacy: 'SELF_ONLY', disclose: true, brandedContent: true }
		});
		expect(branded.status).toBe(400);
		expect(String(branded.body.error)).toContain(
			'Branded content visibility cannot be set to private.'
		);

		const unlabelled = await schedule(video, [tiktok], {
			tiktok: { privacy: 'FOLLOWER_OF_CREATOR', disclose: true }
		});
		expect(unlabelled.status).toBe(400);
		expect(String(unlabelled.body.error)).toContain(
			'You need to indicate if your content promotes yourself, a third party, or both.'
		);

		const long = await draft({ mime: 'video/mp4', durationMs: 90_000 });
		const tooLong = await schedule(long, [tiktok], { tiktok: { privacy: 'SELF_ONLY' } });
		expect(tooLong.status).toBe(400);
		expect(String(tooLong.body.error)).toContain('up to 1:00, and this one is 1:30');

		expect(
			(
				await schedule(video, [tiktok], {
					tiktok: { privacy: 'FOLLOWER_OF_CREATOR', disclose: true, brandedContent: true }
				})
			).status
		).toBe(200);
	});

	it('refuses TikTok options it does not know, or sent without a TikTok account', async () => {
		const tiktok = await account('tiktok');
		const mastodon = await account('mastodon');
		const video = await draft({ mime: 'video/mp4' });
		expect((await schedule(video, [tiktok], { tiktok: { privacy: 'EVERYONE' } })).status).toBe(400);
		expect(
			(await schedule(video, [tiktok], { tiktok: { privacy: 'SELF_ONLY', autoMusic: true } }))
				.status
		).toBe(400);
		expect((await schedule(video, [mastodon], { tiktok: { privacy: 'SELF_ONLY' } })).status).toBe(
			400
		);
	});

	it('no longer keeps per-account TikTok defaults', async () => {
		const id = await account('tiktok', JSON.stringify({ tiktokOpenId: 'o1' }));
		expect((await patch(id, { tiktok: { privacy: 'MUTUAL_FOLLOW_FRIENDS' } })).status).toBe(400);
		expect(await metaOf(id)).toEqual({ tiktokOpenId: 'o1' });
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

		it('keeps what refresh needs, and a reconnect brings no post defaults', async () => {
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

			const again = await connect('acme_renamed');
			expect(again.location).toContain('connected=tiktok');
			const rows = await db
				.select()
				.from(connections)
				.where(eq(connections.platform, 'tiktok'))
				.then((all) => all.filter((r) => r.id === row.id));
			expect(rows[0].handle).toBe('@acme_renamed');
			const meta = await metaOf(row.id);
			expect(meta).toMatchObject({ tiktokOpenId: 'open-77' });
			expect(meta).not.toHaveProperty('tiktokPrivacy');
		});
	});
});
