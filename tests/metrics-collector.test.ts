import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubrequestBudget } from '#lib/server/budget.js';
import { encryptJson, decryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	connections,
	deliveryMetrics,
	deliveryMetricSnapshots,
	drafts,
	draftVariants,
	publishTargets
} from '#lib/server/db/schema.js';
import {
	createTestAdmin,
	createTestDb,
	createTestMedia,
	TEST_ENV,
	type TestDb
} from '#lib/server/db/test.js';
import {
	collectDueMetrics,
	enrollPublished,
	latestMetricsFor,
	loadDeliveryMetrics,
	METRICS_BACKOFF_SETTING,
	refreshDeliveryMetrics
} from '#lib/server/metrics.js';
import { performanceReport, topPosts } from '#lib/server/metrics-report.js';
import { readAppSetting } from '#lib/server/app-settings.js';
import { runSchedulerTick } from '#lib/server/scheduler.js';
import type { FetchLike } from '#lib/server/providers/types.js';
import { TIKTOK_RECONNECT_MESSAGE } from '#lib/domain/metrics.js';

const H = 3_600_000;
const D = 24 * H;

let t: TestDb;
let db: AppDb;
let userId: string;
let calls: string[];

beforeEach(async () => {
	t = await createTestDb();
	db = t.db;
	userId = (await createTestAdmin(db)).id;
	calls = [];
});
afterEach(() => t.close());

async function account(
	platform: string,
	creds: Record<string, unknown> = {},
	extra: Partial<typeof connections.$inferInsert> = {}
) {
	const id = newId();
	const now = new Date();
	await db.insert(connections).values({
		id,
		userId,
		platform,
		handle: `${platform}-handle`,
		credentialsEncrypted: await encryptJson(creds, TEST_ENV.APP_ENCRYPTION_KEY),
		metaJson: '{}',
		status: 'active',
		createdAt: now,
		updatedAt: now,
		...extra
	});
	return id;
}

async function published(
	connectionId: string,
	remotePostId: string,
	publishedAt: number,
	text = 'hello world'
) {
	const draft = newId();
	await db.insert(drafts).values({
		id: draft,
		userId,
		baseBody: text,
		status: 'published',
		createdAt: new Date(publishedAt),
		updatedAt: new Date(publishedAt)
	});
	const id = newId();
	await db.insert(publishTargets).values({
		id,
		draftId: draft,
		connectionId,
		status: 'published',
		remotePostId,
		remoteUrl: `https://example.com/${remotePostId}`,
		createdAt: new Date(publishedAt),
		updatedAt: new Date(publishedAt)
	});
	return { id, draft };
}

async function metricsRow(targetId: string) {
	const [row] = await db
		.select()
		.from(deliveryMetrics)
		.where(eq(deliveryMetrics.targetId, targetId));
	return row;
}

const bskyUri = (n: number) => `at://did:plc:me/app.bsky.feed.post/3k${n}`;

/** Bluesky AppView answering every asked-for post with `likes` likes. */
function bluesky(likes = 5): FetchLike {
	return async (input) => {
		const url = new URL(String(input));
		calls.push(url.hostname);
		const uris = url.searchParams.getAll('uris');
		return Response.json({
			posts: uris.map((uri) => ({
				uri,
				likeCount: likes,
				repostCount: 1,
				replyCount: 0,
				quoteCount: 0
			}))
		});
	};
}

describe('enrolment', () => {
	it('enrols published deliveries of collected platforms inside the window, once', async () => {
		const now = Date.UTC(2026, 9, 31, 12);
		const bsky = await account('bluesky');
		const insta = await account('instagram');
		const recent = await published(bsky, bskyUri(1), now - 2 * H);
		const old = await published(bsky, bskyUri(2), now - 30 * D);
		await published(insta, 'ig1', now - H);
		await enrollPublished(db, now);
		await enrollPublished(db, now);
		const rows = await db.select().from(deliveryMetrics);
		expect(rows.map((r) => r.targetId)).toEqual([recent.id]);
		expect(rows[0]).toMatchObject({
			userId,
			platform: 'bluesky',
			state: 'pending',
			stage: 0
		});
		expect(rows[0].nextDueAt?.getTime()).toBe(now - 2 * H + H);
		expect(old.id).not.toBe(recent.id);
	});
});

