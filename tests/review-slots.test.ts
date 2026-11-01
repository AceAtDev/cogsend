import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Client } from '@modelcontextprotocol/client';
import { brands } from '#lib/server/db/schema.js';
import { actorOf } from '#lib/server/activity.js';
import { approveDeliveries, rejectDeliveries } from '#lib/server/review.js';
import { savePostingRules } from '#lib/server/posting-slots.js';
import { claimDueTargets } from '#lib/server/scheduler.js';
import { createMcpHarness, data, text } from './mcp-harness';

/**
 * Posting slots meet review and pause: a delivery held for review keeps the
 * slot it was given, so the cadence an agent plans around stays true; a
 * next_slot write on a reviewed brand is still held; and a paused brand still
 * hands out slots but publishes nothing. Clock pinned to Monday 2026-11-02
 * 07:00 in Berlin.
 */

const NOW = new Date('2026-11-02T06:00:00.000Z');
const MON_09 = '2026-11-02T08:00:00.000Z';
const MON_18 = '2026-11-02T17:00:00.000Z';
const TUE_09 = '2026-11-03T08:00:00.000Z';

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let agent: Client;
const ids: Record<string, string> = {};
const operator = actorOf({ authCredential: 'session' });

const call = (name: string, args: Record<string, unknown> = {}) =>
	agent.callTool({ name, arguments: args });

const weekdays = (times: string[]) =>
	Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, times]));

async function slotPost(channel: string, body: string) {
	const result = await call('schedule_posts', {
		posts: [{ channels: [channel], text: body, runAt: 'next_slot' }]
	});
	expect(result.isError, text(result)).toBeFalsy();
	return data(result);
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	h = await createMcpHarness({ timezone: 'Europe/Berlin' });
	ids.reviewed = await h.brand('JobJob', 'jobjob', '#2563eb', { requireApproval: true });
	ids.trusted = await h.brand('465Cal', '465cal', '#16a34a', { requireApproval: false });
	ids.jobjob = await h.channel('linkedin', 'jobjob', ids.reviewed);
	ids.cal = await h.channel('linkedin', '465cal', ids.trusted);
	for (const id of [ids.jobjob, ids.cal])
		await savePostingRules(h.db, h.user.id, id, {
			slots: weekdays(['09:00', '18:00']),
			maxPerDay: 2,
			minGapMinutes: 60
		});
	agent = await h.connect();
});

afterEach(async () => {
	await h.close();
	vi.useRealTimers();
});

