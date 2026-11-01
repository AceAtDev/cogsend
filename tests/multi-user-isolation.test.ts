import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';
import { rotateApiKey, verifyApiKey } from '#lib/server/api-keys.js';
import type { SessionUser } from '#lib/server/auth.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	apiKeys,
	brands,
	connections,
	mcpConfirmations,
	mcpIdempotency,
	draftMedia,
	draftShares,
	drafts,
	draftVariants,
	notificationAlerts,
	notificationRecipients,
	notificationSettings,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { addRecipient, saveSettings } from '#lib/server/notify/store.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { createShare } from '#lib/server/draft-shares.js';
import { deleteUserAndData } from '#lib/server/user-data.js';
import { memoryMediaStore } from '#lib/server/media.js';
import { signPublicMediaUrl } from '#lib/server/public-media.js';
import * as draftRoute from '../src/routes/api/drafts/[id]/+server';
import * as draftsRoute from '../src/routes/api/drafts/+server';
import * as duplicateRoute from '../src/routes/api/drafts/[id]/duplicate/+server';
import * as publishRoute from '../src/routes/api/drafts/[id]/publish/+server';
import * as scheduleRoute from '../src/routes/api/drafts/[id]/schedule/+server';
import * as shareRoute from '../src/routes/api/drafts/[id]/share/+server';
import * as variantsRoute from '../src/routes/api/drafts/[id]/variants/+server';
import * as draftMediaRoute from '../src/routes/api/drafts/[id]/media/+server';
import * as coverRoute from '../src/routes/api/drafts/[id]/media/cover/+server';
import * as uploadsRoute from '../src/routes/api/drafts/[id]/media/uploads/+server';
import * as mediaRoute from '../src/routes/api/media/[key]/+server';
import * as publicMediaRoute from '../src/routes/api/media/public/[key]/+server';
import * as sharedMediaRoute from '../src/routes/p/[token]/media/[key]/+server';
import * as connectionsRoute from '../src/routes/api/connections/+server';
import * as connectionRoute from '../src/routes/api/connections/[id]/+server';
import * as creatorInfoRoute from '../src/routes/api/connections/[id]/creator-info/+server';
import * as brandsRoute from '../src/routes/api/brands/+server';
import * as brandRoute from '../src/routes/api/brands/[id]/+server';
import * as calendarPage from '../src/routes/calendar/+page.server';
import * as verifyRoute from '../src/routes/api/connections/[id]/verify/+server';
import * as cancelRoute from '../src/routes/api/targets/[id]/cancel/+server';
import * as retryRoute from '../src/routes/api/targets/[id]/retry/+server';
import * as rescheduleRoute from '../src/routes/api/targets/[id]/reschedule/+server';
import * as bulkRoute from '../src/routes/api/targets/bulk/+server';
import * as queueRoute from '../src/routes/api/queue/+server';
import * as insightsRoute from '../src/routes/api/insights/+server';
import * as keyRoute from '../src/routes/api/key/+server';
import * as mcpRoute from '../src/routes/api/mcp/+server';
import * as settingsRoute from '../src/routes/api/settings/+server';
import * as platformAppsRoute from '../src/routes/api/settings/platform-apps/[platform]/+server';
import * as tickTokenRoute from '../src/routes/api/scheduler/tick-token/+server';
import * as tickNowRoute from '../src/routes/api/scheduler/test/+server';
import * as releaseRoute from '../src/routes/api/release/+server';
import * as updateRoute from '../src/routes/api/update/+server';
import * as updateStepRoute from '../src/routes/api/update/[step]/+server';
import * as unlockRoute from '../src/routes/api/update/unlock/+server';
import * as rememberRoute from '../src/routes/api/update/remember/+server';
import * as adminUsersRoute from '../src/routes/api/admin/users/+server';
import * as adminUserRoute from '../src/routes/api/admin/users/[id]/+server';
import * as adminInvitesRoute from '../src/routes/api/admin/invites/+server';
import * as adminRegistrationRoute from '../src/routes/api/admin/registration/+server';
import * as notificationsRoute from '../src/routes/api/notifications/+server';
import * as notificationRecipientsRoute from '../src/routes/api/notifications/recipients/+server';
import * as notificationRecipientRoute from '../src/routes/api/notifications/recipients/[id]/+server';
import * as notificationTestRoute from '../src/routes/api/notifications/test/+server';

/**
 * Two members on one instance, Alice and Bob. Everything here is Bob reaching
 * for Alice's things through every door a member has: the UI's REST routes,
 * the same routes with a personal API key, MCP, and the public media and
 * preview URLs. Each attempt must fail as if the thing did not exist, and leave
 * Alice's rows exactly as they were. The last block is a member reaching for
 * the admin's controls.
 */

type Handler = (event: never) => Promise<Response> | Response;
type Persona = { user: SessionUser; authMethod: 'session' | 'bearer'; scopes: string[] | null };

