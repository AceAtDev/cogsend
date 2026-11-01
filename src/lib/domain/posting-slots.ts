import { addDays, dayKeyOf, weekday, zonedToUtc } from './calendar';

/**
 * Posting slots and cadence limits for one account. Slots are wall-clock times
 * in the operator's zone on days of the week, so "Monday 09:00" stays 09:00
 * across a DST change; limits cap how many posts go out on one local day and
 * how close two may be. The planner below is what an agent's `next_slot`, the
 * limit checks and the calendar's open slots all read, so they cannot disagree.
 */

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABEL: Record<Weekday, string> = {
	mon: 'Monday',
	tue: 'Tuesday',
	wed: 'Wednesday',
	thu: 'Thursday',
	fri: 'Friday',
	sat: 'Saturday',
	sun: 'Sunday'
};

export type WeeklySlots = Partial<Record<Weekday, string[]>>;

export interface PostingRules {
	slots: WeeklySlots;
	maxPerDay: number | null;
	minGapMinutes: number | null;
}

export const MAX_SLOTS_PER_DAY = 24;
export const MAX_POSTS_PER_DAY = 50;
export const MAX_GAP_MINUTES = 1440;
/**
 * A post this close to a slot fills it, even with no minimum gap: a post a
 * person dropped at 09:05 takes the 09:00 slot rather than leaving an agent to
 * put another one beside it.
 */
export const SLOT_TOLERANCE_MINUTES = 15;
/** How far ahead `next_slot` looks before it gives up. */
export const SLOT_HORIZON_DAYS = 60;
/** A slot closer than this to now is already gone: a tick could not send it on time. */
export const SLOT_LEAD_MS = 60_000;

const MINUTE = 60_000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const EMPTY_RULES: PostingRules = { slots: {}, maxPerDay: null, minGapMinutes: null };

export function isSlotTime(value: unknown): value is string {
	return typeof value === 'string' && TIME_RE.test(value);
}

function minutesOf(time: string): number {
	const m = TIME_RE.exec(time)!;
	return Number(m[1]) * 60 + Number(m[2]);
}

/** 0 = Monday … 6 = Sunday, from a YYYY-MM-DD key. */
export function weekdayOfKey(key: string): Weekday {
	return WEEKDAYS[(weekday(key) + 6) % 7];
}

export type RulesResult = { ok: true; rules: PostingRules } | { ok: false; error: string };

function limitValue(raw: unknown, field: string, max: number, min: number) {
	if (raw === null || raw === undefined || raw === '') return { value: null };
	const n = typeof raw === 'string' ? Number(raw) : raw;
	if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
		return { error: `${field} must be a whole number from ${min} to ${max}, or null for no limit` };
	return { value: n };
}

/**
 * `{ slots: { mon: ["09:00", "18:00"], … }, maxPerDay, minGapMinutes }`.
 * Times are sorted and deduplicated; a day with no times is dropped.
 */
export function parsePostingRules(raw: unknown): RulesResult {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		return { ok: false, error: 'Send an object with slots, maxPerDay and minGapMinutes' };
	const body = raw as Record<string, unknown>;
	for (const key of Object.keys(body))
		if (!['slots', 'maxPerDay', 'minGapMinutes'].includes(key))
			return { ok: false, error: `Unknown field "${key}"` };
	const slots: WeeklySlots = {};
	const rawSlots = body.slots ?? {};
	if (!rawSlots || typeof rawSlots !== 'object' || Array.isArray(rawSlots))
		return { ok: false, error: 'slots must map days (mon … sun) to lists of "HH:MM" times' };
	for (const [day, times] of Object.entries(rawSlots as Record<string, unknown>)) {
		if (!(WEEKDAYS as readonly string[]).includes(day))
			return { ok: false, error: `"${day}" is not a day; use ${WEEKDAYS.join(', ')}` };
		if (!Array.isArray(times)) return { ok: false, error: `slots.${day} must be a list of times` };
		for (const time of times)
			if (!isSlotTime(time))
				return {
					ok: false,
					error: `slots.${day}: "${String(time)}" is not a 24-hour "HH:MM" time`
				};
		const unique = [...new Set(times as string[])].sort();
		if (unique.length > MAX_SLOTS_PER_DAY)
			return { ok: false, error: `slots.${day} takes at most ${MAX_SLOTS_PER_DAY} times` };
		if (unique.length) slots[day as Weekday] = unique;
	}
	const max = limitValue(body.maxPerDay, 'maxPerDay', MAX_POSTS_PER_DAY, 1);
	if ('error' in max) return { ok: false, error: max.error! };
	const gap = limitValue(body.minGapMinutes, 'minGapMinutes', MAX_GAP_MINUTES, 1);
	if ('error' in gap) return { ok: false, error: gap.error! };
	return { ok: true, rules: { slots, maxPerDay: max.value, minGapMinutes: gap.value } };
}

