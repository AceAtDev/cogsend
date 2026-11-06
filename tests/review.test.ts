import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	activityLog,
	brands,
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import type { SessionUser } from '#lib/server/auth.js';
import {
	publishDraft,
	rescheduleDelivery,
	retryDelivery,
	scheduleDraft,
	setDraftVariant,
	updateDraft,
	type OperationContext
} from '#lib/server/api/operations.js';
import { claimDueTargets, JANITOR_SETTING, runSchedulerTick } from '#lib/server/scheduler.js';
import { writeAppSetting } from '#lib/server/app-settings.js';
import { publishTarget } from '#lib/server/publish.js';
import {
	approveDeliveries,
	countAwaitingReview,
	loadReviewQueue,
	rejectDeliveries,
	resubmitDeliveries,
	sweepOverdueReviews
} from '#lib/server/review.js';
import { onReviewAlert, type ReviewAlert } from '#lib/server/review-alerts.js';
import { actorOf, listActivity, purgeOldActivity, restActivity } from '#lib/server/activity.js';
import { reviewTiming } from '#lib/domain/review.js';
import { calendarStatus, itemActions } from '#lib/domain/calendar.js';
import * as approveRoute from '../src/routes/api/review/approve/+server';
import * as rejectRoute from '../src/routes/api/review/reject/+server';
import * as reviewRoute from '../src/routes/api/review/+server';
import * as brandRoute from '../src/routes/api/brands/[id]/+server';
import * as activityRoute from '../src/routes/api/activity/+server';

const HOUR = 3_600_000;
const SESSION = { authCredential: 'session' as const };
const AGENT = {
	authCredential: 'personal_api_key' as const,
	apiKey: { id: 'key-1', prefix: 'cog_abc123' }
};

let db: AppDb;
let close: () => void;
let userId: string;
let reviewed: { brand: string; conn: string };
let trusted: { brand: string; conn: string };
let unbranded: string;

/** Records every outbound request, so a test can prove nothing was sent. */
let sent: string[] = [];
const fetchImpl = (async (input: RequestInfo | URL) => {
	sent.push(String(input));
	return new Response('{}', { status: 500 });
}) as typeof fetch;

function ctx(origin: Partial<OperationContext> = SESSION): OperationContext {
	return {
		db,
		env: TEST_ENV,
		media: createTestMedia(),
		waitUntil: () => {},
		...origin
	};
}