describe('next_slot on a brand that reviews agent posts', () => {
	it('holds the delivery for review at the slot it was given', async () => {
		const out = await slotPost('jobjob.linkedin', 'Hiring a designer');
		expect(out).toMatchObject({ status: 'awaiting_review', heldForReview: 1 });
		expect(out.posts[0].deliveries[0]).toMatchObject({ status: 'awaiting_review', slot: true });
		const [row] = await h.deliveries();
		expect(row.status).toBe('awaiting_review');
		expect(row.scheduledFor!.toISOString()).toBe(MON_09);
	});

	it('counts a held delivery as taking its slot, so the next post gets the one after', async () => {
		await slotPost('jobjob.linkedin', 'First');
		await slotPost('jobjob.linkedin', 'Second');
		const times = (await h.deliveries())
			.filter((d) => d.status === 'awaiting_review')
			.map((d) => d.scheduledFor!.toISOString())
			.sort();
		expect(times).toEqual([MON_09, MON_18]);
		const slots = data(
			await call('list_slots', { channels: ['jobjob.linkedin'], to: '2026-11-03' })
		);
		expect(slots.channels[0].nextOpenSlot.utc).toBe(TUE_09);
	});

	it('counts held deliveries toward the daily cap and refuses a third named time that day', async () => {
		await slotPost('jobjob.linkedin', 'First');
		await slotPost('jobjob.linkedin', 'Second');
		const refused = await call('schedule_posts', {
			posts: [{ channels: ['jobjob.linkedin'], text: 'Third', runAt: '2026-11-02T15:00:00+01:00' }]
		});
		expect(refused.isError).toBe(true);
		expect(data(refused).code).toBe('posting_limit');
		expect(text(refused)).toContain('already has 2');
		expect(await h.deliveries()).toHaveLength(2);
	});

	it('lets a trusted brand’s slot go out while a reviewed brand’s waits, on their own channels', async () => {
		const held = await slotPost('jobjob.linkedin', 'Held');
		const sent = await slotPost('465cal.linkedin', 'Trusted');
		expect(held.status).toBe('awaiting_review');
		expect(sent.status).toBe('scheduled');
		// Both take Monday 09:00: occupancy is per channel.
		expect((await h.deliveries()).map((d) => d.scheduledFor!.toISOString())).toEqual([
			MON_09,
			MON_09
		]);
	});

	it('keeps the slot through approval, and an approved delivery still fills it', async () => {
		const out = await slotPost('jobjob.linkedin', 'Approve me');
		const deliveryId = out.posts[0].deliveries[0].deliveryId;
		await approveDeliveries(h.db, h.user.id, operator, { deliveryIds: [deliveryId] });
		const [row] = await h.deliveries();
		expect(row).toMatchObject({ status: 'scheduled' });
		expect(row.scheduledFor!.toISOString()).toBe(MON_09);
		const next = await slotPost('jobjob.linkedin', 'After it');
		expect(next.posts[0].deliveries[0].runAt.utc).toBe(MON_18);
	});

	it('checks a resubmitted delivery’s new time against the posting limits', async () => {
		const first = await slotPost('jobjob.linkedin', 'Rejected one');
		await slotPost('jobjob.linkedin', 'Second');
		await slotPost('jobjob.linkedin', 'Tuesday');
		const deliveryId = first.posts[0].deliveries[0].deliveryId;
		await rejectDeliveries(h.db, h.user.id, operator, {
			deliveryIds: [deliveryId],
			note: 'Too salesy'
		});
		// Tuesday 09:00 is taken by the third post; 09:30 is inside its 60-minute gap.
		const refused = await call('resubmit_for_review', {
			items: [{ deliveryId }],
			runAt: '2026-11-03T09:30:00+01:00'
		});
		expect(refused.isError).toBe(true);
		expect(data(refused).code).toBe('posting_limit');
		const ok = await call('resubmit_for_review', {
			items: [{ deliveryId }],
			runAt: '2026-11-03T18:00:00+01:00'
		});
		expect(ok.isError, text(ok)).toBeFalsy();
		expect(data(ok).deliveries[0]).toMatchObject({ status: 'awaiting_review' });
		// Its old Monday place no longer blocks, the new Tuesday one does.
		const slots = data(
			await call('list_slots', { channels: ['jobjob.linkedin'], to: '2026-11-04' })
		);
		expect(slots.channels[0].openSlots.map((s: { utc: string }) => s.utc)).not.toContain(
			'2026-11-03T17:00:00.000Z'
		);
	});
});

describe('next_slot on a paused brand', () => {
	beforeEach(async () => {
		await h.db.update(brands).set({ pausedAt: NOW }).where(eq(brands.id, ids.trusted));
	});

	it('still gives the post a slot, which the scheduler leaves alone while paused', async () => {
		const out = await slotPost('465cal.linkedin', 'Paused brand');
		expect(out.status).toBe('scheduled');
		const [row] = await h.deliveries();
		expect(row.scheduledFor!.toISOString()).toBe(MON_09);
		const afterSlot = new Date('2026-11-02T09:00:00.000Z');
		expect(await claimDueTargets(h.db, afterSlot)).toHaveLength(0);
		await h.db.update(brands).set({ pausedAt: null }).where(eq(brands.id, ids.trusted));
		const claimed = await claimDueTargets(h.db, afterSlot);
		expect(claimed.map((c) => c.id)).toEqual([row.id]);
	});

	it('counts the paused brand’s waiting posts, so slots are not handed out twice', async () => {
		await slotPost('465cal.linkedin', 'One');
		const next = await slotPost('465cal.linkedin', 'Two');
		expect(next.posts[0].deliveries[0].runAt.utc).toBe(MON_18);
	});
});
