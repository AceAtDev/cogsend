import { describeInstant, zonedLocalToUtc } from '#lib/domain/zoned-time.js';
import type { DayWindow } from './events';

function isoDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

/** Local midnight as an instant. A zone that skips midnight (DST at 00:00)
 *  starts its day at the first instant after the gap. */
function midnight(date: string, timeZone: string): Date {
	const resolved = zonedLocalToUtc(`${date}T00:00`, timeZone);
	if (resolved.ok) return resolved.utc;
	if (resolved.reason === 'ambiguous') return resolved.candidates[0];
	if (resolved.reason === 'nonexistent') return resolved.candidates[1];
	return new Date(`${date}T00:00:00Z`);
}

const labelFormat = new Intl.DateTimeFormat('en-GB', {
	weekday: 'long',
	day: 'numeric',
	month: 'long',
	timeZone: 'UTC'
});

/** The local calendar day `offsetDays` from the one `now` falls in. */
export function dayWindow(now: Date, timeZone: string, offsetDays = 0): DayWindow {
	const local = describeInstant(now, timeZone).local.slice(0, 10);
	const day = new Date(`${local}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() + offsetDays);
	const next = new Date(day);
	next.setUTCDate(next.getUTCDate() + 1);
	const date = isoDate(day);
	return {
		start: midnight(date, timeZone),
		end: midnight(isoDate(next), timeZone),
		date,
		label: labelFormat.format(day)
	};
}

/** Minutes after local midnight. */
export function localMinute(now: Date, timeZone: string): number {
	const local = describeInstant(now, timeZone).local;
	return Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
}

/** `09:30` in the zone. */
export function localClock(at: Date, timeZone: string): string {
	return describeInstant(at, timeZone).local.slice(11, 16);
}