let db: AppDb;
let close: () => void;
const media = memoryMediaStore();

let alice: SessionUser;
let bob: SessionUser;
let admin: SessionUser;
const a = {
	draft: '',
	connection: '',
	tiktok: '',
	brand: '',
	target: '',
	mediaKey: '1700000000000-aaaaaaaaaaaaaaaa.jpg',
	mediaId: '',
	shareToken: '',
	apiKey: '',
	recipient: ''
};
const b = {
	draft: '',
	connection: '',
	target: '',
	tiktok: '',
	brand: '',
	mediaKey: '1700000000001-bbbbbbbbbbbbbbbb.jpg',
	shareToken: '',
	apiKey: '',
	recipient: ''
};

function sessionUser(row: { id: string; email: string }, role: 'admin' | 'member'): SessionUser {
	return {
		id: row.id,
		email: row.email,
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true,
		role
	};
}

async function member(email: string) {
	const row = await createTestAdmin(db, { email, totpEnabled: true });
	await db.update(users).set({ role: 'member' }).where(eq(users.id, row.id));
	return sessionUser(row, 'member');
}

async function seed(owner: SessionUser, mediaKey: string) {
	const now = new Date();
	// Both members name a brand "shared": a channel key is only ever read
	// against the caller's own brands, so "shared.mastodon" must never cross.
	const brand = newId();
	await db.insert(brands).values({
		id: brand,
		userId: owner.id,
		name: 'Shared',
		slug: 'shared',
		color: '#2563eb',
		createdAt: now,
		updatedAt: now
	});
	const tiktok = newId();
	await db.insert(connections).values({
		id: tiktok,
		userId: owner.id,
		platform: 'tiktok',
		handle: `${owner.email.split('@')[0]}-tok`,
		credentialsEncrypted: '{}',
		metaJson: JSON.stringify({ tiktokPrivacyOptions: ['SELF_ONLY'] }),
		status: 'active',
		brandId: brand,
		createdAt: now,
		updatedAt: now
	});
	const connection = newId();
	await db.insert(connections).values({
		id: connection,
		userId: owner.id,
		brandId: brand,
		platform: 'mastodon',
		handle: `${owner.email.split('@')[0]}@mastodon.example`,
		instanceUrl: 'https://mastodon.example',
		credentialsEncrypted: '{}',
		metaJson: '{}',
		status: 'active',
		createdAt: now,
		updatedAt: now
	});
	const draft = newId();
	await db.insert(drafts).values({
		id: draft,
		userId: owner.id,
		title: `${owner.email} private draft`,
		baseBody: `secret words of ${owner.email}`,
		status: 'scheduled',
		createdAt: now,
		updatedAt: now
	});
	await db.insert(draftVariants).values({
		id: newId(),
		draftId: draft,
		platform: 'mastodon',
		body: 'variant',
		optionsJson: '{}',
		createdAt: now,
		updatedAt: now
	});
	const mediaId = newId();
	await db.insert(draftMedia).values({
		id: mediaId,
		draftId: draft,
		storageKey: mediaKey,
		mime: 'image/jpeg',
		size: 3,
		createdAt: now
	});
	await media.put(mediaKey, new Uint8Array([1, 2, 3]), 'image/jpeg');
	const target = newId();
	await db.insert(publishTargets).values({
		id: target,
		draftId: draft,
		connectionId: connection,
		status: 'failed',
		scheduledFor: new Date(now.getTime() + 86_400_000),
		createdAt: now,
		updatedAt: now
	});
	const share = await createShare(db, TEST_ENV.APP_ENCRYPTION_KEY, draft, 86_400_000);
	const apiKey = (await rotateApiKey(db, owner.id)).raw;
	const name = owner.email.split('@')[0];
	await saveSettings(db, TEST_ENV, owner.id, {
		senderEmail: `${name}.bot@gmail.com`,
		appPassword: `${name}-app-password-16`
	});
	const recipient = (await addRecipient(db, owner.id, `${name}-team@example.com`, ['failures']))!;
	return {
		recipient: recipient.id,
		connection,
		tiktok,
		brand,
		draft,
		mediaId,
		target,
		shareToken: share.token,
		apiKey
	};
}

function personaOf(user: SessionUser, via: 'session' | 'key' = 'session'): Persona {
	return via === 'session'
		? { user, authMethod: 'session', scopes: null }
		: { user, authMethod: 'bearer', scopes: ['read', 'write'] };
}

