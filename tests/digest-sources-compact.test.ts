import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '#lib/server/db/client.js';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '#lib/server/db/test.js';
import {
	connections,
	deliveryMetrics,
	draftMedia,
	draftVariants,
	drafts,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import type { DigestContext } from '#lib/server/notify/events.js';
import {
	needsAction,
	plannedToday,
	topPosts,
	yesterdayResults
} from '#lib/server/notify/sources.js';

let t: TestDb;
let ctx: DigestContext;
let connectionId: string;
const now = new Date('2026-11-06T13:00:00Z');

beforeEach(async () => {
	t = await createTestDb();
	const userId = newId();
	connectionId = newId();
	await t.db.insert(users).values({
		id: userId,
		email: 'compact@localhost',
		passwordHash: 'x',
		createdAt: now,
		updatedAt: now
	});
	await t.db.insert(connections).values({
		id: connectionId,
		userId,
		platform: 'mastodon',
		handle: 'test-account',
		status: 'active',
		credentialsEncrypted: 'x',
		createdAt: now,
		updatedAt: now
	});
	ctx = {
		db: t.db,
		userId,
		now,
		timeZone: 'UTC',
		appUrl: 'https://cogsend.example',
		today: {
			start: new Date('2026-11-06T00:00:00Z'),
			end: new Date('2026-11-07T00:00:00Z'),
			date: '2026-11-06',
			label: 'Friday 6 November'
		},
		yesterday: {
			start: new Date('2026-11-05T00:00:00Z'),
			end: new Date('2026-11-06T00:00:00Z'),
			date: '2026-11-05',
			label: 'Thursday 5 November'
		},
		mediaUrl: vi.fn(async (key) => `https://images.example/${key}`)
	};
});
afterEach(() => t.close());

async function delivery(
	status: string,
	opts: { yesterday?: boolean; inbox?: boolean; likes?: number } = {}
) {
	const draftId = newId();
	const targetId = newId();
	const at = opts.yesterday ? new Date('2026-11-05T12:00:00Z') : now;
	await t.db.insert(drafts).values({
		id: draftId,
		userId: ctx.userId,
		title: 'INTERNAL TITLE',
		baseBody:
			'A public caption with enough words to exceed the sixty character compact card excerpt limit easily.',
		status: 'scheduled',
		createdAt: at,
		updatedAt: at
	});
	await t.db.insert(draftMedia).values({
		id: newId(),
		draftId,
		storageKey: `${draftId}.jpg`,
		mime: 'image/jpeg',
		size: 1,
		createdAt: at
	});
	await t.db.insert(publishTargets).values({
		id: targetId,
		draftId,
		connectionId,
		status,
		scheduledFor: at,
		remotePostId: opts.inbox ? 'v_inbox_example' : status === 'published' ? 'remote' : null,
		createdAt: at,
		updatedAt: at
	});
	if (opts.likes !== undefined)
		await t.db.insert(deliveryMetrics).values({
			targetId,
			userId: ctx.userId,
			platform: 'mastodon',
			publishedAt: at,
			state: 'ok',
			stage: 2,
			likes: opts.likes,
			comments: 0,
			shares: 0,
			collectedAt: at,
			updatedAt: at
		});
	return draftId;
}

describe('compact digest sources', () => {
	it('previews three today cards with full totals and signed thumbnails', async () => {
		for (let i = 0; i < 7; i++) await delivery('scheduled');
		await delivery('awaiting_review');
		const block = (await plannedToday.build(ctx))!;
		const lines = block.groups.flatMap((g) => g.lines);
		expect(plannedToday.cost).toBe(2);
		expect(block).toMatchObject({
			heading: 'Today',
			itemCount: 8,
			scheduledCount: 7,
			summary: '8 posts planned.',
			href: 'https://cogsend.example/posts',
			action: 'View all'
		});
		expect(lines).toHaveLength(3);
		expect(ctx.mediaUrl).toHaveBeenCalledTimes(3);
		for (const line of lines) {
			expect(line.title).toContain('test-account');
			expect(line.title).not.toContain('INTERNAL');
			expect(line.text.length).toBeLessThanOrEqual(60);
			expect(line.image).toMatch(/^https:\/\/images.example\//);
			expect(line.href).toMatch(/^https:\/\/cogsend.example\/compose\?id=/);
			expect(line.badge?.text).toMatch(/^13:00 · (Scheduled|Needs review)$/);
		}
	});

	it('counts all yesterday outcomes, not the limited preview, and separates inbox drafts', async () => {
		for (let i = 0; i < 6; i++) await delivery('published', { yesterday: true });
		for (let i = 0; i < 4; i++) await delivery('failed', { yesterday: true });
		await delivery('published', { yesterday: true, inbox: true });
		const block = (await yesterdayResults.build(ctx))!;
		expect(yesterdayResults.cost).toBe(2);
		expect(block.itemCount).toBe(11);
		expect(block.summary).toBe('6 published · 1 TikTok draft · 4 failed');
		expect(block.groups.flatMap((g) => g.lines)).toHaveLength(3);
	});

	it('labels a TikTok inbox result as a draft and links internally', async () => {
		const id = await delivery('published', { yesterday: true, inbox: true });
		const block = (await yesterdayResults.build(ctx))!;
		expect(block.summary).toBe('1 TikTok draft · 0 failed');
		expect(block.groups[0].lines[0]).toMatchObject({
			badge: { text: 'TikTok draft', tone: 'warn' },
			href: `https://cogsend.example/compose?id=${id}`
		});
	});

	it('omits empty action blocks and bounds populated actions to three rows', async () => {
		expect(await needsAction.build(ctx)).toBeNull();
		for (let i = 0; i < 9; i++) await delivery('failed');
		const block = (await needsAction.build(ctx))!;
		expect(block).toMatchObject({ heading: 'Needs attention', itemCount: 9 });
		expect(block.groups[0].lines).toHaveLength(1);
		expect(block.groups[0].lines[0].text).toBe('9 failed posts to retry');
	});

	it('omits zero engagement and shows only the highest positive performer without zero counts', async () => {
		await delivery('published', { yesterday: true, likes: 0 });
		expect(await topPosts.build(ctx)).toBeNull();
		await delivery('published', { yesterday: true, likes: 2 });
		await delivery('published', { yesterday: true, likes: 8 });
		const block = (await topPosts.build(ctx))!;
		expect(block.groups[0].lines).toHaveLength(1);
		expect(block.groups[0].lines[0].detail).toContain('8 ');
		expect(block.groups[0].lines[0].detail).not.toContain('0 ');
	});

	it('counts all expired accounts and reviews while keeping only three action rows', async () => {
		await delivery('failed');
		await delivery('awaiting_review');
		for (let i = 0; i < 24; i++) {
			await t.db.insert(connections).values({
				id: newId(),
				userId: ctx.userId,
				platform: 'mastodon',
				handle: `fixture-${i}`,
				status: 'expired',
				credentialsEncrypted: 'x',
				createdAt: now,
				updatedAt: now
			});
		}
		const block = (await needsAction.build(ctx))!;
		expect(block.itemCount).toBe(26);
		expect(block.groups[0].lines).toHaveLength(3);
		expect(block.groups[0].lines[2].text).toBe('24 accounts to reconnect');
		expect(block.href).toBeUndefined();
		expect(block.groups[0].lines.map((line) => line.action)).toEqual([
			'Review posts',
			'View failures',
			'Reconnect accounts'
		]);
	});

	it('uses platform captions and preserves empty variants as media-only posts', async () => {
		const todayId = await delivery('scheduled');
		const yesterdayId = await delivery('published', { yesterday: true });
		await t.db.insert(draftVariants).values([
			{
				id: newId(),
				draftId: todayId,
				platform: 'mastodon',
				body: 'Platform-specific caption',
				createdAt: now,
				updatedAt: now
			},
			{
				id: newId(),
				draftId: yesterdayId,
				platform: 'mastodon',
				body: '',
				createdAt: now,
				updatedAt: now
			}
		]);
		const today = (await plannedToday.build(ctx))!;
		const yesterday = (await yesterdayResults.build(ctx))!;
		expect(today.groups[0].lines[0].text).toBe('Platform-specific caption');
		expect(yesterday.groups[0].lines[0].text).toBe('Media-only post');
	});

	it('uses singular platform metric names for one interaction', async () => {
		const id = await delivery('published', { yesterday: true, likes: 1 });
		const [target] = await t.db.select().from(publishTargets).where(eq(publishTargets.draftId, id));
		await t.db
			.update(deliveryMetrics)
			.set({ shares: 1, comments: 1 })
			.where(eq(deliveryMetrics.targetId, target.id));
		const block = (await topPosts.build(ctx))!;
		expect(block.groups[0].lines[0].detail).toBe('1 favourite · 1 boost · 1 reply');
	});
});
