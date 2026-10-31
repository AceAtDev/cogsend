import { describe, expect, it } from 'vitest';
import {
	addMonths,
	calendarHref,
	calendarStatus,
	canDrag,
	dayKeyOf,
	droppedInstant,
	filteredConnectionIds,
	fromZonedInputValue,
	isDateKey,
	itemActions,
	itemInstant,
	monthGrid,
	parseCalendarQuery,
	rangeBounds,
	reschedulePayload,
	safeTimeZone,
	shiftAnchor,
	toZonedInputValue,
	visibleRange,
	weekStart,
	zonedParts,
	zonedToUtc
} from '#lib/domain/calendar.js';
import { PROCESSING_MARK } from '#lib/domain/video-rules.js';

const TORONTO = 'America/Toronto';
const iso = (ms: number) => new Date(ms).toISOString();

describe('calendar weeks and months', () => {
	it('starts weeks on Monday, from any day of the week', () => {
		expect(weekStart('2026-10-26')).toBe('2026-10-26');
		expect(weekStart('2026-10-31')).toBe('2026-10-26');
		expect(weekStart('2026-11-01')).toBe('2026-10-26');
		expect(weekStart('2027-01-01')).toBe('2026-12-28');
	});

	it('covers a month with whole weeks, spilling into the months either side', () => {
		const nov = monthGrid('2026-11-15');
		expect(nov).toHaveLength(6);
		expect(nov[0][0]).toBe('2026-10-26');
		expect(nov[5][6]).toBe('2026-12-06');
		expect(nov.every((week) => week.length === 7)).toBe(true);
		// February 2027 starts on a Monday and has 28 days: exactly four rows.
		const feb = monthGrid('2027-02-10');
		expect(feb).toHaveLength(4);
		expect(feb[0][0]).toBe('2027-02-01');
		expect(feb[3][6]).toBe('2027-02-28');
	});

	it('gives each view its days with an exclusive end', () => {
		const week = visibleRange('week', '2026-10-31');
		expect(week).toMatchObject({ start: '2026-10-26', end: '2026-11-02' });
		expect(week.days).toHaveLength(7);
		const month = visibleRange('month', '2026-11-15');
		expect(month.start).toBe('2026-10-26');
		expect(month.end).toBe('2026-12-07');
		expect(month.days).toHaveLength(42);
	});

	it('steps by a week or a month without overflowing short months', () => {
		expect(shiftAnchor('week', '2026-10-31', 1)).toBe('2026-11-02');
		expect(shiftAnchor('week', '2026-10-31', -1)).toBe('2026-10-19');
		expect(shiftAnchor('month', '2027-01-31', 1)).toBe('2027-02-01');
		expect(shiftAnchor('month', '2026-12-15', 1)).toBe('2027-01-01');
		expect(addMonths('2026-01-01', -1)).toBe('2025-12-01');
	});

	it('accepts only real dates as keys', () => {
		expect(isDateKey('2026-02-29')).toBe(false);
		expect(isDateKey('2028-02-29')).toBe(true);
		expect(isDateKey('2026-13-01')).toBe(false);
		expect(isDateKey('26-01-01')).toBe(false);
	});
});

