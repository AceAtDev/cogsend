import { describe, expect, it } from 'vitest';
import {
	describeRules,
	describeSlots,
	parsePostingRules,
	rulesFromStored,
	SlotPlanner,
	slotInstantsOn,
	weekdayOfKey,
	type PostingRules
} from '#lib/domain/posting-slots.js';
import { describeInstant } from '#lib/domain/zoned-time.js';

const BERLIN = 'Europe/Berlin';
const NY = 'America/New_York';
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const at = (s: string) => Date.parse(s);

function planner(
	rules: PostingRules,
	{
		now = at('2026-11-02T06:00:00Z'),
		occupied = [] as string[],
		timeZone = BERLIN
	}: { now?: number; occupied?: string[]; timeZone?: string } = {}
) {
	return new SlotPlanner({
		timeZone,
		now,
		rules: new Map([['c1', rules]]),
		occupied: new Map([['c1', occupied.map(at)]])
	});
}

const weekdays9and18: PostingRules = {
	slots: {
		mon: ['09:00', '18:00'],
		tue: ['09:00', '18:00'],
		wed: ['09:00', '18:00'],
		thu: ['09:00', '18:00'],
		fri: ['09:00', '18:00']
	},
	maxPerDay: null,
	minGapMinutes: null
};

describe('parsePostingRules', () => {
	it('sorts and deduplicates times and drops empty days', () => {
		const parsed = parsePostingRules({
			slots: { mon: ['18:00', '09:00', '09:00'], tue: [] },
			maxPerDay: 2,
			minGapMinutes: '90'
		});
		expect(parsed).toEqual({
			ok: true,
			rules: { slots: { mon: ['09:00', '18:00'] }, maxPerDay: 2, minGapMinutes: 90 }
		});
	});

	it.each([
		[{ slots: { monday: ['09:00'] } }, /not a day/],
		[{ slots: { mon: ['9:00'] } }, /HH:MM/],
		[{ slots: { mon: ['24:00'] } }, /HH:MM/],
		[{ slots: { mon: '09:00' } }, /list of times/],
		[{ maxPerDay: 0 }, /maxPerDay/],
		[{ maxPerDay: 1.5 }, /maxPerDay/],
		[{ minGapMinutes: 1441 }, /minGapMinutes/],
		[{ timezone: 'UTC' }, /Unknown field/],
		[[], /Send an object/]
	])('refuses %j', (input, message) => {
		const parsed = parsePostingRules(input);
		expect(parsed.ok).toBe(false);
		expect(!parsed.ok && parsed.error).toMatch(message);
	});

	it('reads a damaged stored row as no rule rather than failing', () => {
		expect(rulesFromStored('{not json', null, null)).toEqual({
			slots: {},
			maxPerDay: null,
			minGapMinutes: null
		});
		expect(rulesFromStored('{"mon":["09:00"]}', 3, null).slots).toEqual({ mon: ['09:00'] });
	});
});

describe('describing slots', () => {
	it('joins runs of days with the same times', () => {
		expect(describeSlots({ ...weekdays9and18.slots, sat: ['10:00'], sun: ['10:00'] })).toBe(
			'Mon–Fri 09:00, 18:00; Sat–Sun 10:00'
		);
		expect(describeSlots({ mon: ['09:00'], wed: ['09:00'] })).toBe('Mon 09:00; Wed 09:00');
		expect(describeRules({ slots: {}, maxPerDay: 2, minGapMinutes: 60 })).toBe(
			'no slots, max 2/day, 60 min apart'
		);
	});

	it('reads the weekday of a date key, Monday first', () => {
		expect(weekdayOfKey('2026-11-02')).toBe('mon');
		expect(weekdayOfKey('2026-11-08')).toBe('sun');
	});
});