describe('the tick metrics pass', () => {
	it('takes the 1h snapshot, stores it with a timestamp and schedules the 24h one', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const bsky = await account('bluesky');
		const target = await published(bsky, bskyUri(1), at);
		const now = at + H + 60_000;
		const result = await collectDueMetrics(db, TEST_ENV, { fetchImpl: bluesky(7), now });
		expect(result).toMatchObject({ read: 1, deferred: 0 });
		const row = await metricsRow(target.id);
		expect(row).toMatchObject({ state: 'ok', likes: 7, shares: 1, stage: 1, failures: 0 });
		expect(row.collectedAt?.getTime()).toBe(now);
		expect(row.nextDueAt?.getTime()).toBe(at + D);
		const snaps = await db.select().from(deliveryMetricSnapshots);
		expect(snaps).toHaveLength(1);
		expect(snaps[0]).toMatchObject({ kind: '1h', likes: 7, userId });

		// Nothing is due again until a day after publishing.
		calls = [];
		await collectDueMetrics(db, TEST_ENV, { fetchImpl: bluesky(9), now: now + 10 * 60_000 });
		expect(calls).toEqual([]);
		await collectDueMetrics(db, TEST_ENV, { fetchImpl: bluesky(9), now: at + D + 60_000 });
		expect(await metricsRow(target.id)).toMatchObject({ likes: 9, stage: 2 });
		expect((await db.select().from(deliveryMetricSnapshots)).map((s) => s.kind).sort()).toEqual([
			'1h',
			'24h'
		]);
	});

	it('reads one account’s posts in one Bluesky call', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const bsky = await account('bluesky');
		for (let i = 0; i < 4; i++) await published(bsky, bskyUri(i), at);
		await collectDueMetrics(db, TEST_ENV, { fetchImpl: bluesky(), now: at + 2 * H });
		expect(calls).toEqual(['public.api.bsky.app']);
		expect((await db.select().from(deliveryMetricSnapshots)).length).toBe(4);
	});

	it('marks a deleted post and stops asking about it, keeping the last counts', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const bsky = await account('bluesky');
		const target = await published(bsky, bskyUri(1), at);
		await collectDueMetrics(db, TEST_ENV, { fetchImpl: bluesky(4), now: at + 2 * H });
		const gone: FetchLike = async () => Response.json({ posts: [] });
		await collectDueMetrics(db, TEST_ENV, { fetchImpl: gone, now: at + D + 60_000 });
		const row = await metricsRow(target.id);
		expect(row).toMatchObject({ state: 'not_found', likes: 4, nextDueAt: null });
	});

	it('pauses a platform that answered 429 for the time it asked, across ticks', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const bsky = await account('bluesky');
		const target = await published(bsky, bskyUri(1), at);
		const limited: FetchLike = async () => {
			calls.push('429');
			return new Response('{}', { status: 429, headers: { 'retry-after': '600' } });
		};
		const now = at + 2 * H;
		const first = await collectDueMetrics(db, TEST_ENV, { fetchImpl: limited, now });
		expect(first.paused).toEqual(['bluesky']);
		expect(await metricsRow(target.id)).toMatchObject({ state: 'rate_limited', failures: 1 });
		expect((await metricsRow(target.id)).nextDueAt?.getTime()).toBe(now + 600_000);
		const backoff = JSON.parse(
			(await readAppSetting(db, METRICS_BACKOFF_SETTING, { fresh: true }))!
		);
		expect(backoff.bluesky).toBe(now + 600_000);

		// Another Bluesky post that is due is left alone while the pause lasts.
		await published(bsky, bskyUri(2), at - H);
		calls = [];
		await collectDueMetrics(db, TEST_ENV, { fetchImpl: limited, now: now + 60_000 });
		expect(calls).toEqual([]);
		// After it, reads resume.
		await collectDueMetrics(db, TEST_ENV, { fetchImpl: bluesky(3), now: now + 11 * 60_000 });
		expect(await metricsRow(target.id)).toMatchObject({ state: 'ok', likes: 3, failures: 0 });
	});

	it('shows "reconnect to enable metrics" for a TikTok account without video.list, and leaves it connected', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const tiktok = await account('tiktok', {
			accessToken: 'tt',
			refreshToken: 'r',
			clientId: 'k',
			clientSecret: 's',
			expiresAt: at + 30 * D,
			scopes: ['user.info.basic', 'video.publish']
		});
		const target = await published(tiktok, '7300000000000000001', at);
		const fetchImpl: FetchLike = async (input) => {
			calls.push(String(input));
			return Response.json({});
		};
		await collectDueMetrics(db, TEST_ENV, { fetchImpl, now: at + 2 * H });
		expect(calls).toEqual([]);
		const row = await metricsRow(target.id);
		expect(row.state).toBe('reconnect');
		expect(row.nextDueAt?.getTime()).toBe(at + 2 * H + D);
		const [conn] = await db.select().from(connections).where(eq(connections.id, tiktok));
		expect(conn.status).toBe('active');
		const view = (await latestMetricsFor(db, userId, [target.id])).get(target.id);
		expect(view?.message).toBe(TIKTOK_RECONNECT_MESSAGE);
	});

	it('refreshes an expiring TikTok token before reading, and stores it', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const now = at + 2 * H;
		const tiktok = await account('tiktok', {
			accessToken: 'old',
			refreshToken: 'r',
			clientId: 'k',
			clientSecret: 's',
			expiresAt: Date.now() + 60_000,
			scopes: ['user.info.basic', 'video.publish', 'video.list']
		});
		const target = await published(tiktok, '7300000000000000001', at);
		const fetchImpl: FetchLike = async (input, init) => {
			const url = String(input);
			calls.push(url);
			if (url.endsWith('/oauth/token/'))
				return Response.json({ access_token: 'new', expires_in: 86400, refresh_token: 'r2' });
			expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new');
			return Response.json({
				data: {
					videos: [
						{
							id: '7300000000000000001',
							view_count: 10,
							like_count: 2,
							comment_count: 1,
							share_count: 0
						}
					]
				},
				error: { code: 'ok' }
			});
		};
		await collectDueMetrics(db, TEST_ENV, { fetchImpl, now });
		expect(await metricsRow(target.id)).toMatchObject({ state: 'ok', views: 10, likes: 2 });
		const [conn] = await db.select().from(connections).where(eq(connections.id, tiktok));
		const creds = await decryptJson<{ accessToken: string }>(
			conn.credentialsEncrypted,
			TEST_ENV.APP_ENCRYPTION_KEY
		);
		expect(creds.accessToken).toBe('new');
	});

	it('records an expired Mastodon token as reconnect without touching the connection', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const masto = await account(
			'mastodon',
			{ accessToken: 'dead', instanceUrl: 'https://mastodon.example' },
			{ instanceUrl: 'https://mastodon.example' }
		);
		const target = await published(masto, '1234', at);
		const fetchImpl: FetchLike = async () =>
			Response.json({ error: 'The access token is invalid' }, { status: 401 });
		await collectDueMetrics(db, TEST_ENV, { fetchImpl, now: at + 2 * H });
		expect((await metricsRow(target.id)).state).toBe('reconnect');
		const [conn] = await db.select().from(connections).where(eq(connections.id, masto));
		expect(conn.status).toBe('active');
	});

	it('marks a LinkedIn personal profile as not available, once', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const li = await account('linkedin', { accessToken: 'li', personUrn: 'urn:li:person:x' });
		const target = await published(li, 'urn:li:share:1', at);
		await collectDueMetrics(db, TEST_ENV, {
			fetchImpl: async () => {
				calls.push('linkedin');
				return Response.json({});
			},
			now: at + 2 * H
		});
		expect(calls).toEqual([]);
		const row = await metricsRow(target.id);
		expect(row).toMatchObject({ state: 'unsupported', nextDueAt: null });
		expect(row.stateDetail).toMatch(/personal profiles/);
	});

	it('stays inside the budget: reads what fits, leaves the rest due, writes what it read', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const masto = await account(
			'mastodon',
			{ accessToken: 'tok', instanceUrl: 'https://mastodon.example' },
			{ instanceUrl: 'https://mastodon.example' }
		);
		const targets = [];
		for (let i = 0; i < 5; i++) targets.push(await published(masto, String(100 + i), at));
		const fetchImpl: FetchLike = async () => {
			calls.push('status');
			return Response.json({ favourites_count: 1, reblogs_count: 0, replies_count: 0 });
		};
		// Count database statements against the same budget, as D1 would.
		const start = t.count();
		const budget = new (class extends SubrequestBudget {
			override get remaining() {
				return this.limit - this.used - (t.count() - start);
			}
		})(11);
		const result = await collectDueMetrics(db, TEST_ENV, { fetchImpl, now: at + 2 * H, budget });
		const spent = budget.used + (t.count() - start);
		expect(spent).toBeLessThanOrEqual(11);
		expect(result.read).toBeGreaterThan(0);
		expect(result.read).toBeLessThan(5);
		expect(result.deferred).toBe(5 - result.read);
		const rows = await Promise.all(targets.map((x) => metricsRow(x.id)));
		expect(rows.filter((r) => r.state === 'ok')).toHaveLength(result.read);
		expect(rows.filter((r) => r.state === 'pending')).toHaveLength(5 - result.read);
	});

	it('does nothing when publishing left too few calls', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const bsky = await account('bluesky');
		await published(bsky, bskyUri(1), at);
		const budget = new SubrequestBudget(50);
		budget.count(45);
		t.reset();
		const result = await collectDueMetrics(db, TEST_ENV, {
			fetchImpl: bluesky(),
			now: at + 2 * H,
			budget
		});
		expect(result.read).toBe(0);
		expect(t.count()).toBe(0);
		expect(calls).toEqual([]);
	});

	it('never breaks the tick, which publishes first', async () => {
		const at = Date.now() - 2 * H;
		const bsky = await account('bluesky');
		await published(bsky, bskyUri(1), at);
		const broken: FetchLike = async () => {
			throw new Error('network down');
		};
		const result = await runSchedulerTick(db, TEST_ENV, {
			store: createTestMedia(),
			fetchImpl: broken as typeof fetch
		});
		expect(result.metrics).toMatchObject({ read: 1 });
		const [row] = await db.select().from(deliveryMetrics);
		expect(row.state).toBe('error');
		expect(row.failures).toBe(1);
	});
});

