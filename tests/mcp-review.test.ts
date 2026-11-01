import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Client } from '@modelcontextprotocol/client';
import { activityLog, brands, publishTargets } from '#lib/server/db/schema.js';
import { actorOf } from '#lib/server/activity.js';
import { approveDeliveries, rejectDeliveries } from '#lib/server/review.js';
import { createMcpHarness, data, inHours, text } from './mcp-harness';

/**
 * Review through the agent's eyes: what it is told when a write is held, how
 * it finds a rejection and its note, and how it answers one. The operator's
 * side (approve, reject) is called directly, as the Review inbox would.
 */

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let agent: Client;
let reviewed: string;
let trusted: string;
const ch: Record<string, string> = {};

const call = (name: string, args: Record<string, unknown>) =>
	agent.callTool({ name, arguments: args });
const operator = actorOf({ authCredential: 'session' });

beforeEach(async () => {
	h = await createMcpHarness();
	reviewed = await h.brand('JobJob', 'jobjob', '#2563eb', { requireApproval: true });
	trusted = await h.brand('465Cal', '465cal', '#16a34a', { requireApproval: false });
	ch.jobjob = await h.channel('mastodon', 'jobjob@mastodon.example', reviewed, {
		instanceUrl: 'https://mastodon.example'
	});
	ch.cal = await h.channel('mastodon', 'cal@mastodon.example', trusted, {
		instanceUrl: 'https://mastodon.example'
	});
	agent = await h.connect();
});

afterEach(async () => {
	await h.close();
});

async function scheduleOn(channel: string, body = 'Hiring a designer') {
	return data(
		await call('schedule_posts', {
			posts: [{ channels: [channel], text: body, runAt: inHours(30) }]
		})
	);
}