describe('calendar time zones', () => {
	it('bounds the week of the November DST change at local midnights (one hour longer)', () => {
		const { startMs, endMs } = rangeBounds(visibleRange('week', '2026-11-01'), TORONTO);
		expect(iso(startMs)).toBe('2026-10-26T04:00:00.000Z');
		expect(iso(endMs)).toBe('2026-11-02T05:00:00.000Z');
		expect(endMs - startMs).toBe((7 * 24 + 1) * 3_600_000);
	});

	it('bounds the week of the March DST change (one hour shorter)', () => {
		const { startMs, endMs } = rangeBounds(visibleRange('week', '2026-03-08'), TORONTO);
		expect(iso(startMs)).toBe('2026-03-02T05:00:00.000Z');
		expect(iso(endMs)).toBe('2026-03-09T04:00:00.000Z');
	});

	it('moves a wall time that does not exist forward past the gap', () => {
		expect(iso(zonedToUtc('2026-03-08', 2 * 60 + 30, TORONTO))).toBe('2026-03-08T07:30:00.000Z');
		expect(zonedParts(zonedToUtc('2026-03-08', 2 * 60 + 30, TORONTO), TORONTO)).toEqual({
			key: '2026-03-08',
			minutes: 3 * 60 + 30
		});
	});

	it('resolves a repeated wall time to its first occurrence', () => {
		expect(iso(zonedToUtc('2026-11-01', 60 + 30, TORONTO))).toBe('2026-11-01T05:30:00.000Z');
	});

	it('puts items near midnight on the local day, not the UTC one', () => {
		expect(dayKeyOf(Date.parse('2026-11-01T03:59:00Z'), TORONTO)).toBe('2026-10-31');
		expect(dayKeyOf(Date.parse('2026-11-01T04:00:00Z'), TORONTO)).toBe('2026-11-01');
		// After the change midnight is 05:00 UTC.
		expect(dayKeyOf(Date.parse('2026-11-02T04:59:00Z'), TORONTO)).toBe('2026-11-01');
		expect(dayKeyOf(Date.parse('2026-11-02T05:00:00Z'), TORONTO)).toBe('2026-11-02');
		expect(zonedParts(Date.parse('2026-11-02T04:59:00Z'), TORONTO).minutes).toBe(23 * 60 + 59);
	});

	it('round-trips the reschedule input in the operator zone', () => {
		const at = Date.parse('2026-11-03T14:05:00Z');
		expect(toZonedInputValue(at, TORONTO)).toBe('2026-11-03T09:05');
		expect(fromZonedInputValue('2026-11-03T09:05', TORONTO)).toBe(at);
		expect(fromZonedInputValue('2026-11-03T25:00', TORONTO)).toBeNull();
		expect(fromZonedInputValue('nope', TORONTO)).toBeNull();
	});

	it('falls back to UTC for a zone the runtime does not know', () => {
		expect(safeTimeZone('Mars/Olympus')).toBe('UTC');
		expect(safeTimeZone(TORONTO)).toBe(TORONTO);
	});
});

describe('drag to reschedule', () => {
	// Friday Oct 30, 23:30 EDT.
	const lateFriday = Date.parse('2026-10-31T03:30:00Z');

	it('keeps the local time of day when dropped on a month day across the DST change', () => {
		const to = droppedInstant(lateFriday, { day: '2026-11-02' }, TORONTO);
		expect(iso(to)).toBe('2026-11-03T04:30:00.000Z');
		expect(zonedParts(to, TORONTO)).toEqual({ key: '2026-11-02', minutes: 23 * 60 + 30 });
	});

	it('takes the hour of a week slot and keeps the minutes', () => {
		const to = droppedInstant(lateFriday, { day: '2026-11-01', hour: 9 }, TORONTO);
		expect(iso(to)).toBe('2026-11-01T14:30:00.000Z');
		expect(iso(droppedInstant(lateFriday, { day: '2026-10-31', hour: 0 }, TORONTO))).toBe(
			'2026-10-31T04:30:00.000Z'
		);
	});

	it('sends the bulk route the body the Posts page sends', () => {
		const to = droppedInstant(lateFriday, { day: '2026-11-01', hour: 9 }, TORONTO);
		expect(reschedulePayload(['t1'], to)).toEqual({
			op: 'reschedule',
			ids: ['t1'],
			runAt: '2026-11-01T14:30:00.000Z'
		});
	});
});