describe('slot instants across DST', () => {
	it('keeps the wall-clock time when the offset changes', () => {
		// Berlin leaves summer time on 2026-10-25.
		const before = slotInstantsOn({ fri: ['09:00'] }, '2026-10-23', BERLIN);
		const after = slotInstantsOn({ mon: ['09:00'] }, '2026-10-26', BERLIN);
		expect(before.map(iso)).toEqual(['2026-10-23T07:00:00.000Z']);
		expect(after.map(iso)).toEqual(['2026-10-26T08:00:00.000Z']);
	});

	it('moves a slot in the spring-forward gap forward by the gap', () => {
		// 2027-03-28 02:30 does not exist in Berlin; it becomes 03:30 CEST.
		const instants = slotInstantsOn({ sun: ['02:30'] }, '2027-03-28', BERLIN);
		expect(instants.map((ms) => describeInstant(ms, BERLIN).local)).toEqual([
			'2027-03-28T03:30:00+02:00'
		]);
	});

	it('takes the first occurrence of a repeated time and keeps two slots that collide once', () => {
		// 02:30 happens twice on 2026-10-25; and 02:30 + 03:30 in the 2027 gap meet.
		const repeated = slotInstantsOn({ sun: ['02:30'] }, '2026-10-25', BERLIN);
		expect(repeated.map((ms) => describeInstant(ms, BERLIN).local)).toEqual([
			'2026-10-25T02:30:00+02:00'
		]);
		expect(slotInstantsOn({ sun: ['02:30', '03:30'] }, '2027-03-28', BERLIN)).toHaveLength(1);
	});

	it('finds the next slot across the New York change on its own date', () => {
		// New York changes a week after Berlin, on 2026-11-01.
		const p = planner(
			{ slots: { sun: ['01:30'] }, maxPerDay: null, minGapMinutes: null },
			{ timeZone: NY, now: at('2026-10-31T12:00:00Z') }
		);
		const next = p.nextOpenSlot('c1', p.now);
		expect(describeInstant(next!, NY).local).toBe('2026-11-01T01:30:00-04:00');
	});
});

describe('SlotPlanner.nextOpenSlot', () => {
	it('takes the first future slot, skipping today’s that have passed', () => {
		// Monday 2026-11-02 10:00 Berlin: 09:00 is gone, 18:00 is next.
		const p = planner(weekdays9and18, { now: at('2026-11-02T09:00:00Z') });
		expect(iso(p.nextOpenSlot('c1', p.now))).toBe('2026-11-02T17:00:00.000Z');
	});

	it('skips the weekend and days with no slots', () => {
		const p = planner(weekdays9and18, { now: at('2026-11-06T18:00:00Z') });
		expect(describeInstant(p.nextOpenSlot('c1', p.now)!, BERLIN).display).toMatch(
			/^Monday 2026-11-09 09:00/
		);
	});

	it('treats a post within 15 minutes of a slot as filling it', () => {
		const p = planner(weekdays9and18, { occupied: ['2026-11-02T08:10:00Z'] });
		expect(iso(p.nextOpenSlot('c1', p.now))).toBe('2026-11-02T17:00:00.000Z');
		const q = planner(weekdays9and18, { occupied: ['2026-11-02T07:40:00Z'] });
		expect(iso(q.nextOpenSlot('c1', q.now))).toBe('2026-11-02T08:00:00.000Z');
	});

	it('respects max posts a day in the operator’s day, not UTC’s', () => {
		// 00:30 Berlin on Monday is Sunday 23:30 UTC, and counts for Monday.
		const p = planner(
			{ ...weekdays9and18, maxPerDay: 1 },
			{ now: at('2026-11-01T20:00:00Z'), occupied: ['2026-11-01T23:30:00Z'] }
		);
		expect(describeInstant(p.nextOpenSlot('c1', p.now)!, BERLIN).display).toMatch(
			/^Tuesday 2026-11-03 09:00/
		);
	});

	it('respects the minimum gap to posts outside slots', () => {
		const rules = { ...weekdays9and18, minGapMinutes: 120 };
		const p = planner(rules, { occupied: ['2026-11-02T09:30:00Z'] });
		// 09:00 Berlin (08:00Z) is 90 min from 10:30 Berlin; 18:00 is fine.
		expect(iso(p.nextOpenSlot('c1', p.now))).toBe('2026-11-02T17:00:00.000Z');
	});

	it('gives two competing requests different slots once the first is reserved', () => {
		const p = planner(weekdays9and18);
		const first = p.nextOpenSlot('c1', p.now)!;
		p.reserve('c1', first);
		const second = p.nextOpenSlot('c1', p.now)!;
		p.reserve('c1', second);
		const third = p.nextOpenSlot('c1', p.now)!;
		expect([first, second, third].map(iso)).toEqual([
			'2026-11-02T08:00:00.000Z',
			'2026-11-02T17:00:00.000Z',
			'2026-11-03T08:00:00.000Z'
		]);
	});

	it('starts from `after` and never offers a slot about to pass', () => {
		const p = planner(weekdays9and18, { now: at('2026-11-02T07:59:30Z') });
		expect(iso(p.nextOpenSlot('c1', p.now))).toBe('2026-11-02T17:00:00.000Z');
		expect(iso(p.nextOpenSlot('c1', at('2026-11-04T00:00:00Z')))).toBe('2026-11-04T08:00:00.000Z');
	});

	it('gives up past the horizon and when there are no slots', () => {
		const full = planner(
			{ slots: { mon: ['09:00'] }, maxPerDay: null, minGapMinutes: 1440 },
			{ occupied: [] }
		);
		for (let week = 0; week < 10; week++)
			full.reserve('c1', at('2026-11-02T08:00:00Z') + week * 7 * 86_400_000);
		expect(full.nextOpenSlot('c1', full.now)).toBeNull();
		expect(planner({ slots: {}, maxPerDay: 3, minGapMinutes: null }).nextOpenSlot('c1', 0)).toBe(
			null
		);
	});
});

