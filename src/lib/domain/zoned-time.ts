import { MAX_SCHEDULE_AHEAD_MS, SCHEDULE_PAST_GRACE_MS } from './request-limits';
import { parseTimeZone } from './time-zone';

/**
 * Times an agent sends and reads back. An agent works out "Tuesday at 9" from
 * a `now` the server gives it, so every instant goes out as UTC plus the
 * operator's wall clock with its weekday, and every instant coming in must say
 * which zone it means: a bare "2026-11-03T09:00" is refused rather than read
 * as UTC or as server time.
 */

const ISO_WITH_OFFSET =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

interface Fields {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			weekday: 'long'
		});
		formatters.set(timeZone, f);
	}
	return f;
}

function wallClock(ms: number, timeZone: string): Fields & { weekday: string } {
	const parts = Object.fromEntries(
		formatter(timeZone)
			.formatToParts(new Date(ms))
			.map((p) => [p.type, p.value])
	);
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		hour: Number(parts.hour) % 24,
		minute: Number(parts.minute),
		second: Number(parts.second),
		weekday: parts.weekday
	};
}

const asUtc = (f: Fields) => Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
const offsetAt = (ms: number, timeZone: string) =>
	asUtc(wallClock(Math.floor(ms / 1000) * 1000, timeZone)) - Math.floor(ms / 1000) * 1000;

function validFields(f: Fields): boolean {
	const probe = new Date(asUtc(f));
	return (
		f.month >= 1 &&
		f.month <= 12 &&
		f.hour < 24 &&
		f.minute < 60 &&
		f.second < 60 &&
		probe.getUTCDate() === f.day &&
		probe.getUTCMonth() === f.month - 1
	);
}

export type LocalResolution =
	| { ok: true; utc: Date }
	| { ok: false; reason: 'invalid' | 'nonexistent' | 'ambiguous'; candidates: Date[] };

/**
 * A wall-clock time in a zone, as an instant. A time skipped by a DST jump
 * does not exist, and one repeated when the clocks go back exists twice:
 * both are refused with what the caller could mean, never guessed.
 */
export function zonedLocalToUtc(local: string, timeZone: string): LocalResolution {
	const m = LOCAL.exec(local.trim());
	if (!m) return { ok: false, reason: 'invalid', candidates: [] };
	const fields: Fields = {
		year: Number(m[1]),
		month: Number(m[2]),
		day: Number(m[3]),
		hour: Number(m[4]),
		minute: Number(m[5]),
		second: Number(m[6] ?? 0)
	};
	if (!validFields(fields)) return { ok: false, reason: 'invalid', candidates: [] };
	const naive = asUtc(fields);
	const offsets = new Set(
		[-36, -12, 0, 12, 36].map((h) => offsetAt(naive + h * 3_600_000, timeZone))
	);
	const matches = new Set<number>();
	for (const offset of offsets) {
		const candidate = naive - offset;
		if (asUtc(wallClock(candidate, timeZone)) === naive) matches.add(candidate);
	}
	const found = [...matches].sort((a, b) => a - b).map((ms) => new Date(ms));
	if (found.length === 1) return { ok: true, utc: found[0] };
	if (found.length > 1) return { ok: false, reason: 'ambiguous', candidates: found };
	// In a gap: the instants just before and after it, an hour apart.
	const before = naive - offsetAt(naive - 12 * 3_600_000, timeZone);
	const after = naive - offsetAt(naive + 12 * 3_600_000, timeZone);
	return {
		ok: false,
		reason: 'nonexistent',
		candidates: [new Date(Math.min(before, after)), new Date(Math.max(before, after))]
	};
}

function pad(n: number, width = 2) {
	return String(Math.abs(n)).padStart(width, '0');
}