async function call(
	handler: Handler,
	persona: Persona | null,
	opts: {
		method?: string;
		params?: Record<string, string>;
		body?: unknown;
		path?: string;
		search?: string;
	} = {}
): Promise<Response> {
	const url = new URL(`https://cogsend.example${opts.path ?? '/api/x'}${opts.search ?? ''}`);
	const request = new Request(url, {
		method: opts.method ?? 'POST',
		headers: { 'content-type': 'application/json' },
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
	});
	const locals = {
		db,
		env: TEST_ENV,
		media,
		queue: null,
		user: persona?.user ?? null,
		authMethod: persona?.authMethod ?? null,
		authCredential:
			persona?.authMethod === 'bearer'
				? 'personal_api_key'
				: persona?.authMethod === 'session'
					? 'session'
					: null,
		apiKeyScopes: persona?.scopes ?? null,
		bindings: {},
		waitUntil: () => {},
		budget: { count: () => {}, remaining: () => 1000, charge: () => {} }
	};
	return handler({
		request,
		locals,
		params: opts.params ?? {},
		url,
		cookies: { get: () => undefined, set() {}, delete() {}, getAll: () => [] },
		platform: undefined,
		setHeaders: () => {}
	} as never);
}

async function aliceSnapshot() {
	const [draft] = await db.select().from(drafts).where(eq(drafts.id, a.draft));
	const [conn] = await db.select().from(connections).where(eq(connections.id, a.connection));
	const [target] = await db.select().from(publishTargets).where(eq(publishTargets.id, a.target));
	const variants = await db.select().from(draftVariants).where(eq(draftVariants.draftId, a.draft));
	const files = await db.select().from(draftMedia).where(eq(draftMedia.draftId, a.draft));
	const shares = await db.select().from(draftShares).where(eq(draftShares.draftId, a.draft));
	const keys = await db.select().from(apiKeys).where(eq(apiKeys.userId, alice.id));
	const ownBrands = await db.select().from(brands).where(eq(brands.userId, alice.id));
	const [tiktok] = await db.select().from(connections).where(eq(connections.id, a.tiktok));
	const notify = {
		settings: await db
			.select()
			.from(notificationSettings)
			.where(eq(notificationSettings.userId, alice.id)),
		recipients: await db
			.select()
			.from(notificationRecipients)
			.where(eq(notificationRecipients.userId, alice.id))
	};
	return JSON.stringify({
		notify,
		draft,
		conn,
		tiktok,
		brands: ownBrands,
		target,
		variants,
		files,
		shares: shares.length,
		keys: keys.map((k) => [k.id, k.revokedAt]),
		bytes: Array.from((await media.get(a.mediaKey)) ?? [])
	});
}

beforeAll(async () => {
	({ db, close } = await createTestDb());
	const owner = await createTestAdmin(db, { email: 'owner@localhost', totpEnabled: true });
	admin = sessionUser(owner, 'admin');
	alice = await member('alice@localhost');
	bob = await member('bob@localhost');
	Object.assign(a, await seed(alice, a.mediaKey));
	Object.assign(b, await seed(bob, b.mediaKey));
});
afterAll(() => close());

