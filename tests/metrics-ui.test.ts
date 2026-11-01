import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import { encryptJson } from '#lib/server/crypto.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, deliveryMetrics, drafts, publishTargets } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ENV, type TestDb } from '#lib/server/db/test.js';
import type { SessionUser } from '#lib/server/auth.js';
import * as metricsRoute from '../src/routes/api/targets/[id]/metrics/+server';
import * as performanceRoute from '../src/routes/api/insights/performance/+server';
import * as insightsPage from '../src/routes/insights/+page.server';
import * as postsPage from '../src/routes/posts/+page.server';
import PerformanceSection from '../src/lib/components/insights/PerformanceSection.svelte';
import MetricsPanel from '../src/lib/components/MetricsPanel.svelte';

const H = 3_600_000;

let t: TestDb;
let db: AppDb;
let user: SessionUser;
let target: string;
let fresh: string;

function locals(scopes: string[] | null = null) {
	return {
		db,
		env: TEST_ENV,
		user,
		authMethod: scopes ? 'bearer' : 'session',
		apiKeyScopes: scopes
	};
}

beforeEach(async () => {
	t = await createTestDb();
	db = t.db;
	const row = await createTestAdmin(db, { totpEnabled: true });
	user = {
		id: row.id,
		email: row.email,
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true,
		role: 'admin'
	} as SessionUser;
	const conn = newId();
	const now = Date.now();
	await db.insert(connections).values({
		id: conn,
		userId: user.id,
		platform: 'bluesky',
		handle: 'me.bsky.social',
		credentialsEncrypted: await encryptJson({}, TEST_ENV.APP_ENCRYPTION_KEY),
		metaJson: '{}',
		status: 'active',
		createdAt: new Date(now),
		updatedAt: new Date(now)
	});
	for (const [name, at] of [
		['measured', now - 5 * H],
		['fresh', now - 10 * 60_000]
	] as const) {
		const draft = newId();
		await db.insert(drafts).values({
			id: draft,
			userId: user.id,
			baseBody: `${name} post`,
			status: 'published',
			createdAt: new Date(at),
			updatedAt: new Date(at)
		});
		const id = newId();
		await db.insert(publishTargets).values({
			id,
			draftId: draft,
			connectionId: conn,
			status: 'published',
			remotePostId: `at://did:plc:me/app.bsky.feed.post/${name}`,
			createdAt: new Date(at),
			updatedAt: new Date(at)
		});
		if (name === 'measured') target = id;
		else fresh = id;
	}
	await db.insert(deliveryMetrics).values({
		targetId: target,
		userId: user.id,
		platform: 'bluesky',
		publishedAt: new Date(now - 5 * H),
		state: 'ok',
		stage: 1,
		likes: 21,
		shares: 4,
		comments: 2,
		quotes: 1,
		collectedAt: new Date(now - 60_000),
		updatedAt: new Date(now - 60_000)
	});
});
afterEach(() => t.close());

describe('metrics routes', () => {
	it('GET returns the latest counts and history', async () => {
		const res = await metricsRoute.GET({ params: { id: target }, locals: locals() } as never);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({ state: 'ok', counts: { likes: 21, shares: 4 } });
		expect(Array.isArray(body.snapshots)).toBe(true);
	});

	it('POST refuses a refresh within five minutes and returns what is stored', async () => {
		const res = await metricsRoute.POST({
			params: { id: target },
			locals: locals()
		} as never);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.refreshed).toBe(false);
		expect(body.metrics.counts.likes).toBe(21);
	});

	it('POST needs a write key; GET is fine with read', async () => {
		const read = await metricsRoute.GET({
			params: { id: target },
			locals: locals(['read'])
		} as never);
		expect(read.status).toBe(200);
		const write = await metricsRoute.POST({
			params: { id: target },
			locals: locals(['read'])
		} as never);
		expect(write.status).toBe(403);
	});

	it('the performance endpoint reports the range totals', async () => {
		const res = await performanceRoute.GET({
			locals: locals(),
			url: new URL('https://cogsend.example/api/insights/performance?days=7')
		} as never);
		const body = await res.json();
		expect(body).toMatchObject({ days: 7, totals: { posts: 2, measured: 1, likes: 21 } });
	});
});

describe('page loads', () => {
	it('Insights loads performance alongside the publish history', async () => {
		const loaded = (await insightsPage.load({
			locals: locals(),
			url: new URL('https://cogsend.example/insights?days=30')
		} as never)) as { insights: unknown; performance: { totals: { likes: number } } | null };
		expect(loaded.insights).not.toBeNull();
		expect(loaded.performance?.totals.likes).toBe(21);
	});

	it('Posts carries each published delivery’s metrics', async () => {
		const loaded = (await postsPage.load({ locals: locals() } as never)) as {
			metrics: Record<string, { state: string; counts: Record<string, number> | null }>;
		};
		expect(loaded.metrics[target]).toMatchObject({ state: 'ok', counts: { likes: 21 } });
		expect(loaded.metrics[fresh]).toMatchObject({ state: 'pending', counts: null });
	});
});

describe('rendering', () => {
	it('the Insights section shows totals, channels and top posts', async () => {
		const loaded = (await insightsPage.load({
			locals: locals(),
			url: new URL('https://cogsend.example/insights?days=7')
		} as never)) as { performance: unknown };
		const body = render(PerformanceSection, {
			props: { days: 7, initial: loaded.performance as never }
		}).body;
		expect(body).toContain('data-testid="insights-performance"');
		expect(body).toContain('measured post');
		expect(body).toContain('21 likes · 4 reposts · 2 replies · 1 quotes');
		expect(body).toContain('Instagram, Threads and X');
	});

	it('the Insights section says when there is nothing published', () => {
		const body = render(PerformanceSection, {
			props: {
				days: 30,
				initial: {
					totals: {
						posts: 0,
						measured: 0,
						engagement: 0,
						likes: 0,
						comments: 0,
						shares: 0,
						quotes: 0,
						views: 0,
						impressions: 0,
						clicks: 0
					},
					brands: [],
					channels: [],
					top: []
				}
			}
		}).body;
		expect(body).toContain('No published posts in this range yet.');
	});

	it('the drawer panel renders its loading state on the server', () => {
		const body = render(MetricsPanel, { props: { targetId: target, timeZone: 'UTC' } }).body;
		expect(body).toContain('data-testid="metrics-panel"');
		expect(body).toContain('Loading metrics');
	});
});