describe('calendar item status', () => {
	const now = new Date('2026-10-31T12:00:00Z');
	const base = {
		status: 'scheduled',
		scheduledFor: Date.parse('2026-10-31T15:00:00Z'),
		updatedAt: Date.parse('2026-10-30T12:00:00Z'),
		errorMessage: null,
		jobId: null,
		remotePostId: null
	};

	it('tells waiting, due, sending, processing and finished targets apart', () => {
		expect(calendarStatus(base, now)).toBe('scheduled');
		expect(calendarStatus({ ...base, scheduledFor: Date.parse('2026-10-31T11:00:00Z') }, now)).toBe(
			'due'
		);
		expect(calendarStatus({ ...base, status: 'pending', scheduledFor: null }, now)).toBe('due');
		expect(
			calendarStatus({ ...base, status: 'publishing', updatedAt: now.getTime() - 1000 }, now)
		).toBe('sending');
		expect(
			calendarStatus({ ...base, status: 'publishing', updatedAt: now.getTime() - 60 * 60_000 }, now)
		).toBe('due');
		expect(calendarStatus({ ...base, errorMessage: `x ${PROCESSING_MARK} y` }, now)).toBe(
			'processing'
		);
		expect(calendarStatus({ ...base, status: 'published' }, now)).toBe('published');
		expect(calendarStatus({ ...base, status: 'failed', remotePostId: 'r1' }, now)).toBe(
			'published'
		);
		expect(calendarStatus({ ...base, status: 'failed' }, now)).toBe('failed');
		expect(calendarStatus({ ...base, status: 'cancelled', scheduledFor: null }, now)).toBe(
			'cancelled'
		);
	});

	it('places an untimed row at its last change and lets only waiting rows move', () => {
		expect(itemInstant({ scheduledFor: null, updatedAt: 5 })).toBe(5);
		expect(itemInstant({ scheduledFor: 7, updatedAt: 5 })).toBe(7);
		expect(canDrag('scheduled')).toBe(true);
		expect(canDrag('due')).toBe(true);
		expect(canDrag('processing')).toBe(false);
		expect(canDrag('published')).toBe(false);
		expect(itemActions('failed')).toEqual(['retry', 'cancel']);
		expect(itemActions('sending')).toEqual([]);
	});
});

describe('calendar query', () => {
	const today = '2026-10-31';

	it('defaults to this week and drops what it cannot use', () => {
		const q = parseCalendarQuery(new URLSearchParams('view=year&date=2026-02-30'), today);
		expect(q).toEqual({ view: 'week', date: today, brands: [], channels: [], cancelled: false });
		expect(calendarHref(q, today)).toBe('/calendar');
	});

	it('round-trips view, date and filters through the address', () => {
		const q = parseCalendarQuery(
			new URLSearchParams(
				'view=month&date=2026-12-01&brand=JobJob,unbranded&channel=465cal.tiktok&cancelled=1'
			),
			today
		);
		expect(q).toEqual({
			view: 'month',
			date: '2026-12-01',
			brands: ['jobjob', 'unbranded'],
			channels: ['465cal.tiktok'],
			cancelled: true
		});
		expect(
			parseCalendarQuery(new URL(`http://x${calendarHref(q, today)}`).searchParams, today)
		).toEqual(q);
	});

	it('adds brand and channel picks together', () => {
		const channels = [
			{ connectionId: 'li', key: 'jobjob.linkedin', brandSlug: 'jobjob' },
			{ connectionId: 'ig', key: 'jobjob.instagram', brandSlug: 'jobjob' },
			{ connectionId: 'tt', key: '465cal.tiktok', brandSlug: '465cal' },
			{ connectionId: 'bs', key: 'unbranded.bluesky', brandSlug: 'unbranded' }
		];
		expect(filteredConnectionIds(channels, { brands: [], channels: [] })).toBeNull();
		expect([
			...filteredConnectionIds(channels, { brands: ['jobjob'], channels: ['465cal.tiktok'] })!
		]).toEqual(['li', 'ig', 'tt']);
		expect([...filteredConnectionIds(channels, { brands: ['unbranded'], channels: [] })!]).toEqual([
			'bs'
		]);
		expect(filteredConnectionIds(channels, { brands: ['nobody'], channels: [] })!.size).toBe(0);
	});
});
