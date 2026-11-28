import { describe, expect, it } from 'vitest';
import type { CalendarChannel, CalendarItem } from '#lib/domain/calendar.js';
import {
	boxBetween,
	boxesOverlap,
	bulkPlan,
	rescheduleCalls,
	shiftLabel
} from '#lib/domain/calendar-selection.js';
import { overviewDays } from '#lib/domain/compose-overview.js';

const NOW = Date.UTC(2026, 10, 27, 17, 0);
const HOUR = 3_600_000;

describe('bulk plan', () => {
	it('offers each action only for the posts it applies to', () => {
		const plan = bulkPlan(
			[
				{ id: 'held-past', status: 'review', at: NOW - HOUR, channelStatus: 'active' },
				{ id: 'held-future', status: 'review', at: NOW + HOUR, channelStatus: 'active' },
				{ id: 'rejected', status: 'rejected', at: NOW + HOUR, channelStatus: 'active' },
				{ id: 'scheduled', status: 'scheduled', at: NOW + HOUR, channelStatus: 'active' },
				{ id: 'expired', status: 'scheduled', at: NOW + HOUR, channelStatus: 'expired' },
				{ id: 'failed', status: 'failed', at: NOW - HOUR, channelStatus: 'active' },
				{ id: 'published', status: 'published', at: NOW - HOUR, channelStatus: 'active' }
			],
			NOW
		);
		expect(plan.approve).toEqual(['held-past', 'held-future', 'rejected']);
		expect(plan.approveNow).toEqual(['held-past']);
		expect(plan.reject).toEqual(['held-past', 'held-future']);
		// A held post moves too: the drag keeps it held instead of approving it.
		expect(plan.move).toEqual(['held-past', 'held-future', 'scheduled']);
		expect(plan.retry).toEqual(['failed']);
		expect(plan.cancel).toEqual([
			'held-past',
			'held-future',
			'rejected',
			'scheduled',
			'expired',
			'failed'
		]);
	});
});

describe('reschedule calls', () => {
	it('shares a call per minute and splits at the route limit', () => {
		const moves = [
			...Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, to: NOW + HOUR + 15_000 })),
			{ id: 'b', to: NOW }
		];
		const calls = rescheduleCalls(moves);
		expect(calls.map((c) => [c.runAt, c.ids.length])).toEqual([
			[NOW, 1],
			[NOW + HOUR, 10],
			[NOW + HOUR, 2]
		]);
	});
});

describe('marquee geometry', () => {
	it('normalises a box dragged up and left, and overlaps by area', () => {
		const box = boxBetween({ x: 100, y: 100 }, { x: 20, y: 40 });
		expect(box).toEqual({ left: 20, top: 40, right: 100, bottom: 100 });
		expect(boxesOverlap(box, { left: 90, top: 90, right: 120, bottom: 120 })).toBe(true);
		expect(boxesOverlap(box, { left: 100, top: 0, right: 120, bottom: 50 })).toBe(false);
	});

	it('says how far a group moves', () => {
		expect(shiftLabel(26 * HOUR)).toBe('+1 day 2 hr');
		expect(shiftLabel(-30 * 60_000)).toBe('−30 min');
		expect(shiftLabel(0)).toBe('no change');
	});
});

describe('compose overview', () => {
	const brand = { id: 'b', name: 'Brand', slug: 'brand', color: '#123456' };
	const channel = (connectionId: string, platform: string): CalendarChannel => ({
		connectionId,
		key: `brand/${platform}`,
		platform,
		platformName: platform,
		handle: platform,
		displayName: null,
		status: 'active',
		brand
	});
	const item = (over: Partial<CalendarItem>): CalendarItem => ({
		id: Math.random().toString(36),
		draftId: 'd1',
		connectionId: 'ig',
		status: 'scheduled',
		at: NOW,
		scheduledFor: NOW,
		retrying: false,
		remoteUrl: null,
		errorMessage: null,
		text: 'Hello\nsecond line',
		mediaCount: 0,
		...over
	});

	it('merges one post across accounts, keeps the most urgent state and drops cancelled', () => {
		const days = overviewDays(
			[
				item({ connectionId: 'ig', status: 'scheduled' }),
				item({ connectionId: 'tt', status: 'review' }),
				item({ draftId: 'd2', at: NOW + 24 * HOUR, text: 'Tomorrow' }),
				item({ draftId: 'd3', status: 'cancelled' }),
				item({ draftId: 'd4', at: NOW + 9 * 24 * HOUR, text: 'Too far' })
			],
			[channel('ig', 'instagram'), channel('tt', 'tiktok')],
			'UTC',
			'2026-11-27'
		);
		expect(days.map((d) => d.day)).toEqual(['2026-11-27', '2026-11-28']);
		expect(days[0].lines).toHaveLength(1);
		expect(days[0].lines[0].status).toBe('review');
		expect(days[0].lines[0].text).toBe('Hello');
		expect(days[0].lines[0].accounts.map((a) => a.platform)).toEqual(['instagram', 'tiktok']);
		expect(days[1].lines[0].text).toBe('Tomorrow');
	});
});

describe('spread out and shift ranges', () => {
	it('puts one post a day from the first, keeping times and moving a post with its accounts', async () => {
		const { spreadMoves, rangeBetween } = await import('#lib/domain/calendar-selection.js');
		const nine = Date.UTC(2026, 11, 1, 9, 0);
		const moves = spreadMoves(
			[
				{ id: 'a-ig', draftId: 'a', at: nine },
				{ id: 'a-tt', draftId: 'a', at: nine },
				{ id: 'b', draftId: 'b', at: nine + 8 * HOUR },
				{ id: 'c', draftId: 'c', at: nine + 2 * HOUR }
			],
			'UTC'
		);
		const iso = (id: string) => new Date(moves.find((m) => m.id === id)!.to).toISOString();
		expect(iso('a-ig')).toBe('2026-12-01T09:00:00.000Z');
		expect(iso('a-tt')).toBe('2026-12-01T09:00:00.000Z');
		expect(iso('c')).toBe('2026-12-02T11:00:00.000Z');
		expect(iso('b')).toBe('2026-12-03T17:00:00.000Z');
		expect(rangeBetween(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c']);
		expect(rangeBetween(['a', 'b'], 'x', 'b')).toEqual(['b']);
	});
});