describe('refresh on demand', () => {
	it('reads now, then refuses again within five minutes', async () => {
		const at = Date.UTC(2026, 9, 31, 9);
		const bsky = await account('bluesky');
		const target = await published(bsky, bskyUri(1), at);
		const now = at + 20 * 60_000;
		const first = await refreshDeliveryMetrics(db, TEST_ENV, userId, target.id, {
			fetchImpl: bluesky(2),
			now
		});
		expect(first.refreshed).toBe(true);
		expect(first.metrics.counts).toMatchObject({ likes: 2 });
		expect(first.metrics.snapshots?.[0].kind).toBe('manual');
		// The scheduled 1h read is still to come.
		expect(first.metrics.nextAt).toBe(at + H);
		const again = await refreshDeliveryMetrics(db, TEST_ENV, userId, target.id, {
			fetchImpl: bluesky(3),
			now: now + 60_000
		});
		expect(again.refreshed).toBe(false);
		expect(again.metrics.counts).toMatchObject({ likes: 2 });
	});

	it('refuses another account’s delivery as not found', async () => {
		const bsky = await account('bluesky');
		const target = await published(bsky, bskyUri(1), Date.now() - H);
		const other = await createTestAdmin(db, { email: 'other@localhost' });
		await expect(
			refreshDeliveryMetrics(db, TEST_ENV, other.id, target.id, { fetchImpl: bluesky() })
		).rejects.toMatchObject({ status: 404 });
		await expect(loadDeliveryMetrics(db, other.id, target.id)).rejects.toMatchObject({
			status: 404
		});
	});

	it('says Instagram is not collected yet', async () => {
		const ig = await account('instagram');
		const target = await published(ig, '1789', Date.now() - H);
		const view = await loadDeliveryMetrics(db, userId, target.id);
		expect(view).toMatchObject({ state: 'unsupported', counts: null });
		expect(view.message).toMatch(/not collected/);
	});
});