describe.each(['session', 'key'] as const)('Bob, signed in by %s, against Alice', (via) => {
	const bobAs = () => personaOf(bob, via);

	it.each([
		[
			'read her draft',
			() => call(draftRoute.GET, bobAs(), { method: 'GET', params: { id: a.draft } })
		],
		[
			'edit her draft',
			() =>
				call(draftRoute.PATCH, bobAs(), {
					method: 'PATCH',
					params: { id: a.draft },
					body: { baseBody: 'pwned' }
				})
		],
		[
			'delete her draft',
			() => call(draftRoute.DELETE, bobAs(), { method: 'DELETE', params: { id: a.draft } })
		],
		[
			'duplicate her draft',
			() => call(duplicateRoute.POST, bobAs(), { params: { id: a.draft }, body: {} })
		],
		[
			'publish her draft',
			() =>
				call(publishRoute.POST, bobAs(), {
					params: { id: a.draft },
					body: { connectionIds: [b.connection] }
				})
		],
		[
			'schedule her draft',
			() =>
				call(scheduleRoute.POST, bobAs(), {
					params: { id: a.draft },
					body: {
						connectionIds: [b.connection],
						runAt: new Date(Date.now() + 3_600_000).toISOString()
					}
				})
		],
		[
			'set a variant on her draft',
			() =>
				call(variantsRoute.PUT, bobAs(), {
					method: 'PUT',
					params: { id: a.draft },
					body: { platform: 'mastodon', body: 'pwned' }
				})
		],
		[
			'delete her variant',
			() =>
				call(variantsRoute.DELETE, bobAs(), {
					method: 'DELETE',
					params: { id: a.draft },
					search: '?platform=mastodon',
					body: { platform: 'mastodon' }
				})
		],
		[
			'read her preview link',
			() => call(shareRoute.GET, bobAs(), { method: 'GET', params: { id: a.draft } })
		],
		[
			'mint a preview link for her draft',
			() => call(shareRoute.POST, bobAs(), { params: { id: a.draft }, body: {} })
		],
		[
			'revoke her preview link',
			() => call(shareRoute.DELETE, bobAs(), { method: 'DELETE', params: { id: a.draft } })
		],
		[
			'edit her media',
			() =>
				call(draftMediaRoute.PATCH, bobAs(), {
					method: 'PATCH',
					params: { id: a.draft },
					body: { mediaId: a.mediaId, altText: 'pwned' }
				})
		],
		[
			'delete her media',
			() =>
				call(draftMediaRoute.DELETE, bobAs(), {
					method: 'DELETE',
					params: { id: a.draft },
					search: `?mediaId=${a.mediaId}`,
					body: { mediaId: a.mediaId }
				})
		],
		[
			'remove her video cover',
			() =>
				call(coverRoute.DELETE, bobAs(), {
					method: 'DELETE',
					params: { id: a.draft },
					search: `?mediaId=${a.mediaId}`,
					body: { mediaId: a.mediaId }
				})
		],
		[
			'start an upload into her draft',
			() =>
				call(uploadsRoute.POST, bobAs(), {
					params: { id: a.draft },
					body: { mime: 'video/mp4', size: 20_000_000, segmentIndex: 0 }
				})
		],
		[
			'read her media file',
			() => call(mediaRoute.GET, bobAs(), { method: 'GET', params: { key: a.mediaKey } })
		],
		[
			'disconnect her account',
			() =>
				call(connectionRoute.DELETE, bobAs(), { method: 'DELETE', params: { id: a.connection } })
		],
		[
			'edit her account',
			() =>
				call(connectionRoute.PATCH, bobAs(), {
					method: 'PATCH',
					params: { id: a.connection },
					body: { label: 'pwned' }
				})
		],
		[
			'verify her account',
			() => call(verifyRoute.POST, bobAs(), { params: { id: a.connection }, body: {} })
		],
		['cancel her delivery', () => call(cancelRoute.POST, bobAs(), { params: { id: a.target } })],
		['retry her delivery', () => call(retryRoute.POST, bobAs(), { params: { id: a.target } })],
		[
			'reschedule her delivery',
			() =>
				call(rescheduleRoute.POST, bobAs(), {
					params: { id: a.target },
					body: { runAt: new Date(Date.now() + 7_200_000).toISOString() }
				})
		]
	])('cannot %s', async (_label, attempt) => {
		const before = await aliceSnapshot();
		const res = await attempt();
		expect(res.status, await res.clone().text()).toBeGreaterThanOrEqual(400);
		expect([400, 401, 403, 404, 409]).toContain(res.status);
		const text = await res.text();
		expect(text).not.toContain('secret words of alice');
		expect(await aliceSnapshot()).toBe(before);
	});

	it('cannot point his own draft at her account', async () => {
		const before = await aliceSnapshot();
		for (const handler of [publishRoute.POST, scheduleRoute.POST]) {
			const res = await call(handler, bobAs(), {
				params: { id: b.draft },
				body: {
					connectionIds: [a.connection],
					runAt: new Date(Date.now() + 3_600_000).toISOString()
				}
			});
			expect(res.status).toBe(400);
			expect((await res.json()).error).toMatch(/connections not found/);
		}
		const targets = await db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.connectionId, a.connection));
		expect(targets.map((t) => t.draftId)).toEqual([a.draft]);
		expect(await aliceSnapshot()).toBe(before);
	});

	it('cannot touch her deliveries in bulk', async () => {
		const before = await aliceSnapshot();
		const res = await call(bulkRoute.POST, bobAs(), {
			body: { action: 'cancel', ids: [a.target] }
		});
		const body = await res.json();
		expect(JSON.stringify(body)).not.toContain('"ok":true,"id":"' + a.target);
		expect(await aliceSnapshot()).toBe(before);
	});

	it('sees only his own drafts, queue, accounts and insights', async () => {
		const lists = await Promise.all([
			call(draftsRoute.GET, bobAs(), { method: 'GET' }),
			call(queueRoute.GET, bobAs(), { method: 'GET' }),
			call(connectionsRoute.GET, bobAs(), { method: 'GET' }),
			call(insightsRoute.GET, bobAs(), { method: 'GET', search: '?days=30' })
		]);
		for (const res of lists) {
			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).not.toContain(a.draft);
			expect(text).not.toContain(a.connection);
			expect(text).not.toContain('alice');
		}
		const drafts = await (await call(draftsRoute.GET, bobAs(), { method: 'GET' })).json();
		expect(JSON.stringify(drafts)).toContain(b.draft);
	});

	it('cannot reach her posts, deliveries or channels through the MCP tools', async () => {
		const before = await aliceSnapshot();
		const bobKey = personaOf(bob, 'key');
		const later = new Date(Date.now() + 3 * 86_400_000).toISOString();
		const choice = {
			privacy: 'SELF_ONLY',
			allowComment: false,
			allowDuet: false,
			allowStitch: false,
			disclose: false
		};
		const attempts: Array<[string, Record<string, unknown>]> = [
			['get_post', { postId: a.draft, response_format: 'detailed' }],
			['validate_post', { draftId: a.draft }],
			['get_platform_requirements', { channels: [a.connection] }],
			['schedule_posts', { posts: [{ channels: [a.connection], text: 'pwned', runAt: later }] }],
			[
				'schedule_posts',
				{ posts: [{ channels: ['shared.mastodon'], draftId: a.draft, runAt: later }] }
			],
			[
				'schedule_posts',
				{ posts: [{ channels: ['shared.tiktok'], draftId: a.draft, runAt: later, tiktok: choice }] }
			],
			['reschedule_posts', { items: [{ deliveryId: a.target, runAt: later }] }],
			['reschedule_posts', { items: [{ postId: a.draft, runAt: later }] }],
			['move_post', { postId: a.draft, to: ['shared.mastodon'], runAt: later }],
			['cancel_posts', { items: [{ deliveryId: a.target }] }],
			['cancel_posts', { items: [{ postId: a.draft }], deletePost: true }],
			['publish_now', { postId: a.draft, channels: ['shared.mastodon'] }],
			['publish_now', { postId: a.draft, channels: [a.connection], dryRun: true }],
			['save_draft', { draftId: a.draft, text: 'pwned' }],
			['save_draft', { draftId: a.draft, channels: ['shared.tiktok'], tiktok: choice }],
			[
				'attach_media',
				{ draftId: a.draft, base64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64') }
			],
			['edit_media', { draftId: a.draft, mediaId: a.mediaId, action: 'remove' }],
			['media_upload', { action: 'start', draftId: a.draft, size: 20_000_000 }]
		];
		for (const [name, args] of attempts) {
			const res = await mcpCall(bobKey, name, args);
			expect(res.result?.isError, `${name}: ${JSON.stringify(res)}`).toBe(true);
			expect(JSON.stringify(res)).not.toContain('secret words of alice');
			// Bob's own refs are echoed back; nothing of Alice's may be.
			expect(JSON.stringify(res)).not.toMatch(/alice@mastodon|alice-tok|alice@localhost/);
		}
		const listed = await mcpCall(bobKey, 'list_posts', { status: ['draft'] });
		expect(JSON.stringify(listed)).not.toContain(a.draft);
		const upcoming = await mcpCall(bobKey, 'list_posts', { status: ['failed', 'scheduled'] });
		expect(JSON.stringify(upcoming)).not.toContain(a.target);
		expect(JSON.stringify(upcoming)).toContain(b.target);
		const channels = await mcpCall(bobKey, 'list_channels', {});
		const text = JSON.stringify(channels);
		expect(text).not.toContain(a.connection);
		expect(text).not.toContain(a.tiktok);
		expect(text).not.toContain('alice');
		expect(text).toContain(b.connection);
		expect(await aliceSnapshot()).toBe(before);
	});

	it('resolves a channel key only among his own accounts, even when the brand slug is hers too', async () => {
		const before = await aliceSnapshot();
		const res = (await mcpCall(personaOf(bob, 'key'), 'schedule_posts', {
			posts: [
				{
					channels: ['shared.mastodon'],
					text: `bob ${via} keyed post`,
					runAt: new Date(Date.now() + 2 * 86_400_000).toISOString()
				}
			]
		})) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> } };
		expect(res.result?.isError, JSON.stringify(res)).toBeFalsy();
		const rows = await db.select().from(publishTargets);
		const made = rows.filter((t) => t.connectionId === a.connection);
		expect(made.map((t) => t.id)).toEqual([a.target]);
		const posted = JSON.stringify(res.result?.structuredContent);
		expect(posted).toContain(b.connection);
		expect(posted).not.toContain(a.connection);
		expect(await aliceSnapshot()).toBe(before);
	});

	it('cannot read, rename, recolour or delete her brands, or file accounts under them', async () => {
		const before = await aliceSnapshot();
		const listed = await call(brandsRoute.GET, bobAs(), { method: 'GET' });
		expect(listed.status).toBe(200);
		const body = await listed.text();
		expect(body).not.toContain(a.brand);
		expect(body).not.toContain(a.connection);
		expect(body).toContain(b.brand);
		for (const attempt of [
			() =>
				call(brandRoute.PATCH, bobAs(), {
					method: 'PATCH',
					params: { id: a.brand },
					body: { name: 'pwned', color: '#000000' }
				}),
			() => call(brandRoute.DELETE, bobAs(), { method: 'DELETE', params: { id: a.brand } }),
			() =>
				call(connectionRoute.PATCH, bobAs(), {
					method: 'PATCH',
					params: { id: b.connection },
					body: { brandId: a.brand }
				}),
			() =>
				call(connectionRoute.PATCH, bobAs(), {
					method: 'PATCH',
					params: { id: a.connection },
					body: { brandId: b.brand }
				})
		]) {
			const res = await attempt();
			expect([400, 401, 403, 404]).toContain(res.status);
		}
		const [own] = await db.select().from(connections).where(eq(connections.id, b.connection));
		expect(own.brandId).toBe(b.brand);
		expect(await aliceSnapshot()).toBe(before);
	});

	it('cannot read or change her notification sender, schedule or recipients', async () => {
		const before = await aliceSnapshot();
		if (via === 'session') {
			const own = await call(notificationsRoute.GET, bobAs(), { method: 'GET' });
			expect(own.status).toBe(200);
			const text = await own.text();
			expect(text).toContain('bob.bot@gmail.com');
			expect(text).toContain('bob-team@example.com');
			expect(text).not.toContain('alice');
			expect(text).not.toContain(a.recipient);
		}
		for (const attempt of [
			() =>
				call(notificationRecipientRoute.PATCH, bobAs(), {
					method: 'PATCH',
					params: { id: a.recipient },
					body: { subscriptions: ['digest'] }
				}),
			() =>
				call(notificationRecipientRoute.DELETE, bobAs(), {
					method: 'DELETE',
					params: { id: a.recipient }
				}),
			// A test email may only go to Bob's own trusted addresses.
			() =>
				call(notificationTestRoute.POST, bobAs(), {
					body: { to: 'alice-team@example.com' }
				})
		]) {
			const res = await attempt();
			expect([400, 401, 403, 404]).toContain(res.status);
		}
		// His own writes land on his own rows only.
		await call(notificationsRoute.PATCH, bobAs(), {
			method: 'PATCH',
			body: {
				digestTime: '06:00',
				senderEmail: 'bob.other@gmail.com',
				appPassword: 'bob-new-pass-16x'
			}
		});
		await call(notificationRecipientsRoute.POST, bobAs(), {
			body: { email: 'alice-team@example.com' }
		});
		expect(await aliceSnapshot()).toBe(before);
	});

	it('cannot read her TikTok creator info', async () => {
		const before = await aliceSnapshot();
		const res = await call(creatorInfoRoute.GET, personaOf(bob), {
			method: 'GET',
			params: { id: a.tiktok }
		});
		expect(res.status).toBe(404);
		expect(await aliceSnapshot()).toBe(before);
	});

	it('sees only his own posts, accounts and brands on the calendar', async () => {
		const event = {
			locals: { db, env: TEST_ENV, user: bob },
			url: new URL('https://cogsend.example/calendar?view=month')
		};
		const loaded = (await calendarPage.load(event as never)) as Record<string, unknown>;
		expect(loaded.loadFailed).toBe(false);
		const text = JSON.stringify(loaded);
		expect(text).not.toContain(a.draft);
		expect(text).not.toContain(a.connection);
		expect(text).not.toContain(a.brand);
		expect(text).not.toContain('secret words of alice');
		expect(text).toContain(b.connection);
	});
});