/** Lenient read of a stored row: anything unreadable counts as no rule. */
export function rulesFromStored(
	slotsJson: string | null | undefined,
	maxPerDay: number | null,
	minGapMinutes: number | null
): PostingRules {
	const slots = (() => {
		try {
			return JSON.parse(slotsJson || '{}') as unknown;
		} catch {
			return {};
		}
	})();
	const parsed = parsePostingRules({ slots, maxPerDay, minGapMinutes });
	return parsed.ok ? parsed.rules : EMPTY_RULES;
}

export function slotCount(slots: WeeklySlots): number {
	return WEEKDAYS.reduce((n, day) => n + (slots[day]?.length ?? 0), 0);
}

export function hasRules(rules: PostingRules | undefined): boolean {
	return Boolean(
		rules && (slotCount(rules.slots) || rules.maxPerDay !== null || rules.minGapMinutes !== null)
	);
}

/** "Mon–Fri 09:00, 18:00; Sat 10:00": runs of days with the same times are joined. */
export function describeSlots(slots: WeeklySlots): string {
	const parts: string[] = [];
	let i = 0;
	while (i < WEEKDAYS.length) {
		const times = slots[WEEKDAYS[i]] ?? [];
		if (!times.length) {
			i++;
			continue;
		}
		let j = i;
		while (j + 1 < WEEKDAYS.length && (slots[WEEKDAYS[j + 1]] ?? []).join(',') === times.join(','))
			j++;
		const label = (d: Weekday) => d.charAt(0).toUpperCase() + d.slice(1);
		const days = i === j ? label(WEEKDAYS[i]) : `${label(WEEKDAYS[i])}–${label(WEEKDAYS[j])}`;
		parts.push(`${days} ${times.join(', ')}`);
		i = j + 1;
	}
	return parts.join('; ');
}

export function describeRules(rules: PostingRules): string {
	const parts = [];
	parts.push(slotCount(rules.slots) ? describeSlots(rules.slots) : 'no slots');
	if (rules.maxPerDay !== null) parts.push(`max ${rules.maxPerDay}/day`);
	if (rules.minGapMinutes !== null) parts.push(`${rules.minGapMinutes} min apart`);
	return parts.join(', ');
}

/**
 * The instants of one local day's slots. A slot inside a spring-forward gap
 * moves forward by the gap and one in a repeated hour takes its first
 * occurrence (see zonedToUtc), so two slots can land on one instant: kept once.
 */
export function slotInstantsOn(slots: WeeklySlots, dayKey: string, timeZone: string): number[] {
	const times = slots[weekdayOfKey(dayKey)] ?? [];
	const instants = new Set(times.map((t) => zonedToUtc(dayKey, minutesOf(t), timeZone)));
	return [...instants].sort((a, b) => a - b);
}

export type LimitViolation =
	| { code: 'max_per_day'; day: string; limit: number; count: number }
	| { code: 'min_gap'; gapMinutes: number; conflictAt: number };

/**
 * One request's view of every account's rules and the posts already on them.
 * Reserving a time makes later questions see it, which is how two posts of one
 * batch never get the same slot.
 */
export class SlotPlanner {
	readonly timeZone: string;
	readonly now: number;
	private rules: Map<string, PostingRules>;
	private occupied: Map<string, number[]>;
	private dayKeys = new Map<number, string>();

	constructor(opts: {
		timeZone: string;
		now: number;
		rules: Map<string, PostingRules>;
		occupied: Map<string, number[]>;
	}) {
		this.timeZone = opts.timeZone;
		this.now = opts.now;
		this.rules = opts.rules;
		this.occupied = new Map([...opts.occupied].map(([id, list]) => [id, [...list]]));
	}

	rulesFor(id: string): PostingRules {
		return this.rules.get(id) ?? EMPTY_RULES;
	}

