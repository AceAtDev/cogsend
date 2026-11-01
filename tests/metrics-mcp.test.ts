import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { newId } from '#lib/server/db/client.js';
import { deliveryMetrics, drafts, publishTargets } from '#lib/server/db/schema.js';
import { createMcpHarness, data, text, type McpResult } from './mcp-harness';

const H = 3_600_000;
const D = 24 * H;

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let client: Client;
let ids: { bsky: string; tiktok: string; ig: string; other: string };

async function post(connectionId: string, body: string, publishedAt: number) {
	const draft = newId();
	await h.db.insert(drafts).values({
		id: draft,
		userId: h.user.id,
		baseBody: body,
		status: 'published',
		createdAt: new Date(publishedAt),
		updatedAt: new Date(publishedAt)
	});
	const target = newId();
	await h.db.insert(publishTargets).values({
		id: target,
		draftId: draft,
		connectionId,
		status: 'published',
		remotePostId: `remote-${target}`,
		remoteUrl: `https://example.com/${target}`,
		createdAt: new Date(publishedAt),
		updatedAt: new Date(publishedAt)
	});
	return { draft, target };
}

async function measured(
	targetId: string,
	platform: string,
	counts: Partial<typeof deliveryMetrics.$inferInsert>,
	publishedAt: number
) {
	await h.db.insert(deliveryMetrics).values({
		targetId,
		userId: h.user.id,
		platform,
		publishedAt: new Date(publishedAt),
		state: 'ok',
		stage: 1,
		nextDueAt: new Date(publishedAt + D),
		collectedAt: new Date(publishedAt + H),
		updatedAt: new Date(publishedAt + H),
		...counts
	});
}

const call = async (name: string, args: Record<string, unknown>) =>
	(await client.callTool({ name, arguments: args })) as McpResult;

beforeEach(async () => {
	h = await createMcpHarness({ timezone: 'Europe/Berlin' });
	const jobjob = await h.brand('JobJob', 'jobjob');
	const cal = await h.brand('465cal', '465cal');
	ids = {
		bsky: await h.channel('bluesky', 'jobjob.bsky.social', jobjob),
		tiktok: await h.channel('tiktok', '@cal', cal),
		ig: await h.channel('instagram', 'jobjob_ig', jobjob),
		other: ''
	};
	client = await h.connect(['read']);
});
afterEach(() => h.close());

describe('get_post', () => {
	it('carries the latest metrics of each published delivery, or why there are none', async () => {
		const at = Date.now() - 2 * D;
		const a = await post(ids.bsky, 'bluesky hit', at);
		await measured(a.target, 'bluesky', { likes: 12, shares: 3, comments: 1, quotes: 0 }, at);
		const res = await call('get_post', { postId: a.draft });
		expect(res.isError, text(res)).toBeFalsy();
		const delivery = data(res).post.deliveries[0];
		expect(delivery.metrics).toMatchObject({
			state: 'ok',
			counts: { likes: 12, shares: 3, comments: 1, quotes: 0 },
			engagement: 16
		});
		expect(delivery.metrics.collectedAt.timeZone).toBe('Europe/Berlin');
		expect(text(res)).toContain('12 likes, 3 reposts, 1 replies, 0 quotes');

		const ig = await post(ids.ig, 'insta', at);
		const igRes = await call('get_post', { postId: ig.draft });
		expect(data(igRes).post.deliveries[0].metrics).toMatchObject({
			state: 'unsupported',
			counts: null
		});
		expect(text(igRes)).toMatch(/not collected/);
	});
});

describe('get_performance', () => {
	beforeEach(async () => {
		const at = Date.now() - 3 * D;
		const a = await post(ids.bsky, 'jobjob launch thread', at);
		await measured(a.target, 'bluesky', { likes: 40, shares: 10, comments: 5, quotes: 2 }, at);
		const b = await post(ids.bsky, 'jobjob quiet tip', at + H);
		await measured(b.target, 'bluesky', { likes: 2, shares: 0, comments: 0, quotes: 0 }, at + H);
		const c = await post(ids.tiktok, 'cal dance video', at + 2 * H);
		await measured(c.target, 'tiktok', { views: 5000, likes: 30, comments: 4, shares: 6 }, at);
		await post(ids.ig, 'instagram reel', at);
	});

	it('totals per brand and channel and lists top posts, as a read-only key', async () => {
		const res = await call('get_performance', {});
		expect(res.isError, text(res)).toBeFalsy();
		const out = data(res);
		expect(out.totals).toMatchObject({ posts: 4, measured: 3, engagement: 99 });
		expect(out.top.map((p: { excerpt: string }) => p.excerpt)).toEqual([
			'jobjob launch thread',
			'cal dance video',
			'jobjob quiet tip'
		]);
		expect(out.top[0]).toMatchObject({ channel: 'jobjob.bluesky', brand: 'JobJob' });
		expect(out.brands.map((b: { slug: string }) => b.slug)).toEqual(['jobjob', '465cal']);
		const ig = out.channels.find((c: { platform: string }) => c.platform === 'instagram');
		expect(ig.note).toMatch(/not collected/);
		expect(out.range.from.timeZone).toBe('Europe/Berlin');
		expect(text(res)).toContain('Top by engagement');
	});

	it('filters by brand and channel key and sorts by views', async () => {
		const brand = data(await call('get_performance', { brand: 'jobjob' }));
		expect(brand.totals.posts).toBe(3);
		expect(brand.top.every((p: { brand: string }) => p.brand === 'JobJob')).toBe(true);
		const views = data(
			await call('get_performance', { channels: ['465cal.tiktok'], sort: 'views', limit: 5 })
		);
		expect(views.top).toHaveLength(1);
		expect(views.top[0].counts.views).toBe(5000);
	});

	it('takes a date range in the operator’s zone', async () => {
		const empty = data(await call('get_performance', { from: '2020-01-01', to: '2020-01-31' }));
		expect(empty.totals.posts).toBe(0);
		expect(empty.top).toEqual([]);
		expect(empty.range.from.local).toBe('2020-01-01T00:00:00+01:00');
	});

	it('refuses an unknown brand, a bad channel and a backwards range with the fix', async () => {
		const brand = await call('get_performance', { brand: 'nope' });
		expect(brand.isError).toBe(true);
		expect(text(brand)).toMatch(/No brand "nope"\. Brands: (465cal, jobjob|jobjob, 465cal)/);
		expect(text(brand)).toContain('Example of a valid call');
		const channel = await call('get_performance', { channels: ['jobjob.x'] });
		expect(channel.isError).toBe(true);
		expect(text(channel)).toContain('jobjob.bluesky');
		const range = await call('get_performance', { from: '2026-10-10', to: '2026-10-01' });
		expect(range.isError).toBe(true);
		expect(text(range)).toMatch(/from must be before to/);
	});
});