describe('MCP confirmations and idempotency keys belong to one account', () => {
	it('Bob cannot spend Alice’s confirm token, nor replay her idempotent answer', async () => {
		const runAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
		const aliceArgs = {
			posts: [
				{ channels: ['shared.mastodon'], text: 'alice confirmed post', runAt },
				{ channels: ['shared.mastodon'], text: 'alice second post', runAt }
			]
		};
		const preview = (await mcpCall(personaOf(alice, 'key'), 'schedule_posts', {
			...aliceArgs,
			dryRun: true
		})) as { result?: { isError?: boolean; structuredContent?: { confirmToken?: string } } };
		const token = preview.result?.structuredContent?.confirmToken;
		expect(token, JSON.stringify(preview)).toBeTruthy();
		const before = await db.select().from(publishTargets);
		const stolen = await mcpCall(personaOf(bob, 'key'), 'schedule_posts', {
			...aliceArgs,
			confirmToken: token
		});
		expect(stolen.result?.isError, JSON.stringify(stolen)).toBe(true);
		expect(await db.select().from(publishTargets)).toEqual(before);
		const [row] = await db
			.select()
			.from(mcpConfirmations)
			.where(eq(mcpConfirmations.userId, alice.id));
		expect(row.usedAt).toBeNull();

		const key = 'same-key-for-both-1';
		const hers = (await mcpCall(personaOf(alice, 'key'), 'schedule_posts', {
			posts: [{ channels: ['shared.mastodon'], text: 'alice idempotent', runAt }],
			idempotencyKey: key
		})) as { result?: { isError?: boolean; structuredContent?: unknown } };
		expect(hers.result?.isError, JSON.stringify(hers)).toBeFalsy();
		const his = (await mcpCall(personaOf(bob, 'key'), 'schedule_posts', {
			posts: [{ channels: ['shared.mastodon'], text: 'alice idempotent', runAt }],
			idempotencyKey: key
		})) as { result?: { isError?: boolean; structuredContent?: unknown } };
		expect(his.result?.isError, JSON.stringify(his)).toBeFalsy();
		const answer = JSON.stringify(his.result?.structuredContent);
		expect(answer).toContain(b.connection);
		expect(answer).not.toContain(a.connection);
		const rows = await db.select().from(mcpIdempotency).where(eq(mcpIdempotency.key, key));
		expect(rows.map((r) => r.userId).sort()).toEqual([alice.id, bob.id].sort());
	});
});

