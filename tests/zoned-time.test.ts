import { describe, expect, it } from 'vitest';
import {
	describeInstant,
	operatorZone,
	parseRunAt,
	zonedLocalToUtc
} from '#lib/domain/zoned-time.js';

const NOW = new Date('2027-03-20T12:00:00Z');

describe('zonedLocalToUtc', () => {
	it('converts wall-clock times either side of a DST change', () => {
		expect(zonedLocalToUtc('2027-03-27T09:00', 'Europe/Berlin')).toEqual({
			ok: true,
			utc: new Date('2027-03-27T08:00:00Z')
		});
		expect(zonedLocalToUtc('2027-03-29T09:00', 'Europe/Berlin')).toEqual({
			ok: true,
			utc: new Date('2027-03-29T07:00:00Z')
		});
		expect(zonedLocalToUtc('2027-07-01 10:30', 'America/New_York')).toEqual({
			ok: true,
			utc: new Date('2027-07-01T14:30:00Z')
		});
	});

	it('refuses a time skipped by the clocks going forward, offering both sides of the gap', () => {
		const gap = zonedLocalToUtc('2027-03-28T02:30', 'Europe/Berlin');
		expect(gap).toMatchObject({ ok: false, reason: 'nonexistent' });
		if (gap.ok) return;
		expect(gap.candidates.map((d) => describeInstant(d, 'Europe/Berlin').local)).toEqual([
			'2027-03-28T01:30:00+01:00',
			'2027-03-28T03:30:00+02:00'
		]);
	});

	it('refuses a time that happens twice when the clocks go back', () => {
		const twice = zonedLocalToUtc('2027-11-07T01:30', 'America/New_York');
		expect(twice).toMatchObject({ ok: false, reason: 'ambiguous' });
		if (twice.ok) return;
		expect(twice.candidates.map((d) => d.toISOString())).toEqual([
			'2027-11-07T05:30:00.000Z',
			'2027-11-07T06:30:00.000Z'
		]);
	});

	it('rejects impossible dates', () => {
		expect(zonedLocalToUtc('2027-02-30T09:00', 'UTC')).toMatchObject({ reason: 'invalid' });
		expect(zonedLocalToUtc('tomorrow 9am', 'UTC')).toMatchObject({ reason: 'invalid' });
	});
});

describe('parseRunAt', () => {
	it('takes an offset, Z, local time with a zone, or now', () => {
		expect(parseRunAt('2027-03-21T09:00:00+01:00', NOW, 'UTC')).toMatchObject({
			ok: true,
			utc: new Date('2027-03-21T08:00:00Z')
		});
		expect(parseRunAt('2027-03-21T08:00:00.000Z', NOW, 'UTC')).toMatchObject({ ok: true });
		expect(
			parseRunAt({ localTime: '2027-03-21T09:00', timeZone: 'Asia/Tokyo' }, NOW, 'UTC')
		).toMatchObject({ ok: true, utc: new Date('2027-03-21T00:00:00Z') });
		expect(parseRunAt('now', NOW, 'UTC')).toMatchObject({ ok: true, now: true });
	});

	it('refuses zone-less, past, far-future and unknown-zone times, quoting the server clock', () => {
		const zoneless = parseRunAt('2027-03-21T09:00', NOW, 'Europe/Berlin');
		expect(zoneless.ok).toBe(false);
		if (zoneless.ok) return;
		expect(zoneless.message).toContain('no time zone');
		expect(zoneless.message).toContain(
			'Server now: Saturday 2027-03-20 13:00 (Europe/Berlin, UTC+01:00)'
		);
		expect(zoneless.message).toContain('"timeZone": "Europe/Berlin"');
		const past = parseRunAt('2027-03-20T11:00:00Z', NOW, 'UTC');
		expect(past.ok || past.message).toMatch(/in the past/);
		const far = parseRunAt('2029-01-01T00:00:00Z', NOW, 'UTC');
		expect(far.ok || far.message).toMatch(/next year/);
		const zone = parseRunAt(
			{ localTime: '2027-03-21T09:00', timeZone: 'Mars/Olympus' },
			NOW,
			'UTC'
		);
		expect(zone.ok || zone.message).toMatch(/not an IANA time zone/);
	});
});

describe('describeInstant', () => {
	it('shows the weekday, local offset and UTC', () => {
		expect(describeInstant(new Date('2027-03-29T07:00:00Z'), 'Europe/Berlin')).toEqual({
			utc: '2027-03-29T07:00:00.000Z',
			local: '2027-03-29T09:00:00+02:00',
			weekday: 'Monday',
			timeZone: 'Europe/Berlin',
			display: 'Monday 2027-03-29 09:00 (Europe/Berlin, UTC+02:00)'
		});
		expect(describeInstant(0, 'Asia/Kolkata').local).toBe('1970-01-01T05:30:00+05:30');
	});

	it('falls back to UTC for a zone the runtime does not know', () => {
		expect(operatorZone('Not/AZone')).toBe('UTC');
		expect(operatorZone('Europe/Berlin')).toBe('Europe/Berlin');
	});
});