async function brand(name: string, requireApproval: boolean) {
	const id = newId();
	const now = new Date();
	await db.insert(brands).values({
		id,
		userId,
		name,
		slug: name.toLowerCase(),
		color: '#2563eb',
		requireApproval,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function account(brandId: string | null, handle: string) {
	const id = newId();
	const now = new Date();
	await db.insert(connections).values({
		id,
		userId,
		platform: 'mastodon',
		handle,
		instanceUrl: 'https://mastodon.example',
		credentialsEncrypted: '{}',
		metaJson: '{}',
		status: 'active',
		brandId,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function draft(text = 'Hello from the agent') {
	const id = newId();
	const now = new Date();
	await db.insert(drafts).values({
		id,
		userId,
		baseBody: text,
		status: 'draft',
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function target(
	draftId: string,
	connectionId: string,
	status: string,
	scheduledFor: Date | null
) {
	const id = newId();
	const now = new Date();
	await db.insert(publishTargets).values({
		id,
		draftId,
		connectionId,
		status,
		scheduledFor,
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function row(id: string) {
	const [t] = await db.select().from(publishTargets).where(eq(publishTargets.id, id));
	return t;
}

async function draftStatus(id: string) {
	const [d] = await db.select().from(drafts).where(eq(drafts.id, id));
	return d.status;
}

beforeEach(async () => {
	({ db, close } = await createTestDb());
	userId = newId();
	const now = new Date();
	await db.insert(users).values({
		id: userId,
		email: 'op@localhost',
		passwordHash: 'x',
		timezone: 'UTC',
		createdAt: now,
		updatedAt: now
	});
	const r = await brand('Reviewed', true);
	reviewed = { brand: r, conn: await account(r, 'rev@mastodon.example') };
	const t = await brand('Trusted', false);
	trusted = { brand: t, conn: await account(t, 'trust@mastodon.example') };
	unbranded = await account(null, 'loose@mastodon.example');
	sent = [];
});
afterEach(() => close());

const later = () => new Date(Date.now() + 2 * HOUR).toISOString();

describe('who is held', () => {
	it('holds an agent’s schedule on a brand that requires review, and reserves its time', async () => {
		const d = await draft();
		const runAt = later();
		const out = await scheduleDraft(ctx(AGENT), userId, d, {
			connectionIds: [reviewed.conn],
			runAt
		});
		expect(out.targets[0].status).toBe('awaiting_review');
		expect(out.targets[0].scheduledFor?.toISOString()).toBe(runAt);
		expect(out.heldForReview).toEqual([out.targets[0].id]);
		expect(await draftStatus(d)).toBe('awaiting_review');
		expect(await countAwaitingReview(db, userId)).toBe(1);
	});

	it('lets a trusted brand’s agent writes straight through', async () => {
		const d = await draft();
		const out = await scheduleDraft(ctx(AGENT), userId, d, {
			connectionIds: [trusted.conn],
			runAt: later()
		});
		expect(out.targets[0].status).toBe('scheduled');
		expect(out.heldForReview).toEqual([]);
	});

	it('always holds an agent’s write to an account in no brand', async () => {
		const d = await draft();
		const out = await scheduleDraft(ctx(AGENT), userId, d, {
			connectionIds: [unbranded],
			runAt: later()
		});
		expect(out.targets[0].status).toBe('awaiting_review');
	});

	it('holds the API_TOKEN like a personal key', async () => {
		const d = await draft();
		const out = await scheduleDraft(ctx({ authCredential: 'api_token' }), userId, d, {
			connectionIds: [reviewed.conn],
			runAt: later()
		});
		expect(out.targets[0].status).toBe('awaiting_review');
	});

	it('never holds the operator’s own writes, on any brand', async () => {
		const d = await draft();
		const out = await scheduleDraft(ctx(SESSION), userId, d, {
			connectionIds: [reviewed.conn, unbranded],
			runAt: later()
		});
		expect(out.targets.map((t) => t.status)).toEqual(['scheduled', 'scheduled']);
	});

	it('splits one agent post across a reviewed and a trusted brand', async () => {
		const d = await draft();
		const out = await scheduleDraft(ctx(AGENT), userId, d, {
			connectionIds: [reviewed.conn, trusted.conn],
			runAt: later()
		});
		const byConn = new Map(out.targets.map((t) => [t.connectionId, t.status]));
		expect(byConn.get(reviewed.conn)).toBe('awaiting_review');
		expect(byConn.get(trusted.conn)).toBe('scheduled');
		expect(await draftStatus(d)).toBe('scheduled');
	});

	it('holds an agent’s publish-now without sending anything, overdue from the start', async () => {
		const d = await draft();
		const out = await publishDraft(ctx(AGENT), userId, d, { connectionIds: [reviewed.conn] });
		expect(out.results[0]).toMatchObject({ status: 'awaiting_review', heldForReview: true });
		const held = await row(out.results[0].targetId);
		expect(held.status).toBe('awaiting_review');
		expect(reviewTiming(held.scheduledFor)).toBe('overdue');
		expect(sent).toEqual([]);
	});

	it('records each hold in the activity log with the key that made it', async () => {
		const d = await draft();
		await scheduleDraft(ctx(AGENT), userId, d, { connectionIds: [reviewed.conn], runAt: later() });
		const { entries } = await listActivity(db, userId, { action: 'review' });
		expect(entries[0]).toMatchObject({
			action: 'review.held',
			targetId: d,
			actor: { type: 'api_key', id: 'key-1', label: 'API key cog_abc123…' },
			after: 'awaiting_review'
		});
	});
});

describe('the scheduler and held or paused posts', () => {
	it('never claims or publishes a held or rejected delivery, even long past its time', async () => {
		const d = await draft();
		const past = new Date(Date.now() - 3 * HOUR);
		const held = await target(d, reviewed.conn, 'awaiting_review', past);
		const rejected = await target(await draft(), reviewed.conn, 'rejected', past);
		const nowHeld = await target(await draft(), reviewed.conn, 'awaiting_review', null);
		expect(await claimDueTargets(db)).toEqual([]);
		// The hourly janitor would read each Mastodon server's limits; not what is tested here.
		await writeAppSetting(db, JANITOR_SETTING, String(Date.now()));
		const tick = await runSchedulerTick(db, TEST_ENV, { store: createTestMedia(), fetchImpl });
		expect(tick.processed).toBe(0);
		expect(sent).toEqual([]);
		expect((await row(held)).status).toBe('awaiting_review');
		expect((await row(rejected)).status).toBe('rejected');
		expect((await row(nowHeld)).status).toBe('awaiting_review');
	});

	it('refuses a direct publish of a held delivery (a queued job or a raced retry)', async () => {
		const held = await target(await draft(), reviewed.conn, 'awaiting_review', new Date());
		const result = await publishTarget(db, TEST_ENV, createTestMedia(), held, {
			fetchImpl,
			mustTry: true
		});
		expect(result).toMatchObject({ status: 'awaiting_review', skipped: true });
		expect((await row(held)).attemptCount).toBe(0);
		expect(sent).toEqual([]);
	});

	it('publishes nothing of a paused brand, holds it rather than failing it, and resumes', async () => {
		const due = await target(
			await draft(),
			trusted.conn,
			'scheduled',
			new Date(Date.now() - 60_000)
		);
		const other = await target(
			await draft(),
			reviewed.conn,
			'scheduled',
			new Date(Date.now() - 60_000)
		);
		await db.update(brands).set({ pausedAt: new Date() }).where(eq(brands.id, trusted.brand));
		const claimed = (await claimDueTargets(db)).map((t) => t.id);
		expect(claimed).toEqual([other]);
		const direct = await publishTarget(db, TEST_ENV, createTestMedia(), due, {
			fetchImpl,
			mustTry: true
		});
		expect(direct.skipped).toBe(true);
		expect(await row(due)).toMatchObject({ status: 'scheduled', attemptCount: 0 });
		await db.update(brands).set({ pausedAt: null }).where(eq(brands.id, trusted.brand));
		expect((await claimDueTargets(db)).map((t) => t.id).sort()).toEqual([due, other].sort());
	});

	it('refuses the operator’s publish-now and retry on a paused brand with the reason', async () => {
		await db.update(brands).set({ pausedAt: new Date() }).where(eq(brands.id, trusted.brand));
		const d = await draft();
		await expect(
			publishDraft(ctx(), userId, d, { connectionIds: [trusted.conn] })
		).rejects.toMatchObject({
			status: 409,
			details: { code: 'brand_paused', pausedBrands: ['Trusted'] }
		});
		const failed = await target(d, trusted.conn, 'failed', null);
		await expect(retryDelivery(ctx(), userId, failed)).rejects.toMatchObject({ status: 409 });
		expect(sent).toEqual([]);
	});

	it('flags an overdue held delivery once, alerts once per user, and logs it', async () => {
		const alerts: ReviewAlert[] = [];
		const off = onReviewAlert((alert) => {
			alerts.push(alert);
		});
		try {
			const d = await draft('Overdue words');
			const held = await target(d, reviewed.conn, 'awaiting_review', new Date(Date.now() - 60_000));
			await target(await draft(), reviewed.conn, 'awaiting_review', new Date(Date.now() + HOUR));
			const first = await sweepOverdueReviews(db, TEST_ENV);
			expect(first).toHaveLength(1);
			expect(alerts).toHaveLength(1);
			expect(alerts[0]).toMatchObject({ kind: 'review_overdue', userId });
			expect(alerts[0].items).toEqual([
				expect.objectContaining({
					deliveryId: held,
					postId: d,
					brandName: 'Reviewed',
					platform: 'mastodon',
					excerpt: 'Overdue words'
				})
			]);
			expect((await row(held)).reviewOverdueAt).toBeInstanceOf(Date);
			expect((await row(held)).status).toBe('awaiting_review');
			expect(await sweepOverdueReviews(db, TEST_ENV)).toEqual([]);
			expect(alerts).toHaveLength(1);
			const { entries } = await listActivity(db, userId, { action: 'review.overdue' });
			expect(entries).toHaveLength(1);
			expect(entries[0].actor.type).toBe('system');
		} finally {
			off();
		}
	});

	it('runs the overdue sweep on every tick', async () => {
		const held = await target(
			await draft(),
			reviewed.conn,
			'awaiting_review',
			new Date(Date.now() - 1)
		);
		const tick = await runSchedulerTick(db, TEST_ENV, { store: createTestMedia(), fetchImpl });
		expect(tick.reviewAlerts).toBe(1);
		expect((await row(held)).reviewOverdueAt).not.toBeNull();
	});

	it('sends an overdue delivery on the next tick once approved', async () => {
		const held = await target(
			await draft(),
			reviewed.conn,
			'awaiting_review',
			new Date(Date.now() - HOUR)
		);
		await approveDeliveries(db, userId, actorOf(SESSION), { deliveryIds: [held] });
		expect(await row(held)).toMatchObject({ status: 'scheduled', reviewOverdueAt: null });
		expect((await claimDueTargets(db)).map((t) => t.id)).toEqual([held]);
	});

	it('gives a held publish-now a time when approved, so the tick can claim it', async () => {
		const held = await target(await draft(), reviewed.conn, 'awaiting_review', null);
		await approveDeliveries(db, userId, actorOf(SESSION), { deliveryIds: [held] });
		expect((await row(held)).scheduledFor).toBeInstanceOf(Date);
		expect((await claimDueTargets(db)).map((t) => t.id)).toEqual([held]);
	});
});

describe('approving and rejecting', () => {
	it('approves by ids, by brand, or everything, leaving other users’ rows alone', async () => {
		const otherUser = newId();
		const now = new Date();
		await db.insert(users).values({
			id: otherUser,
			email: 'other@localhost',
			passwordHash: 'x',
			createdAt: now,
			updatedAt: now
		});
		const otherConn = newId();
		await db.insert(connections).values({
			id: otherConn,
			userId: otherUser,
			platform: 'mastodon',
			credentialsEncrypted: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		const otherDraft = newId();
		await db
			.insert(drafts)
			.values({ id: otherDraft, userId: otherUser, createdAt: now, updatedAt: now });
		const foreign = await target(
			otherDraft,
			otherConn,
			'awaiting_review',
			new Date(Date.now() + HOUR)
		);

		const a1 = await target(
			await draft(),
			reviewed.conn,
			'awaiting_review',
			new Date(Date.now() + HOUR)
		);
		const a2 = await target(
			await draft(),
			reviewed.conn,
			'awaiting_review',
			new Date(Date.now() + HOUR)
		);
		const u1 = await target(
			await draft(),
			unbranded,
			'awaiting_review',
			new Date(Date.now() + HOUR)
		);
		const u2 = await target(
			await draft(),
			unbranded,
			'awaiting_review',
			new Date(Date.now() + HOUR)
		);

		const byIds = await approveDeliveries(db, userId, actorOf(SESSION), {
			deliveryIds: [a1, foreign]
		});
		expect(byIds.approved).toEqual([a1]);
		const byBrand = await approveDeliveries(db, userId, actorOf(SESSION), {
			brandId: 'unbranded'
		});
		expect(byBrand.approved.sort()).toEqual([u1, u2].sort());
		const all = await approveDeliveries(db, userId, actorOf(SESSION), { all: true });
		expect(all.approved).toEqual([a2]);
		expect((await row(foreign)).status).toBe('awaiting_review');
		expect(await countAwaitingReview(db, userId)).toBe(0);
		const { entries } = await listActivity(db, userId, { action: 'review.approve' });
		expect(entries).toHaveLength(4);
	});

	it('approves at a new time when asked, and refuses a past one', async () => {
		const held = await target(
			await draft(),
			reviewed.conn,
			'awaiting_review',
			new Date(Date.now() + HOUR)
		);
		const runAt = new Date(Date.now() + 5 * HOUR).toISOString();
		await approveDeliveries(db, userId, actorOf(SESSION), { deliveryIds: [held], runAt });
		expect((await row(held)).scheduledFor?.toISOString()).toBe(runAt);
		await expect(
			approveDeliveries(db, userId, actorOf(SESSION), {
				deliveryIds: [held],
				runAt: new Date(Date.now() - HOUR).toISOString()
			})
		).rejects.toMatchObject({ status: 400 });
	});

	it('rejects with a note the agent reads, then a resubmit holds it again', async () => {
		const d = await draft();
		const held = await target(d, reviewed.conn, 'awaiting_review', new Date(Date.now() + HOUR));
		const out = await rejectDeliveries(db, userId, actorOf(SESSION), {
			deliveryIds: [held],
			note: '  Lead with the job title.  '
		});
		expect(out).toMatchObject({ rejected: [held], note: 'Lead with the job title.' });
		expect(await row(held)).toMatchObject({
			status: 'rejected',
			reviewNote: 'Lead with the job title.'
		});
		expect(await draftStatus(d)).toBe('draft');
		const queue = await loadReviewQueue(db, userId);
		expect(queue.counts).toMatchObject({ waiting: 0, rejected: 1 });
		await resubmitDeliveries(db, userId, actorOf(AGENT), [held], null);
		expect(await row(held)).toMatchObject({
			status: 'awaiting_review',
			reviewNote: 'Lead with the job title.'
		});
	});

	it('refuses a note that is too long', async () => {
		const held = await target(
			await draft(),
			reviewed.conn,
			'awaiting_review',
			new Date(Date.now() + HOUR)
		);
		await expect(
			rejectDeliveries(db, userId, actorOf(SESSION), {
				deliveryIds: [held],
				note: 'x'.repeat(2001)
			})
		).rejects.toMatchObject({ status: 400 });
		expect((await row(held)).status).toBe('awaiting_review');
	});

	it('groups the inbox by brand, one card per post, with each channel’s own text', async () => {
		const d = await draft('Base text');
		await target(d, reviewed.conn, 'awaiting_review', new Date(Date.now() + HOUR));
		await target(d, unbranded, 'awaiting_review', new Date(Date.now() + 2 * HOUR));
		await setDraftVariant(ctx(), userId, d, { platform: 'mastodon', body: 'Toot text' });
		const queue = await loadReviewQueue(db, userId);
		expect(queue.groups.map((g) => g.brand.name)).toEqual(['Reviewed', 'Unbranded']);
		expect(queue.groups[0].cards).toHaveLength(1);
		expect(queue.groups[0].cards[0]).toMatchObject({
			postId: d,
			text: 'Base text',
			timing: 'waiting'
		});
		expect(queue.groups[0].cards[0].deliveries[0]).toMatchObject({
			channelKey: 'reviewed.mastodon',
			text: 'Toot text'
		});
		expect(queue.counts.waiting).toBe(2);
	});

	it('previews the public TikTok title for the selected account, not its internal label', async () => {
		await db
			.update(connections)
			.set({ platform: 'tiktok', displayName: 'Photo account' })
			.where(eq(connections.id, reviewed.conn));
		const d = await draft('Base caption');
		const photoId = newId();
		await db.insert(draftMedia).values({
			id: photoId,
			draftId: d,
			storageKey: 'title-photo.jpg',
			mime: 'image/jpeg',
			size: 10,
			createdAt: new Date()
		});
		await target(d, reviewed.conn, 'awaiting_review', new Date(Date.now() + HOUR));
		await db.insert(draftVariants).values({
			id: newId(),
			draftId: d,
			platform: 'tiktok',
			body: '',
			optionsJson: JSON.stringify({
				tiktok: {
					[reviewed.conn]: { draft: true, title: 'Photo headline' },
					another: { draft: true, title: 'Wrong account' }
				}
			}),
			createdAt: new Date(),
			updatedAt: new Date()
		});
		const queue = await loadReviewQueue(db, userId);
		expect(queue.groups[0].cards[0].deliveries[0]).toMatchObject({
			text: '',
			previewTitle: 'Photo headline',
			displayName: 'Photo account'
		});
		await db
			.update(draftMedia)
			.set({ mime: 'video/mp4', storageKey: 'replacement.mp4' })
			.where(eq(draftMedia.id, photoId));
		const replaced = await loadReviewQueue(db, userId);
		expect(replaced.groups[0].cards[0].deliveries[0].previewTitle).toBeNull();
	});

	it('keeps two TikTok account titles distinct and loading never approves a held delivery', async () => {
		const second = await account(reviewed.brand, 'second');
		for (const conn of [reviewed.conn, second])
			await db.update(connections).set({ platform: 'tiktok' }).where(eq(connections.id, conn));
		const d = await draft('Base caption');
		await db.insert(draftMedia).values({
			id: newId(),
			draftId: d,
			storageKey: 'title-photo.jpg',
			mime: 'image/jpeg',
			size: 10,
			createdAt: new Date()
		});
		await db.update(drafts).set({ title: 'Internal calendar label' }).where(eq(drafts.id, d));
		const held = await Promise.all(
			[reviewed.conn, second].map((conn) =>
				target(d, conn, 'awaiting_review', new Date(Date.now() + HOUR))
			)
		);
		await db.insert(draftVariants).values({
			id: newId(),
			draftId: d,
			platform: 'tiktok',
			body: 'Public caption',
			optionsJson: JSON.stringify({
				tiktok: {
					[reviewed.conn]: { draft: true, title: 'First account title' },
					[second]: { draft: true, title: 'Second account title' }
				}
			}),
			createdAt: new Date(),
			updatedAt: new Date()
		});
		const queue = await loadReviewQueue(db, userId);
		const deliveries = queue.groups[0].cards[0].deliveries;
		expect(deliveries.find((v) => v.connectionId === reviewed.conn)).toMatchObject({
			text: 'Public caption',
			previewTitle: 'First account title'
		});
		expect(deliveries.find((v) => v.connectionId === second)).toMatchObject({
			text: 'Public caption',
			previewTitle: 'Second account title'
		});
		expect(queue.counts.waiting).toBe(2);
		for (const id of held)
			expect(await row(id)).toMatchObject({
				status: 'awaiting_review',
				reviewedAt: null,
				jobId: null,
				remotePostId: null
			});
		expect(sent).toEqual([]);
	});

	it.each([false, true])(
		'preserves per-delivery thread segments and ordered media (explicit=%s)',
		async (explicit) => {
			const d = await draft('Base caption');
			const held = await target(d, reviewed.conn, 'awaiting_review', new Date(Date.now() + HOUR));
			await db.insert(draftVariants).values({
				id: newId(),
				draftId: d,
				platform: 'mastodon',
				body: 'First post\n---\nSecond post',
				optionsJson: JSON.stringify(
					explicit ? { threadSegments: ['First post', 'Second post'] } : {}
				),
				createdAt: new Date(),
				updatedAt: new Date()
			});
			await db.insert(draftMedia).values([
				{
					id: newId(),
					draftId: d,
					storageKey: 'u/second.jpg',
					mime: 'image/jpeg',
					size: 10,
					segmentIndex: 1,
					sortOrder: 0,
					createdAt: new Date()
				},
				{
					id: newId(),
					draftId: d,
					storageKey: 'u/first-b.jpg',
					mime: 'image/jpeg',
					size: 10,
					segmentIndex: 0,
					sortOrder: 2,
					createdAt: new Date()
				},
				{
					id: newId(),
					draftId: d,
					storageKey: 'u/first-a.jpg',
					mime: 'image/jpeg',
					size: 10,
					segmentIndex: 0,
					sortOrder: 1,
					createdAt: new Date()
				}
			]);
			const queue = await loadReviewQueue(db, userId);
			const card = queue.groups[0].cards[0];
			expect(card.deliveries[0].previewSegments).toEqual(['First post', 'Second post']);
			expect(card.deliveries[0].previewSegmentIndices).toEqual([0, 1]);
			expect(card.media.map((m) => [m.storageKey, m.segmentIndex])).toEqual([
				['u/first-a.jpg', 0],
				['u/first-b.jpg', 0],
				['u/second.jpg', 1]
			]);
			expect((await row(held)).status).toBe('awaiting_review');
			expect(sent).toEqual([]);
		}
	);
});

describe('agent changes after approval', () => {
	it('sends an approved post back to review when an agent edits its text, not when the operator does', async () => {
		const d = await draft();
		const t = await target(d, reviewed.conn, 'scheduled', new Date(Date.now() + HOUR));
		const tr = await target(d, trusted.conn, 'scheduled', new Date(Date.now() + HOUR));
		await updateDraft(ctx(SESSION), userId, d, { baseBody: 'Operator tweak' });
		expect((await row(t)).status).toBe('scheduled');
		await updateDraft(ctx(AGENT), userId, d, { baseBody: 'Agent rewrite' });
		expect((await row(t)).status).toBe('awaiting_review');
		expect((await row(tr)).status).toBe('scheduled');
		const { entries } = await listActivity(db, userId, { action: 'review.held' });
		expect(entries[0].summary).toMatch(/edited/);
	});

	it('sends it back on an agent’s platform-version edit too', async () => {
		const d = await draft();
		const t = await target(d, reviewed.conn, 'scheduled', new Date(Date.now() + HOUR));
		await setDraftVariant(ctx(AGENT), userId, d, { platform: 'mastodon', body: 'New toot' });
		expect((await row(t)).status).toBe('awaiting_review');
	});

	it('keeps a held delivery held when an agent moves its time, and approves it when the operator does', async () => {
		const d = await draft();
		const t = await target(d, reviewed.conn, 'awaiting_review', new Date(Date.now() - HOUR));
		await db
			.update(publishTargets)
			.set({ reviewOverdueAt: new Date() })
			.where(eq(publishTargets.id, t));
		const out = await rescheduleDelivery(ctx(AGENT), userId, t, { runAt: later() });
		expect(out.status).toBe('awaiting_review');
		expect(await row(t)).toMatchObject({ status: 'awaiting_review', reviewOverdueAt: null });
		const human = await rescheduleDelivery(ctx(SESSION), userId, t, { runAt: later() });
		expect(human.status).toBe('scheduled');
	});

	it('refuses to reschedule a rejected delivery', async () => {
		const t = await target(await draft(), reviewed.conn, 'rejected', new Date(Date.now() + HOUR));
		await expect(
			rescheduleDelivery(ctx(AGENT), userId, t, { runAt: later() })
		).rejects.toMatchObject({
			status: 409
		});
	});

	it('holds an agent’s retry of a cancelled delivery instead of publishing it', async () => {
		const t = await target(await draft(), reviewed.conn, 'cancelled', null);
		const out = await retryDelivery(ctx(AGENT), userId, t);
		expect(out).toMatchObject({ status: 'awaiting_review', heldForReview: true });
		expect((await row(t)).status).toBe('awaiting_review');
		expect(sent).toEqual([]);
	});

	it('refuses an agent’s retry of a held delivery', async () => {
		const t = await target(await draft(), reviewed.conn, 'awaiting_review', new Date());
		await expect(retryDelivery(ctx(AGENT), userId, t)).rejects.toMatchObject({
			status: 409,
			details: { code: 'held_for_review' }
		});
	});
});

describe('calendar states', () => {
	it('draws held and rejected deliveries as their own states, never due', () => {
		const past = Date.now() - HOUR;
		const base = { scheduledFor: past, updatedAt: past };
		expect(calendarStatus({ ...base, status: 'awaiting_review' })).toBe('review');
		expect(calendarStatus({ ...base, status: 'rejected' })).toBe('rejected');
		expect(itemActions('review')).toEqual(['review', 'cancel']);
	});
});

type Persona = 'session' | 'key';
async function call(
	handler: (event: never) => Promise<Response> | Response,
	who: Persona,
	opts: { body?: unknown; params?: Record<string, string>; search?: string; method?: string } = {}
) {
	const user: SessionUser = {
		id: userId,
		email: 'op@localhost',
		timezone: 'UTC',
		totpEnabled: true,
		mfaVerified: true,
		role: 'admin'
	};
	const url = new URL(`https://cogsend.example/api/x${opts.search ?? ''}`);
	return handler({
		request: new Request(url, {
			method: opts.method ?? 'POST',
			headers: { 'content-type': 'application/json' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		}),
		url,
		params: opts.params ?? {},
		locals: {
			db,
			env: TEST_ENV,
			media: createTestMedia(),
			user,
			authMethod: who === 'session' ? 'session' : 'bearer',
			authCredential: who === 'session' ? 'session' : 'personal_api_key',
			apiKeyScopes: who === 'session' ? null : ['read', 'write'],
			apiKey: who === 'session' ? null : AGENT.apiKey,
			waitUntil: () => {}
		}
	} as never);
}

describe('review routes', () => {
	it('approve and reject only answer a signed-in operator, never an API key', async () => {
		const held = await target(
			await draft(),
			reviewed.conn,
			'awaiting_review',
			new Date(Date.now() + HOUR)
		);
		for (const handler of [approveRoute.POST, rejectRoute.POST]) {
			const res = await call(handler, 'key', { body: { deliveryIds: [held] } });
			expect(res.status).toBe(401);
		}
		expect((await row(held)).status).toBe('awaiting_review');
		const res = await call(approveRoute.POST, 'session', { body: { deliveryIds: [held] } });
		expect(res.status).toBe(200);
		expect((await res.json()).approved).toEqual([held]);
	});

	it('lets an API key read the queue', async () => {
		await target(await draft(), reviewed.conn, 'awaiting_review', new Date(Date.now() + HOUR));
		const res = await call(reviewRoute.GET, 'key', { method: 'GET' });
		expect(res.status).toBe(200);
		expect((await res.json()).counts.waiting).toBe(1);
	});

	it('lets an API key pause a brand or turn review on, but not trust a brand or resume one', async () => {
		const pause = await call(brandRoute.PATCH, 'key', {
			method: 'PATCH',
			params: { id: reviewed.brand },
			body: { paused: true }
		});
		expect(pause.status).toBe(200);
		expect((await pause.json()).brand.paused).toBe(true);
		for (const body of [{ paused: false }, { requireApproval: false }]) {
			const res = await call(brandRoute.PATCH, 'key', {
				method: 'PATCH',
				params: { id: reviewed.brand },
				body
			});
			expect(res.status, JSON.stringify(body)).toBe(403);
		}
		const [b] = await db.select().from(brands).where(eq(brands.id, reviewed.brand));
		expect(b.requireApproval).toBe(true);
		expect(b.pausedAt).not.toBeNull();
		const resume = await call(brandRoute.PATCH, 'session', {
			method: 'PATCH',
			params: { id: reviewed.brand },
			body: { paused: false, requireApproval: false }
		});
		expect((await resume.json()).brand).toMatchObject({ paused: false, requireApproval: false });
		const { entries } = await listActivity(db, userId, { action: 'brand' });
		expect(entries.map((e) => e.action).sort()).toEqual([
			'brand.pause',
			'brand.resume',
			'brand.review_off'
		]);
	});

	it('pages the activity log through the API with filters', async () => {
		const d = await draft();
		await scheduleDraft(ctx(AGENT), userId, d, { connectionIds: [reviewed.conn], runAt: later() });
		const res = await call(activityRoute.GET, 'session', {
			method: 'GET',
			search: '?actor=api_key&limit=1'
		});
		const body = await res.json();
		expect(body.entries).toHaveLength(1);
		expect(body.entries[0].actor.type).toBe('api_key');
	});
});

describe('activity log', () => {
	it('maps REST writes to named actions and skips what it should', () => {
		const base = { params: { id: 'd1' }, status: 200, authCredential: 'personal_api_key' as const };
		expect(
			restActivity({
				...base,
				method: 'POST',
				routeId: '/api/drafts/[id]/schedule',
				path: '/api/drafts/d1/schedule'
			})
		).toMatchObject({ action: 'post.schedule', targetType: 'post', targetId: 'd1' });
		expect(
			restActivity({ ...base, method: 'GET', routeId: '/api/drafts/[id]', path: '/api/drafts/d1' })
		).toBeNull();
		expect(
			restActivity({ ...base, method: 'POST', routeId: '/api/mcp', path: '/api/mcp' })
		).toBeNull();
		expect(
			restActivity({
				...base,
				status: 409,
				method: 'POST',
				routeId: '/api/drafts/[id]/schedule',
				path: '/api/drafts/d1/schedule'
			})
		).toBeNull();
		// The composer's autosave would bury everything else; an agent's edit would not.
		const edit = { method: 'PATCH', routeId: '/api/drafts/[id]', path: '/api/drafts/d1' };
		expect(restActivity({ ...base, ...edit, authCredential: 'session' })).toBeNull();
		expect(restActivity({ ...base, ...edit })).toMatchObject({ action: 'post.edit' });
	});

	it('pages newest first with a cursor and clears rows past retention', async () => {
		const actor = actorOf(SESSION);
		const old = new Date(Date.now() - 100 * 24 * HOUR);
		await db.insert(activityLog).values({
			id: newId(),
			userId,
			actorType: 'session',
			actorLabel: actor.label,
			action: 'post.edit',
			summary: 'ancient',
			createdAt: old
		});
		for (let i = 0; i < 3; i++)
			await db.insert(activityLog).values({
				id: newId(),
				userId,
				actorType: 'session',
				actorLabel: actor.label,
				action: 'post.edit',
				summary: `edit ${i}`,
				createdAt: new Date(Date.now() - i * 1000)
			});
		const first = await listActivity(db, userId, { limit: 2 });
		expect(first.entries.map((e) => e.summary)).toEqual(['edit 0', 'edit 1']);
		const second = await listActivity(db, userId, { limit: 2, cursor: first.next });
		expect(second.entries.map((e) => e.summary)).toEqual(['edit 2', 'ancient']);
		await purgeOldActivity(db);
		const after = await listActivity(db, userId, { limit: 10 });
		expect(after.entries.map((e) => e.summary)).not.toContain('ancient');
	});
});