async function mcpCall(persona: Persona, name: string, args: Record<string, unknown>) {
	const params = {
		name,
		arguments: args,
		_meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28', [CLIENT_CAPABILITIES_META_KEY]: {} }
	};
	const request = new Request('https://cogsend.example/api/mcp', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			'mcp-method': 'tools/call',
			'mcp-name': name,
			'mcp-protocol-version': '2026-07-28'
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params })
	});
	const res = await mcpRoute.POST({
		request,
		url: new URL(request.url),
		locals: {
			db,
			env: TEST_ENV,
			media,
			queue: null,
			user: persona.user,
			authMethod: persona.authMethod,
			authCredential: 'personal_api_key',
			apiKeyScopes: persona.scopes,
			bindings: {},
			waitUntil: () => {}
		}
	} as never);
	return (await res.json()) as { result?: { isError?: boolean } };
}

describe('the same requests from Alice herself', () => {
	// The control for the refusals above: they fail because of who asks, not
	// because the requests are malformed.
	it('work', async () => {
		const asAlice = personaOf(alice);
		expect(
			(await call(draftRoute.GET, asAlice, { method: 'GET', params: { id: a.draft } })).status
		).toBe(200);
		expect(
			(await call(mediaRoute.GET, asAlice, { method: 'GET', params: { key: a.mediaKey } })).status
		).toBe(200);
		expect(
			(await call(shareRoute.GET, asAlice, { method: 'GET', params: { id: a.draft } })).status
		).toBe(200);
		const edited = await call(draftMediaRoute.PATCH, asAlice, {
			method: 'PATCH',
			params: { id: a.draft },
			body: { mediaId: a.mediaId, altText: 'her own words' }
		});
		expect(edited.status, await edited.clone().text()).toBe(200);
		const patched = await call(draftRoute.PATCH, asAlice, {
			method: 'PATCH',
			params: { id: a.draft },
			body: { baseBody: 'secret words of alice@localhost, edited' }
		});
		expect(patched.status, await patched.clone().text()).toBe(200);
		const cancelled = await call(cancelRoute.POST, asAlice, { params: { id: a.target } });
		expect([200, 409]).toContain(cancelled.status);
	});
});