describe('MCP review', () => {
	it('says plainly that a write on a reviewed brand is held, and keeps its time', async () => {
		const result = await call('schedule_posts', {
			posts: [{ channels: ['jobjob.mastodon'], text: 'Hiring', runAt: inHours(30) }]
		});
		const out = data(result);
		expect(out).toMatchObject({ status: 'awaiting_review', committed: true, heldForReview: 1 });
		expect(out.posts[0].deliveries[0]).toMatchObject({ status: 'awaiting_review' });
		expect(text(result)).toMatch(/^HELD FOR REVIEW: 1 delivery waits for the operator/);
		expect(text(result)).toContain('Review inbox');
		expect(out.next).toMatch(/do not resend/);
		const [row] = await h.deliveries();
		expect(row.status).toBe('awaiting_review');
		expect(row.scheduledFor!.getTime()).toBeGreaterThan(Date.now());
	});

	it('schedules straight away on a trusted brand', async () => {
		const out = await scheduleOn('465cal.mastodon');
		expect(out).toMatchObject({ status: 'scheduled', heldForReview: 0 });
		expect((await h.deliveries())[0].status).toBe('scheduled');
	});

	it('holds publish_now on a reviewed brand and sends nothing', async () => {
		const draft = data(await call('save_draft', { text: 'Right now please' }));
		const args = { postId: draft.postId, channels: ['jobjob.mastodon'] };
		const preview = data(await call('publish_now', args));
		const result = await call('publish_now', { ...args, confirmToken: preview.confirmToken });
		const out = data(result);
		expect(out).toMatchObject({ status: 'awaiting_review', heldForReview: 1 });
		expect(text(result)).toMatch(/HELD FOR REVIEW/);
		expect(out.next).toMatch(/next scheduler tick/);
		const [row] = await h.deliveries();
		expect(row.status).toBe('awaiting_review');
		expect(row.remotePostId).toBeNull();
		expect(row.attemptCount).toBe(0);
	});

	it('lists held and rejected deliveries by default, and filters by them', async () => {
		await scheduleOn('jobjob.mastodon');
		await scheduleOn('465cal.mastodon', 'Trusted one');
		const all = data(await call('list_posts', {}));
		expect(all.statuses).toEqual(expect.arrayContaining(['awaiting_review', 'rejected']));
		expect(all.posts.map((p: { status: string }) => p.status).sort()).toEqual([
			'awaiting_review',
			'scheduled'
		]);
		const held = data(await call('list_posts', { status: ['awaiting_review'] }));
		expect(held.posts).toHaveLength(1);
		expect(held.posts[0]).toMatchObject({
			channel: 'jobjob.mastodon',
			review: { state: 'waiting', note: null }
		});
	});

	it('shows the reviewer’s note on list_posts and get_post, and resubmits after a revision', async () => {
		const out = await scheduleOn('jobjob.mastodon', 'Buy now!!!');
		const postId = out.posts[0].postIds[0];
		const deliveryId = out.posts[0].deliveries[0].deliveryId;
		await rejectDeliveries(h.db, h.user.id, operator, {
			deliveryIds: [deliveryId],
			note: 'Too pushy; lead with the role.'
		});

		const listed = await call('list_posts', { status: ['rejected'] });
		expect(data(listed).posts[0]).toMatchObject({
			deliveryId,
			status: 'rejected',
			review: { state: 'rejected', note: 'Too pushy; lead with the role.' }
		});
		expect(text(listed)).toContain('Reviewer: Too pushy; lead with the role.');

		const post = await call('get_post', { postId, response_format: 'concise' });
		expect(data(post).post.deliveries[0].review).toMatchObject({
			state: 'rejected',
			note: 'Too pushy; lead with the role.'
		});
		expect(text(post)).toContain('resubmit_for_review');

		// Rescheduling is not how an agent answers a rejection.
		const moved = await call('reschedule_posts', {
			items: [{ deliveryId, runAt: inHours(40) }]
		});
		expect(moved.isError).toBe(true);

		await call('save_draft', { draftId: postId, text: 'We are hiring a product designer.' });
		const again = await call('resubmit_for_review', { items: [{ postId }] });
		expect(again.isError, text(again)).toBeFalsy();
		expect(data(again)).toMatchObject({ status: 'awaiting_review', committed: true });
		expect(data(again).deliveries[0]).toMatchObject({
			deliveryId,
			status: 'awaiting_review',
			review: { state: 'waiting', note: 'Too pushy; lead with the role.' }
		});
		const [row] = await h.deliveries();
		expect(row.status).toBe('awaiting_review');

		const repeat = await call('resubmit_for_review', { items: [{ postId }] });
		expect(repeat.isError).toBeFalsy();
	});

	it('asks for a new time when a rejected delivery’s time has passed', async () => {
		const out = await scheduleOn('jobjob.mastodon');
		const deliveryId = out.posts[0].deliveries[0].deliveryId;
		await rejectDeliveries(h.db, h.user.id, operator, { deliveryIds: [deliveryId] });
		await h.db
			.update(publishTargets)
			.set({ scheduledFor: new Date(Date.now() - 60_000) })
			.where(eq(publishTargets.id, deliveryId));
		const refused = await call('resubmit_for_review', { items: [{ deliveryId }] });
		expect(refused.isError).toBe(true);
		expect(text(refused)).toMatch(/send runAt/);
		const runAt = inHours(10);
		const ok = await call('resubmit_for_review', { items: [{ deliveryId }], runAt });
		expect(ok.isError, text(ok)).toBeFalsy();
		expect((await h.deliveries())[0].scheduledFor!.toISOString()).toBe(runAt);
	});

	it('refuses to resubmit a delivery that is not held or rejected', async () => {
		const out = await scheduleOn('465cal.mastodon');
		const res = await call('resubmit_for_review', {
			items: [{ deliveryId: out.posts[0].deliveries[0].deliveryId }]
		});
		expect(res.isError).toBe(true);
	});

	it('sends an approved post back to review when the agent edits it', async () => {
		const out = await scheduleOn('jobjob.mastodon');
		const postId = out.posts[0].postIds[0];
		await approveDeliveries(h.db, h.user.id, operator, { all: true });
		expect((await h.deliveries())[0].status).toBe('scheduled');
		await call('save_draft', { draftId: postId, text: 'A sneaky late change' });
		expect((await h.deliveries())[0].status).toBe('awaiting_review');
	});

	it('keeps a held delivery held when the agent reschedules it', async () => {
		const out = await scheduleOn('jobjob.mastodon');
		const deliveryId = out.posts[0].deliveries[0].deliveryId;
		const res = data(
			await call('reschedule_posts', { items: [{ deliveryId, runAt: inHours(50) }] })
		);
		expect(res.deliveries[0].status).toBe('awaiting_review');
		expect(res.summary).toContain('still held for review');
	});

	it('tells the agent which brands review and which are paused', async () => {
		await h.db.update(brands).set({ pausedAt: new Date() }).where(eq(brands.id, trusted));
		const out = data(await call('list_channels', {}));
		const bySlug = Object.fromEntries(
			out.brands.map((b: { slug: string }) => [b.slug, b])
		) as Record<string, { requireApproval: boolean; paused: boolean }>;
		expect(bySlug.jobjob).toMatchObject({ requireApproval: true, paused: false });
		expect(bySlug['465cal']).toMatchObject({ requireApproval: false, paused: true });
		expect(out.summary).toContain('PAUSED');
		expect(out.summary).toContain('resubmit_for_review');
	});

	it('logs one activity row per committed write tool call, and none for previews', async () => {
		await call('schedule_posts', {
			posts: [{ channels: ['jobjob.mastodon'], text: 'Preview only', runAt: inHours(30) }],
			dryRun: true
		});
		expect(
			(await h.db.select().from(activityLog)).filter((r) => r.action.startsWith('mcp.'))
		).toEqual([]);
		await scheduleOn('jobjob.mastodon');
		const rows = await h.db.select().from(activityLog);
		const tool = rows.filter((r) => r.action === 'mcp.schedule_posts');
		expect(tool).toHaveLength(1);
		expect(tool[0]).toMatchObject({ actorType: 'api_key', userId: h.user.id });
		expect(tool[0].summary).toMatch(/HELD FOR REVIEW/);
		expect(rows.some((r) => r.action === 'review.held')).toBe(true);
	});
});