describe('SlotPlanner limits', () => {
	it('names the day limit and the next allowed time at the operator’s midnight', () => {
		const p = planner(
			{ slots: {}, maxPerDay: 2, minGapMinutes: null },
			{ occupied: ['2026-11-02T08:00:00Z', '2026-11-02T12:00:00Z'] }
		);
		const want = at('2026-11-02T17:00:00Z');
		expect(p.violation('c1', want)).toEqual({
			code: 'max_per_day',
			day: '2026-11-02',
			limit: 2,
			count: 2
		});
		expect(describeInstant(p.nextAllowed('c1', want)!, BERLIN).local).toBe(
			'2026-11-03T00:00:00+01:00'
		);
	});

	it('pushes past every post within the gap, in a chain', () => {
		const p = planner(
			{ slots: {}, maxPerDay: null, minGapMinutes: 60 },
			{ occupied: ['2026-11-02T10:00:00Z', '2026-11-02T10:50:00Z'] }
		);
		const want = at('2026-11-02T10:30:00Z');
		expect(p.violation('c1', want)).toMatchObject({ code: 'min_gap', gapMinutes: 60 });
		expect(iso(p.nextAllowed('c1', want))).toBe('2026-11-02T11:50:00.000Z');
		expect(p.violation('c1', at('2026-11-02T08:59:00Z'))).toBeNull();
	});

	it('leaves an account without rules alone', () => {
		const p = new SlotPlanner({
			timeZone: BERLIN,
			now: 0,
			rules: new Map(),
			occupied: new Map([['c1', [1000]]])
		});
		expect(p.violation('c1', 1000)).toBeNull();
		expect(p.hasSlots('c1')).toBe(false);
	});

	it('lists open and all slots in a range', () => {
		const p = planner(weekdays9and18, { occupied: ['2026-11-03T08:00:00Z'] });
		const from = at('2026-11-02T00:00:00Z');
		const to = at('2026-11-04T00:00:00Z');
		expect(p.allSlots('c1', from, to)).toHaveLength(4);
		expect(p.openSlots('c1', from, to).map(iso)).toEqual([
			'2026-11-02T08:00:00.000Z',
			'2026-11-02T17:00:00.000Z',
			'2026-11-03T17:00:00.000Z'
		]);
	});
});