describe('API keys and links that carry their own authority', () => {
	it('resolve to their own account only', async () => {
		expect((await verifyApiKey(db, a.apiKey))?.userId).toBe(alice.id);
		expect((await verifyApiKey(db, b.apiKey))?.userId).toBe(bob.id);
	});

	it('cannot be managed across accounts: the key routes act on the caller', async () => {
		const before = await aliceSnapshot();
		const shown = await call(keyRoute.GET, personaOf(bob), { method: 'GET' });
		const body = await shown.json();
		expect(body.active.prefix).toBe(b.apiKey.slice(0, body.active.prefix.length));
		const revoked = await call(keyRoute.DELETE, personaOf(bob), { method: 'DELETE' });
		expect(revoked.status).toBe(200);
		expect(await verifyApiKey(db, a.apiKey)).not.toBeNull();
		expect(await aliceSnapshot()).toBe(before);
		b.apiKey = (await rotateApiKey(db, bob.id)).raw;
	});

	it('a preview link opens only the media of the draft it was made for', async () => {
		const own = await call(sharedMediaRoute.GET, null, {
			method: 'GET',
			params: { token: b.shareToken, key: b.mediaKey }
		});
		expect(own.status).toBe(200);
		const theirs = await call(sharedMediaRoute.GET, null, {
			method: 'GET',
			params: { token: b.shareToken, key: a.mediaKey }
		});
		expect(theirs.status).toBe(404);
	});

	it('a signed media URL opens only the object it was signed for', async () => {
		const signed = new URL(
			await signPublicMediaUrl(TEST_ENV.APP_ENCRYPTION_KEY, TEST_ENV.APP_URL, b.mediaKey)
		);
		const own = await call(publicMediaRoute.GET, null, {
			method: 'GET',
			params: { key: b.mediaKey },
			search: signed.search
		});
		expect(own.status).toBe(200);
		const swapped = await call(publicMediaRoute.GET, null, {
			method: 'GET',
			params: { key: a.mediaKey },
			search: signed.search
		});
		expect(swapped.status).toBe(403);
	});
});