	hasSlots(id: string): boolean {
		return slotCount(this.rulesFor(id).slots) > 0;
	}

	reserve(id: string, at: number) {
		const list = this.occupied.get(id) ?? [];
		list.push(at);
		this.occupied.set(id, list);
	}

	private dayKey(ms: number): string {
		let key = this.dayKeys.get(ms);
		if (!key) {
			key = dayKeyOf(ms, this.timeZone);
			this.dayKeys.set(ms, key);
		}
		return key;
	}

	postsOnDay(id: string, dayKey: string): number {
		return (this.occupied.get(id) ?? []).filter((t) => this.dayKey(t) === dayKey).length;
	}

	/** The limit `at` would break on this account, or null. */
	violation(id: string, at: number): LimitViolation | null {
		const rules = this.rulesFor(id);
		if (rules.maxPerDay !== null) {
			const day = this.dayKey(at);
			const count = this.postsOnDay(id, day);
			if (count >= rules.maxPerDay)
				return { code: 'max_per_day', day, limit: rules.maxPerDay, count };
		}
		if (rules.minGapMinutes !== null) {
			const gap = rules.minGapMinutes * MINUTE;
			const conflict = (this.occupied.get(id) ?? []).find((t) => Math.abs(t - at) < gap);
			if (conflict !== undefined)
				return { code: 'min_gap', gapMinutes: rules.minGapMinutes, conflictAt: conflict };
		}
		return null;
	}

	/** Whether a slot instant is still open: in time, not taken, inside the limits. */
	isOpen(id: string, at: number): boolean {
		if (at < this.now + SLOT_LEAD_MS) return false;
		const tolerance = SLOT_TOLERANCE_MINUTES * MINUTE;
		if ((this.occupied.get(id) ?? []).some((t) => Math.abs(t - at) < tolerance)) return false;
		return this.violation(id, at) === null;
	}

	/** Open slots in [fromMs, toMs), earliest first. */
	openSlots(id: string, fromMs: number, toMs: number, limit = Infinity): number[] {
		const { slots } = this.rulesFor(id);
		if (!slotCount(slots) || toMs <= fromMs) return [];
		const out: number[] = [];
		const lastKey = this.dayKey(toMs);
		for (let key = addDays(this.dayKey(fromMs), -1); key <= lastKey; key = addDays(key, 1)) {
			for (const at of slotInstantsOn(slots, key, this.timeZone)) {
				if (at < fromMs || at >= toMs || !this.isOpen(id, at)) continue;
				out.push(at);
				if (out.length >= limit) return out;
			}
		}
		return out;
	}

	/** Every slot instant in [fromMs, toMs), open or not. */
	allSlots(id: string, fromMs: number, toMs: number): number[] {
		const { slots } = this.rulesFor(id);
		if (!slotCount(slots) || toMs <= fromMs) return [];
		const out: number[] = [];
		const lastKey = this.dayKey(toMs);
		for (let key = addDays(this.dayKey(fromMs), -1); key <= lastKey; key = addDays(key, 1))
			for (const at of slotInstantsOn(slots, key, this.timeZone))
				if (at >= fromMs && at < toMs) out.push(at);
		return out;
	}

	/** The first open slot at or after `after`, within the horizon. */
	nextOpenSlot(id: string, after: number): number | null {
		const from = Math.max(after, this.now + SLOT_LEAD_MS);
		const [found] = this.openSlots(id, from, from + SLOT_HORIZON_DAYS * 86_400_000, 1);
		return found ?? null;
	}

	/**
	 * The earliest instant at or after `at` that breaks no limit, ignoring
	 * slots: past a full day to the next local midnight, past a too-close post
	 * to the end of its gap, until nothing objects.
	 */
	nextAllowed(id: string, at: number): number | null {
		const horizon = at + SLOT_HORIZON_DAYS * 86_400_000;
		let candidate = Math.max(at, this.now + SLOT_LEAD_MS);
		for (let step = 0; step < 1000 && candidate < horizon; step++) {
			const v = this.violation(id, candidate);
			if (!v) return candidate;
			candidate =
				v.code === 'max_per_day'
					? zonedToUtc(addDays(v.day, 1), 0, this.timeZone)
					: v.conflictAt + v.gapMinutes * MINUTE;
		}
		return null;
	}
}
