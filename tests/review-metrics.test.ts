import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Client } from '@modelcontextprotocol/client';
import { newId } from '#lib/server/db/client.js';
import { TEST_ENV } from '#lib/server/db/test.js';
import { brands, deliveryMetrics, drafts, publishTargets } from '#lib/server/db/schema.js';
import {
	enrollPublished,
	MetricsRefreshError,
	refreshDeliveryMetrics
} from '#lib/server/metrics.js';
import { performanceReport, topPosts } from '#lib/server/metrics-report.js';
import { createMcpHarness, data, text, type McpResult } from './mcp-harness';

/**
 * Metrics describe what went out, so nothing held back by review or a pause
 * is enrolled, reported, ranked or refreshed: only published deliveries.
 */

const H = 3_600_000;
const D = 24 * H;

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let client: Client;
let reviewed: string;
let paused: string;
const ch: Record<string, string> = {};
const t: Record<string, { draft: string; target: string }> = {};

async function delivery(
	connectionId: string,
	body: string,
	status: string,
	at: number,
	remote = status === 'published'
) {
	const draft = newId();
	await h.db.insert(drafts).values({
		id: draft,
		userId: h.user.id,
		baseBody: body,
		status: status === 'published' ? 'published' : 'scheduled',
		createdAt: new Date(at),
		updatedAt: new Date(at)
	});
	const target = newId();
	await h.db.insert(publishTargets).values({
		id: target,
		draftId: draft,
		connectionId,
		status,
		scheduledFor: new Date(at),
		remotePostId: remote ? `remote-${target}` : null,
		createdAt: new Date(at),
		updatedAt: new Date(at)
	});
	return { draft, target };
}

/** A stray row a status filter has to see past (left over, or written by hand). */
async function measured(targetId: string, at: number, likes: number) {
	await h.db.insert(deliveryMetrics).values({
		targetId,
		userId: h.user.id,
		platform: 'bluesky',
		publishedAt: new Date(at),
		state: 'ok',
		stage: 1,
		likes,
		comments: 0,
		shares: 0,
		quotes: 0,
		collectedAt: new Date(at + H),
		updatedAt: new Date(at + H)
	});
}

const call = async (name: string, args: Record<string, unknown>) =>
	(await client.callTool({ name, arguments: args })) as McpResult;

beforeEach(async () => {
	h = await createMcpHarness({ timezone: 'Europe/Berlin' });
	reviewed = await h.brand('JobJob', 'jobjob', '#2563eb', { requireApproval: true });
	paused = await h.brand('465Cal', '465cal', '#16a34a');
	await h.db.update(brands).set({ pausedAt: new Date() }).where(eq(brands.id, paused));
	ch.jobjob = await h.channel('bluesky', 'jobjob.bsky.social', reviewed);
	ch.cal = await h.channel('bluesky', 'cal.bsky.social', paused);
	const at = Date.now() - 2 * D;
	t.published = await delivery(ch.jobjob, 'went out', 'published', at);
	t.held = await delivery(ch.jobjob, 'waiting for review', 'awaiting_review', at, true);
	t.rejected = await delivery(ch.jobjob, 'rejected by the operator', 'rejected', at, true);
	t.paused = await delivery(ch.cal, 'held by the pause', 'scheduled', at, true);
	await measured(t.published.target, at, 7);
	await measured(t.held.target, at, 900);
	await measured(t.rejected.target, at, 800);
	await measured(t.paused.target, at, 700);
	client = await h.connect(['read']);
});

afterEach(() => h.close());

describe('metrics leave out what review or a pause held back', () => {
	it('enrols only published deliveries for snapshots', async () => {
		await h.db.delete(deliveryMetrics);
		await enrollPublished(h.db, Date.now());
		const rows = await h.db.select().from(deliveryMetrics);
		expect(rows.map((r) => r.targetId)).toEqual([t.published.target]);
	});

	it('reports and ranks only published deliveries', async () => {
		const now = new Date();
		const report = await performanceReport(h.db, h.user.id, {
			from: new Date(now.getTime() - 30 * D),
			to: now
		});
		expect(report.totals).toMatchObject({ posts: 1, measured: 1 });
		expect(report.top.map((p) => p.excerpt)).toEqual(['went out']);
		const top = await topPosts(h.db, h.user.id, { days: 7, now });
		expect(top.map((p) => p.excerpt)).toEqual(['went out']);
		// When it went out, not when its counts were read (an hour later here).
		expect(top[0].collectedAt! - top[0].publishedAt).toBe(H);
	});

	it('answers get_performance and get_post without metrics for held deliveries', async () => {
		const perf = data(await call('get_performance', {}));
		expect(perf.totals.posts).toBe(1);
		expect(perf.top.map((p: { excerpt: string }) => p.excerpt)).toEqual(['went out']);
		for (const key of ['held', 'rejected', 'paused']) {
			const res = await call('get_post', { postId: t[key].draft });
			expect(res.isError, text(res)).toBeFalsy();
			expect(data(res).post.deliveries[0].metrics).toBeUndefined();
		}
		const out = data(await call('get_post', { postId: t.published.draft }));
		expect(out.post.deliveries[0].metrics).toMatchObject({ counts: { likes: 7 } });
	});

	it('refuses to refresh a delivery that has not gone out', async () => {
		for (const key of ['held', 'rejected', 'paused'])
			await expect(
				refreshDeliveryMetrics(h.db, TEST_ENV, h.user.id, t[key].target)
			).rejects.toBeInstanceOf(MetricsRefreshError);
	});
});