describe('a member reaching for the admin controls', () => {
	const asMember = () => personaOf(alice);

	it.each([
		['list users', () => call(adminUsersRoute.GET, asMember(), { method: 'GET' })],
		[
			'suspend another account',
			() =>
				call(adminUserRoute.PATCH, asMember(), {
					method: 'PATCH',
					params: { id: bob.id },
					body: { status: 'suspended' }
				})
		],
		[
			'promote themselves',
			() =>
				call(adminUserRoute.PATCH, asMember(), {
					method: 'PATCH',
					params: { id: alice.id },
					body: { role: 'admin' }
				})
		],
		[
			'delete another account',
			() =>
				call(adminUserRoute.DELETE, asMember(), {
					method: 'DELETE',
					params: { id: bob.id },
					body: { password: 'admin123' }
				})
		],
		['create an invite', () => call(adminInvitesRoute.POST, asMember(), { body: {} })],
		[
			'open sign-up',
			() =>
				call(adminRegistrationRoute.PATCH, asMember(), {
					method: 'PATCH',
					body: { mode: 'open' }
				})
		],
		[
			'rename the instance',
			() =>
				call(settingsRoute.PATCH, asMember(), {
					method: 'PATCH',
					body: { instanceName: 'Mine now' }
				})
		],
		[
			'switch the release channel',
			() =>
				call(settingsRoute.PATCH, asMember(), {
					method: 'PATCH',
					body: { offerPrereleases: true }
				})
		],
		[
			'save platform app credentials',
			() =>
				call(platformAppsRoute.PUT, asMember(), {
					method: 'PUT',
					params: { platform: 'linkedin' },
					body: { LINKEDIN_CLIENT_ID: 'x', LINKEDIN_CLIENT_SECRET: 'y' }
				})
		],
		[
			'remove platform app credentials',
			() =>
				call(platformAppsRoute.DELETE, asMember(), {
					method: 'DELETE',
					params: { platform: 'linkedin' }
				})
		],
		['read the tick token', () => call(tickTokenRoute.GET, asMember(), { method: 'GET' })],
		['mint a tick token', () => call(tickTokenRoute.POST, asMember(), {})],
		['tick every account now', () => call(tickNowRoute.POST, asMember(), {})],
		['check for releases', () => call(releaseRoute.GET, asMember(), { method: 'GET' })],
		['read the updater state', () => call(updateRoute.GET, asMember(), { method: 'GET' })],
		[
			'run an update step',
			() =>
				call(updateStepRoute.POST, asMember(), {
					params: { step: 'target' },
					body: { token: 'x'.repeat(40) }
				})
		],
		[
			'unlock the saved Cloudflare token',
			() => call(unlockRoute.POST, asMember(), { body: { password: 'admin123' } })
		],
		[
			'save a Cloudflare token',
			() =>
				call(rememberRoute.POST, asMember(), {
					body: { token: 'x'.repeat(40), password: 'admin123' }
				})
		],
		[
			'forget the Cloudflare token',
			() => call(rememberRoute.DELETE, asMember(), { method: 'DELETE' })
		]
	])('cannot %s', async (_label, attempt) => {
		const res = await attempt();
		expect(res.status).toBe(403);
	});

	it('can still save their own profile through the settings route', async () => {
		const res = await call(settingsRoute.PATCH, asMember(), {
			method: 'PATCH',
			body: { displayName: 'Alice', timezone: 'Europe/Berlin' }
		});
		expect(res.status).toBe(200);
		const [row] = await db.select().from(users).where(eq(users.id, alice.id));
		expect(row.displayName).toBe('Alice');
		const [ownerRow] = await db.select().from(users).where(eq(users.id, admin.id));
		expect(ownerRow.displayName).toBeNull();
	});

	it('leaves every admin route open to the admin', async () => {
		const res = await call(adminUsersRoute.GET, personaOf(admin), { method: 'GET' });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.users.map((u: { email: string }) => u.email)).toEqual([
			'owner@localhost',
			'alice@localhost',
			'bob@localhost'
		]);
	});
});

describe('deleting an account', () => {
	// Last: it removes Bob for good.
	it('takes his brands and MCP rows with it and leaves Alice’s', async () => {
		const before = await aliceSnapshot();
		const bobRows = async () => ({
			brands: await db.select().from(brands).where(eq(brands.userId, bob.id)),
			confirmations: await db
				.select()
				.from(mcpConfirmations)
				.where(eq(mcpConfirmations.userId, bob.id)),
			keys: await db.select().from(mcpIdempotency).where(eq(mcpIdempotency.userId, bob.id)),
			notify: [
				...(await db
					.select()
					.from(notificationSettings)
					.where(eq(notificationSettings.userId, bob.id))),
				...(await db
					.select()
					.from(notificationRecipients)
					.where(eq(notificationRecipients.userId, bob.id))),
				...(await db.select().from(notificationAlerts).where(eq(notificationAlerts.userId, bob.id)))
			]
		});
		const had = await bobRows();
		expect(had.brands.length).toBeGreaterThan(0);
		expect(had.keys.length).toBeGreaterThan(0);
		expect(had.notify.length).toBeGreaterThan(0);
		expect((await deleteUserAndData(db, media, bob.id)).done).toBe(true);
		expect(await bobRows()).toEqual({ brands: [], confirmations: [], keys: [], notify: [] });
		expect(
			(await db.select().from(mcpIdempotency).where(eq(mcpIdempotency.userId, alice.id))).length
		).toBeGreaterThan(0);
		expect(await aliceSnapshot()).toBe(before);
	});
});