function offsetLabel(offsetMs: number): string {
	const minutes = Math.round(offsetMs / 60_000);
	return `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
}

export interface InstantView {
	utc: string;
	/** ISO 8601 in the zone, with its offset: `2026-11-03T09:00:00+01:00`. */
	local: string;
	weekday: string;
	timeZone: string;
	/** `Tuesday 2026-11-03 09:00 (Europe/Berlin, UTC+01:00)`. */
	display: string;
}

export function describeInstant(at: Date | number, timeZone: string): InstantView {
	const ms = typeof at === 'number' ? at : at.getTime();
	const f = wallClock(ms, timeZone);
	const offset = offsetLabel(offsetAt(ms, timeZone));
	const date = `${f.year}-${pad(f.month)}-${pad(f.day)}`;
	const time = `${pad(f.hour)}:${pad(f.minute)}`;
	return {
		utc: new Date(ms).toISOString(),
		local: `${date}T${time}:${pad(f.second)}${offset}`,
		weekday: f.weekday,
		timeZone,
		display: `${f.weekday} ${date} ${time} (${timeZone}, UTC${offset})`
	};
}

/** The operator's zone, or UTC when the stored one is not a zone the runtime knows. */
export function operatorZone(raw: string | null | undefined): string {
	return parseTimeZone(raw) ?? 'UTC';
}

export type RunAtInput = string | { localTime: string; timeZone: string };

export type RunAtResult =
	| { ok: true; now: true; utc: Date }
	| { ok: true; now: false; utc: Date }
	| { ok: false; message: string };

/**
 * `runAt` as a tool takes it: an ISO 8601 instant with `Z` or an offset,
 * `{ localTime, timeZone }`, or the word `now`. Every refusal says what the
 * server's clock reads and in which zone, so the agent can redo its maths.
 */
export function parseRunAt(input: RunAtInput, now: Date, operatorTimeZone: string): RunAtResult {
	const clock = `Server now: ${describeInstant(now, operatorTimeZone).display}, ${now.toISOString()} UTC.`;
	const example = `Send "2026-11-03T09:00:00+01:00" or {"localTime": "2026-11-03T09:00", "timeZone": "${operatorTimeZone}"}.`;
	let utc: Date;
	if (typeof input === 'string') {
		const raw = input.trim();
		if (raw.toLowerCase() === 'now') return { ok: true, now: true, utc: now };
		if (!ISO_WITH_OFFSET.test(raw)) {
			const zoneless = LOCAL.test(raw);
			return {
				ok: false,
				message: zoneless
					? `runAt "${raw}" has no time zone, so it could mean any of 24 instants. Add an offset or send localTime with timeZone. ${example} ${clock}`
					: `runAt "${raw}" is not an ISO 8601 date-time. ${example} ${clock}`
			};
		}
		utc = new Date(raw);
		if (Number.isNaN(utc.getTime()))
			return { ok: false, message: `runAt "${raw}" is not a real date. ${example} ${clock}` };
	} else {
		const zone = parseTimeZone(input.timeZone);
		if (!zone)
			return {
				ok: false,
				message: `timeZone "${input.timeZone}" is not an IANA time zone such as "Europe/Berlin" or "America/New_York". ${clock}`
			};
		const resolved = zonedLocalToUtc(input.localTime, zone);
		if (!resolved.ok) {
			const options = resolved.candidates
				.map((d) => `"${describeInstant(d, zone).local}"`)
				.join(' or ');
			const message =
				resolved.reason === 'invalid'
					? `localTime "${input.localTime}" must look like "2026-11-03T09:00" (no offset; the zone comes from timeZone).`
					: resolved.reason === 'ambiguous'
						? `${input.localTime} happens twice in ${zone} (the clocks go back). Send the one you mean with its offset: ${options}.`
						: `${input.localTime} does not exist in ${zone} (the clocks jump forward). Pick a time outside the gap, for example ${options}.`;
			return { ok: false, message: `${message} ${clock}` };
		}
		utc = resolved.utc;
	}
	if (utc.getTime() < now.getTime() - SCHEDULE_PAST_GRACE_MS) {
		return {
			ok: false,
			message: `runAt ${describeInstant(utc, operatorTimeZone).display} is in the past. ${clock} Use "now" to publish immediately (needs confirmation).`
		};
	}
	if (utc.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) {
		return { ok: false, message: `runAt must be within the next year. ${clock}` };
	}
	return { ok: true, now: false, utc };
}
