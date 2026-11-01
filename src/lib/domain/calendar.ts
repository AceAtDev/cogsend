import { isTargetSending } from './post-state';
import { localDayKey } from './insights';
import { UNBRANDED_SLUG } from './channel-keys';
import { PROCESSING_MARK } from './video-rules';

/**
 * Calendar date math. Days are the operator's days (`users.timezone`), keyed
 * YYYY-MM-DD; a key is a wall-calendar date, so arithmetic on keys is done in
 * UTC, where no day is 23 or 25 hours long. Only the edges of a range and a
 * dropped slot are turned back into instants, through `zonedToUtc`.
 */

export type CalendarView = 'week' | 'month';

export const DAY_MS = 86_400_000;
/** Weeks start on Monday (ISO 8601). */
export const WEEK_STARTS_ON = 1;

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isDateKey(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	const m = KEY_RE.exec(value);
	if (!m) return false;
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (y < 2000 || y > 2100) return false;
	const date = new Date(Date.UTC(y, mo - 1, d));
	return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function keyToUtc(key: string): number {
	const [y, m, d] = key.split('-').map(Number);
	return Date.UTC(y, m - 1, d);
}

function utcToKey(ms: number): string {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(
		d.getUTCDate()
	).padStart(2, '0')}`;
}

export function addDays(key: string, n: number): string {
	return utcToKey(keyToUtc(key) + n * DAY_MS);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekday(key: string): number {
	return new Date(keyToUtc(key)).getUTCDay();
}

export function weekStart(key: string, startsOn = WEEK_STARTS_ON): string {
	return addDays(key, -((weekday(key) - startsOn + 7) % 7));
}

export function monthStart(key: string): string {
	return `${key.slice(0, 7)}-01`;
}

export function addMonths(key: string, n: number): string {
	const [y, m] = key.split('-').map(Number);
	const d = new Date(Date.UTC(y, m - 1 + n, 1));
	return utcToKey(d.getTime());
}

/** Whole weeks covering the month of `key`: 4 to 6 rows of 7 keys. */
export function monthGrid(key: string, startsOn = WEEK_STARTS_ON): string[][] {
	const first = monthStart(key);
	const last = addDays(addMonths(first, 1), -1);
	const weeks: string[][] = [];
	for (let day = weekStart(first, startsOn); day <= last; day = addDays(day, 7)) {
		weeks.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
	}
	return weeks;
}

export type VisibleRange = {
	/** First day shown. */
	start: string;
	/** Day after the last one shown. */
	end: string;
	days: string[];
};

export function visibleRange(view: CalendarView, anchor: string): VisibleRange {
	if (view === 'month') {
		const days = monthGrid(anchor).flat();
		return { start: days[0], end: addDays(days[days.length - 1], 1), days };
	}
	const start = weekStart(anchor);
	const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
	return { start, end: addDays(start, 7), days };
}

export function shiftAnchor(view: CalendarView, anchor: string, direction: -1 | 1): string {
	if (view === 'month') return addMonths(monthStart(anchor), direction);
	return addDays(weekStart(anchor), 7 * direction);
}

const partFormatters = new Map<string, Intl.DateTimeFormat>();

function partFormatter(timeZone: string): Intl.DateTimeFormat {
	let fmt = partFormatters.get(timeZone);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
		partFormatters.set(timeZone, fmt);
	}
	return fmt;
}

/** A zone the runtime accepts, else UTC: a bad stored value must not break the page. */
export function safeTimeZone(timeZone: string | null | undefined): string {
	if (!timeZone) return 'UTC';
	try {
		partFormatter(timeZone);
		return timeZone;
	} catch {
		return 'UTC';
	}
}

/** The wall-clock date and minute of the day of an instant in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): { key: string; minutes: number } {
	const parts = partFormatter(timeZone).formatToParts(new Date(ms));
	const n = (type: Intl.DateTimeFormatPartTypes) =>
		Number(parts.find((p) => p.type === type)?.value ?? '0');
	// Some engines say 24:00 for midnight even with h23.
	const hour = n('hour') % 24;
	const key = `${n('year')}-${String(n('month')).padStart(2, '0')}-${String(n('day')).padStart(2, '0')}`;
	return { key, minutes: hour * 60 + n('minute') };
}

/** The operator's calendar date of an instant. */
export function dayKeyOf(ms: number, timeZone: string): string {
	return localDayKey(ms, timeZone);
}

function wallMs(ms: number, timeZone: string): number {
	const { key, minutes } = zonedParts(ms, timeZone);
	return keyToUtc(key) + minutes * 60_000;
}

/**
 * The instant at wall-clock `minutes` past midnight on `key` in `timeZone`.
 *
 * Around a DST change a wall time can happen twice (the November fall-back
 * hour) or never (the March spring-forward hour). A repeated time resolves to
 * its first occurrence; a missing one moves forward by the length of the gap
 * (2:30 becomes 3:30), which is what a person who picked 2:30 most likely
 * meant and never lands before what they asked for.
 */
export function zonedToUtc(key: string, minutes: number, timeZone: string): number {
	const wall = keyToUtc(key) + minutes * 60_000;
	const offsetAt = (ms: number) => wallMs(ms, timeZone) - Math.floor(ms / 60_000) * 60_000;
	// Offsets a day either side bracket at most one transition.
	const before = offsetAt(wall - DAY_MS);
	const after = offsetAt(wall + DAY_MS);
	const candidates = [...new Set([wall - before, wall - after])].sort((a, b) => a - b);
	const exact = candidates.find((ms) => wallMs(ms, timeZone) === wall);
	return exact ?? wall - before;
}

/** UTC instants bounding [start, end) of a visible range. */
export function rangeBounds(range: Pick<VisibleRange, 'start' | 'end'>, timeZone: string) {
	return {
		startMs: zonedToUtc(range.start, 0, timeZone),
		endMs: zonedToUtc(range.end, 0, timeZone)
	};
}

export type CalendarStatus =
	| 'review'
	| 'rejected'
	| 'scheduled'
	| 'due'
	| 'sending'
	| 'processing'
	| 'published'
	| 'failed'
	| 'cancelled';

export const CALENDAR_STATUSES: CalendarStatus[] = [
	'review',
	'rejected',
	'scheduled',
	'due',
	'sending',
	'processing',
	'published',
	'failed',
	'cancelled'
];

export type TargetStatusInput = {
	status: string;
	scheduledFor: number | Date | null;
	updatedAt: number | Date | null;
	errorMessage?: string | null;
	jobId?: string | null;
	remotePostId?: string | null;
};

function ms(value: number | Date | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	return value instanceof Date ? value.getTime() : value;
}

/**
 * One publish target's state as the calendar draws it. Mirrors the Posts page:
 * what went out wins, then what is going out now; `due` is a scheduled time
 * that has passed (or a publish-now row) and is waiting for the next tick.
 */
export function calendarStatus(t: TargetStatusInput, now: Date = new Date()): CalendarStatus {
	if (t.status === 'published' || t.remotePostId) return 'published';
	if (t.status === 'cancelled') return 'cancelled';
	// Held: it keeps its slot on the grid but never goes out on its own.
	if (t.status === 'awaiting_review') return 'review';
	if (t.status === 'rejected') return 'rejected';
	if (
		isTargetSending(
			{
				status: t.status,
				jobId: t.jobId ?? null,
				updatedAt: ms(t.updatedAt),
				remotePostId: t.remotePostId ?? null
			},
			now
		)
	)
		return 'sending';
	if (t.status === 'failed') return 'failed';
	if (t.status === 'scheduled' && (t.errorMessage ?? '').includes(PROCESSING_MARK))
		return 'processing';
	if (t.status !== 'scheduled') return 'due';
	const at = ms(t.scheduledFor);
	return at === null || at <= now.getTime() ? 'due' : 'scheduled';
}

/** Where an item sits on the calendar: its schedule, or when it last changed. */
export function itemInstant(t: Pick<TargetStatusInput, 'scheduledFor' | 'updatedAt'>): number {
	return ms(t.scheduledFor) ?? ms(t.updatedAt) ?? 0;
}

/** Only a time that is still waiting can move; the rest have happened or are happening. */
export function canDrag(status: CalendarStatus): boolean {
	return status === 'scheduled' || status === 'due';
}

/** What the detail panel offers, matching the Posts page for the same state. */
export function itemActions(
	status: CalendarStatus
): Array<'reschedule' | 'cancel' | 'retry' | 'review'> {
	if (status === 'review') return ['review', 'cancel'];
	if (status === 'rejected') return ['cancel'];
	if (status === 'scheduled' || status === 'due') return ['reschedule', 'cancel'];
	if (status === 'failed') return ['retry', 'cancel'];
	return [];
}

/**
 * The new instant for an item dropped on `day`. A week-view slot names the
 * hour and keeps the item's minutes; a month-view day keeps its whole time.
 */
export function droppedInstant(
	itemMs: number,
	drop: { day: string; hour?: number | null },
	timeZone: string
): number {
	const { minutes } = zonedParts(itemMs, timeZone);
	const at =
		drop.hour === null || drop.hour === undefined ? minutes : drop.hour * 60 + (minutes % 60);
	return zonedToUtc(drop.day, at, timeZone);
}

/** The body `POST /api/targets/bulk` takes to move targets, as the Posts page sends it. */
export function reschedulePayload(ids: string[], runAtMs: number) {
	return { op: 'reschedule' as const, ids, runAt: new Date(runAtMs).toISOString() };
}

/** `YYYY-MM-DDTHH:MM` for an `<input type="datetime-local">` showing the operator's wall time. */
export function toZonedInputValue(instant: number, timeZone: string): string {
	const { key, minutes } = zonedParts(instant, timeZone);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${key}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** The inverse of toZonedInputValue, or null for a value that is not one. */
export function fromZonedInputValue(value: string, timeZone: string): number | null {
	const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
	if (!m || !isDateKey(m[1])) return null;
	const hour = Number(m[2]);
	const minute = Number(m[3]);
	if (hour > 23 || minute > 59) return null;
	return zonedToUtc(m[1], hour * 60 + minute, timeZone);
}

export type CalendarQuery = {
	view: CalendarView;
	date: string;
	/** Brand slugs, `unbranded` included. Empty means every brand. */
	brands: string[];
	/** Channel keys. Empty means every channel. */
	channels: string[];
	cancelled: boolean;
};

const MAX_FILTER_VALUES = 50;

function listParam(params: URLSearchParams, name: string): string[] {
	const values = params
		.getAll(name)
		.flatMap((v) => v.split(','))
		.map((v) => v.trim().toLowerCase())
		.filter((v) => v && v.length <= 120);
	return [...new Set(values)].slice(0, MAX_FILTER_VALUES);
}

export function parseCalendarQuery(params: URLSearchParams, today: string): CalendarQuery {
	const date = params.get('date');
	return {
		view: params.get('view') === 'month' ? 'month' : 'week',
		date: isDateKey(date) ? date : today,
		brands: listParam(params, 'brand'),
		channels: listParam(params, 'channel'),
		cancelled: params.get('cancelled') === '1'
	};
}

/** The calendar's address for a query, leaving out what is already the default. */
export function calendarHref(query: CalendarQuery, today: string): string {
	const params = new URLSearchParams();
	if (query.view !== 'week') params.set('view', query.view);
	if (query.date !== today) params.set('date', query.date);
	if (query.brands.length) params.set('brand', query.brands.join(','));
	if (query.channels.length) params.set('channel', query.channels.join(','));
	if (query.cancelled) params.set('cancelled', '1');
	const qs = params.toString();
	return qs ? `/calendar?${qs}` : '/calendar';
}

export type FilterableChannel = { connectionId: string; key: string; brandSlug: string };

/**
 * The connections a brand/channel filter shows, or null for "all". Brand and
 * channel chips add up: picking the JobJob brand and the 465cal.tiktok channel
 * shows both, which is what ticking chips in two rows reads like.
 */
export function filteredConnectionIds(
	channels: FilterableChannel[],
	filter: Pick<CalendarQuery, 'brands' | 'channels'>
): Set<string> | null {
	if (!filter.brands.length && !filter.channels.length) return null;
	const brands = new Set(filter.brands);
	const keys = new Set(filter.channels);
	return new Set(
		channels
			.filter((c) => brands.has(c.brandSlug || UNBRANDED_SLUG) || (c.key && keys.has(c.key)))
			.map((c) => c.connectionId)
	);
}

export function toggleValue(list: string[], value: string): string[] {
	return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export const STATUS_LABEL: Record<CalendarStatus, string> = {
	review: 'Awaiting review',
	rejected: 'Rejected',
	scheduled: 'Scheduled',
	due: 'Due',
	sending: 'Sending',
	processing: 'Processing',
	published: 'Published',
	failed: 'Failed',
	cancelled: 'Cancelled'
};

const displayFormatters = new Map<string, Intl.DateTimeFormat>();

function displayFormatter(timeZone: string, options: Intl.DateTimeFormatOptions) {
	const id = `${timeZone}|${JSON.stringify(options)}`;
	let fmt = displayFormatters.get(id);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat(undefined, { ...options, timeZone });
		displayFormatters.set(id, fmt);
	}
	return fmt;
}

/** "3:05 PM" in the operator's zone. */
export function formatTime(instant: number, timeZone: string): string {
	return displayFormatter(timeZone, { hour: 'numeric', minute: '2-digit' }).format(instant);
}

/** "Tue, Oct 27, 3:05 PM EDT" in the operator's zone. */
export function formatDateTime(instant: number, timeZone: string): string {
	return displayFormatter(timeZone, {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZoneName: 'short'
	}).format(instant);
}

/** A day key as words. The key already is the local date, so it is formatted in UTC. */
export function formatDay(key: string, style: 'short' | 'long' | 'weekday' = 'short'): string {
	const options: Intl.DateTimeFormatOptions =
		style === 'long'
			? { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }
			: style === 'weekday'
				? { weekday: 'short' }
				: { weekday: 'short', month: 'short', day: 'numeric' };
	return displayFormatter('UTC', options).format(keyToUtc(key) + 12 * 3_600_000);
}

/** "Oct 26 – Nov 1, 2026" for a week, "November 2026" for a month. */
export function rangeLabel(view: CalendarView, range: VisibleRange, anchor: string): string {
	const noon = (key: string) => keyToUtc(key) + 12 * 3_600_000;
	if (view === 'month') {
		return displayFormatter('UTC', { month: 'long', year: 'numeric' }).format(
			noon(monthStart(anchor))
		);
	}
	const last = addDays(range.end, -1);
	return displayFormatter('UTC', { month: 'short', day: 'numeric', year: 'numeric' }).formatRange(
		noon(range.start),
		noon(last)
	);
}

/** The local hour (0–23) an instant falls in, for the week grid's rows. */
export function zonedHour(instant: number, timeZone: string): number {
	return Math.floor(zonedParts(instant, timeZone).minutes / 60);
}

export type CalendarBrand = { id: string | null; name: string; slug: string; color: string };

export type CalendarChannel = {
	connectionId: string;
	/** Empty for a disconnected account, which no longer has a key. */
	key: string;
	platform: string;
	platformName: string;
	handle: string | null;
	displayName: string | null;
	status: string;
	brand: CalendarBrand;
};

export type CalendarItem = {
	id: string;
	draftId: string;
	connectionId: string;
	status: CalendarStatus;
	/** Where it sits: the schedule, else when it last changed (ms). */
	at: number;
	scheduledFor: number | null;
	retrying: boolean;
	remoteUrl: string | null;
	errorMessage: string | null;
	/** The text this account gets: its platform version, else the post's. */
	text: string;
	mediaCount: number;
};

export type CalendarMedia = {
	id: string;
	storageKey: string;
	mime: string;
	width: number | null;
	height: number | null;
	altText: string | null;
	meta: Record<string, unknown> | null;
};

/** A draft with no time yet, for the side list. */
export type CalendarDraft = {
	id: string;
	title: string | null;
	body: string;
	updatedAt: number;
	mediaCount: number;
};