describe('performance report', () => {
	it('totals per channel and brand and ranks top posts by engagement', async () => {
		const at = Date.UTC(2026, 9, 20, 9);
		const bsky = await account('bluesky');
		const masto = await account(
			'mastodon',
			{ accessToken: 'tok', instanceUrl: 'https://mastodon.example' },
			{ instanceUrl: 'https://mastodon.example' }
		);
		const quiet = await published(bsky, bskyUri(1), at, 'quiet post');
		const loud = await published(masto, '77', at + H, 'loud post');
		await db.insert(draftVariants).values({
			id: newId(),
			draftId: loud.draft,
			platform: 'mastodon',
			body: 'loud mastodon version',
			optionsJson: '{}',
			createdAt: new Date(),
			updatedAt: new Date()
		});
		await published(bsky, bskyUri(2), at + 2 * H, 'not measured yet');
		const rows = [
			{ targetId: quiet.id, platform: 'bluesky', likes: 1, shares: 0 },
			{ targetId: loud.id, platform: 'mastodon', likes: 30, shares: 5, comments: 2 }
		];
		for (const r of rows)
			await db.insert(deliveryMetrics).values({
				...r,
				userId,
				publishedAt: new Date(at),
				state: 'ok',
				collectedAt: new Date(at + D),
				updatedAt: new Date(at + D)
			});
		const report = await performanceReport(db, userId, {
			from: new Date(at - D),
			to: new Date(at + 3 * D)
		});
		expect(report.totals).toMatchObject({ posts: 3, measured: 2, likes: 31, engagement: 38 });
		expect(report.channels.map((c) => [c.platform, c.posts, c.engagement])).toEqual([
			['mastodon', 1, 37],
			['bluesky', 2, 1]
		]);
		expect(report.brands).toHaveLength(1);
		expect(report.brands[0]).toMatchObject({ name: 'Unbranded', engagement: 38 });
		expect(report.top.map((p) => p.excerpt)).toEqual(['loud mastodon version', 'quiet post']);
		expect(report.top[0].counts).toEqual({ likes: 30, shares: 5, comments: 2 });

		const recent = await topPosts(
			db,
			userId,
			{ from: new Date(at - D), to: new Date(at + 3 * D) },
			{
				sort: 'recent',
				limit: 1
			}
		);
		expect(recent.map((p) => p.deliveryId)).toEqual([loud.id]);
		const none = await topPosts(db, userId, { days: 7, now: new Date(at - 30 * D) });
		expect(none).toEqual([]);
	});

	it('lists only another account’s nothing', async () => {
		const bsky = await account('bluesky');
		await published(bsky, bskyUri(1), Date.now() - H);
		const other = await createTestAdmin(db, { email: 'other2@localhost' });
		const report = await performanceReport(db, other.id, {
			from: new Date(Date.now() - D),
			to: new Date()
		});
		expect(report.totals.posts).toBe(0);
		expect(report.channels).toEqual([]);
	});
});
