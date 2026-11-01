import { addDays, isDateKey, zonedToUtc } from '#lib/domain/calendar.js';
import {
	briefMarkdown,
	briefSummary,
	BRIEF_SECTIONS,
	type BrandBrief
} from '#lib/domain/brand-brief.js';
import {
	candidateLines,
	resolveChannelRef,
	UNBRANDED_SLUG,
	type BrandRef,
	type Channel,
	type ChannelRef
} from '#lib/domain/channel-keys.js';
import { isPlatformId, platformName } from '#lib/domain/platforms.js';
import {
	describeRules,
	describeSlots,
	hasRules,
	SLOT_HORIZON_DAYS,
	slotCount,
	type LimitViolation,
	type PostingRules,
	type SlotPlanner
} from '#lib/domain/posting-slots.js';
import {
	describeInstant,
	parseRunAt,
	type InstantView,
	type RunAtInput
} from '#lib/domain/zoned-time.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import { loadBriefs, type StoredBrief } from '#lib/server/brand-briefs.js';
import { loadChannels } from '#lib/server/brands.js';
import { createSlotPlanner, loadPostingRules, serializeRules } from '#lib/server/posting-slots.js';
import type { OperationContext } from '#lib/server/api/operations.js';

/**
 * Brand briefs and posting slots as an agent meets them: `get_brand_brief`,
 * `list_slots`, the `next_slot` time, and the cadence checks every scheduling
 * tool runs before it writes.
 */

interface AgentLike {
	ctx: OperationContext;
	userId: string;
	timeZone: string;
	now: Date;
}

const DAY_MS = 86_400_000;

export type SlotRunAt = { slot: 'next'; after?: string };
export type AgentRunAt = RunAtInput | SlotRunAt;

export type ParsedAgentRunAt =
	| { ok: true; kind: 'now'; utc: Date }
	| { ok: true; kind: 'at'; utc: Date }
	| { ok: true; kind: 'slot'; after: Date }
	| { ok: false; message: string };

export function isSlotRunAt(input: AgentRunAt): boolean {
	if (typeof input === 'string') return input.trim().toLowerCase() === 'next_slot';
	return 'slot' in input;
}

const OFFSET_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i;

/** A day (`2026-11-10`, from its midnight in the operator's zone) or an instant with an offset. */
function parseAfter(raw: string, timeZone: string): Date | null {
	const value = raw.trim();
	if (isDateKey(value)) return new Date(zonedToUtc(value, 0, timeZone));
	if (!OFFSET_TIME.test(value)) return null;
	const at = new Date(value);
	return Number.isNaN(at.getTime()) ? null : at;
}

/** `runAt` with the slot forms added: `"next_slot"` or `{ "slot": "next", "after": … }`. */
export function parseAgentRunAt(input: AgentRunAt, now: Date, timeZone: string): ParsedAgentRunAt {
	if (isSlotRunAt(input)) {
		const after = typeof input === 'object' && 'slot' in input ? input.after : undefined;
		if (after === undefined) return { ok: true, kind: 'slot', after: now };
		const at = parseAfter(after, timeZone);
		if (!at)
			return {
				ok: false,
				message: `after "${after}" must be a day such as "2026-11-10" (from midnight in ${timeZone}) or an ISO 8601 time with an offset.`
			};
		return { ok: true, kind: 'slot', after: at.getTime() < now.getTime() ? now : at };
	}
	const parsed = parseRunAt(input as RunAtInput, now, timeZone);
	if (!parsed.ok) return parsed;
	return parsed.now
		? { ok: true, kind: 'now', utc: parsed.utc }
		: { ok: true, kind: 'at', utc: parsed.utc };
}

export interface LimitRefusal {
	label: string;
	channel: string;
	code: LimitViolation['code'];
	requested: InstantView;
	nextAllowed: InstantView | null;
	nextSlot: InstantView | null;
}

/**
 * Why `at` breaks this account's cadence, with the next time that would not,
 * or null when it is fine. Never reserves: the caller does that on success.
 */
export function limitRefusal(
	planner: SlotPlanner,
	channel: Channel,
	at: number,
	label: string
): { line: string; refusal: LimitRefusal } | null {
	const v = planner.violation(channel.connectionId, at);
	if (!v) return null;
	const tz = planner.timeZone;
	const nextAllowed = planner.nextAllowed(channel.connectionId, at);
	const nextSlot = planner.hasSlots(channel.connectionId)
		? planner.nextOpenSlot(channel.connectionId, at)
		: null;
	const requested = describeInstant(at, tz);
	const why =
		v.code === 'max_per_day'
			? `allows at most ${v.limit} post${v.limit === 1 ? '' : 's'} a day and ${requested.weekday} ${v.day} already has ${v.count}`
			: `needs ${v.gapMinutes} minutes between posts and already has one at ${describeInstant(v.conflictAt, tz).display}`;
	const next = [
		nextAllowed !== null
			? `Next allowed time: ${describeInstant(nextAllowed, tz).display} ("${describeInstant(nextAllowed, tz).local}")`
			: `Nothing is allowed in the next ${SLOT_HORIZON_DAYS} days`,
		nextSlot !== null ? `next open slot: ${describeInstant(nextSlot, tz).display}` : null
	]
		.filter(Boolean)
		.join('; ');
	return {
		line: `${label}: ${channel.key} ${why}, so ${requested.display} is refused. ${next}. Send that time, or runAt "next_slot"${planner.hasSlots(channel.connectionId) ? '' : ' once the account has posting slots'}.`,
		refusal: {
			label,
			channel: channel.key,
			code: v.code,
			requested,
			nextAllowed: nextAllowed === null ? null : describeInstant(nextAllowed, tz),
			nextSlot: nextSlot === null ? null : describeInstant(nextSlot, tz)
		}
	};
}

export function noSlotLine(planner: SlotPlanner, channel: Channel, label: string): string {
	return planner.hasSlots(channel.connectionId)
		? `${label}: ${channel.key} has no open posting slot in the next ${SLOT_HORIZON_DAYS} days (${describeRules(planner.rulesFor(channel.connectionId))}). Send an explicit runAt, or ask the operator to add slots.`
		: `${label}: ${channel.key} has no posting slots, so "next_slot" cannot pick a time. Send an explicit runAt, or ask the operator to set slots for it in Accounts.`;
}

export function rulesView(rules: PostingRules | undefined, timeZone: string) {
	if (!hasRules(rules)) return null;
	return {
		...serializeRules(rules!),
		slotsPerWeek: slotCount(rules!.slots),
		description: describeRules(rules!),
		timeZone
	};
}

function resolveBrand(raw: string, brands: BrandRef[]): BrandRef {
	const wanted = raw.trim().toLowerCase();
	if (wanted === UNBRANDED_SLUG)
		throw new ApiOperationError(
			'Unbranded channels have no brief. Put the account in a brand in Accounts to give it one.',
			400,
			{ code: 'unknown_brand' }
		);
	const brand = brands.find((b) => b.slug === wanted || b.name.toLowerCase() === wanted);
	if (!brand)
		throw new ApiOperationError(
			`No brand "${raw}". Brands: ${brands.map((b) => `${b.slug} (${b.name})`).join(', ') || 'none yet'}.`,
			400,
			{ code: 'unknown_brand', brands: brands.map((b) => b.slug) }
		);
	return brand;
}

function briefOut(brief: StoredBrief | undefined) {
	return {
		sections: brief?.sections ?? {},
		platformNotes: brief?.platformNotes ?? {},
		updatedAt: brief?.updatedAt ? new Date(brief.updatedAt).toISOString() : null
	};
}

export async function getBrandBriefOp(
	agent: AgentLike,
	input: { brand?: string; channel?: ChannelRef }
) {
	const { ctx, userId, timeZone } = agent;
	if (input.brand !== undefined && input.channel !== undefined)
		throw new ApiOperationError('Send brand or channel, not both.', 400);
	const dir = await loadChannels(ctx.db, userId);
	let picked: BrandRef[];
	let focus: Channel | null = null;
	if (input.channel !== undefined) {
		const result = resolveChannelRef(input.channel, dir.channels, dir.brands, {
			requireActive: false
		});
		if (!result.ok)
			throw new ApiOperationError(
				`channel: ${result.message} Valid channels: ${candidateLines(result.candidates).join('; ') || 'none'}.`,
				400,
				{ code: 'channel_unresolved' }
			);
		focus = result.channel;
		const brand = dir.brands.find((b) => b.id === result.channel.brand.id);
		if (!brand)
			throw new ApiOperationError(
				`${result.channel.key} is not in a brand, so it has no brief. Put it in a brand in Accounts to give it one.`,
				400,
				{ code: 'unknown_brand' }
			);
		picked = [brand];
	} else if (input.brand !== undefined) picked = [resolveBrand(input.brand, dir.brands)];
	else picked = dir.brands;
	const [briefs, rules] = await Promise.all([
		loadBriefs(ctx.db, userId),
		loadPostingRules(ctx.db, userId)
	]);
	const out = picked.map((brand) => {
		const stored = briefs.get(brand.id);
		const brief: BrandBrief = stored ?? { sections: {}, platformNotes: {} };
		const channels = dir.channels.filter((c) => c.brand.id === brand.id);
		return {
			name: brand.name,
			slug: brand.slug,
			color: brand.color,
			brief: briefOut(stored),
			...briefSummary(brief),
			markdown: briefMarkdown(brand.name, brief),
			channels: channels.map((c) => ({
				key: c.key,
				platform: c.platform,
				handle: c.handle,
				status: c.status,
				platformNote: isPlatformId(c.platform) ? (brief.platformNotes[c.platform] ?? null) : null,
				posting: rulesView(rules.get(c.connectionId), timeZone)
			}))
		};
	});
	const focusOut =
		focus && isPlatformId(focus.platform)
			? {
					channel: focus.key,
					platform: focus.platform,
					platformNote: out[0].brief.platformNotes[focus.platform] ?? null
				}
			: null;
	const missing = out.filter((b) => !b.hasBrief).map((b) => b.name);
	return {
		timeZone,
		sectionsAvailable: BRIEF_SECTIONS.map((s) => ({ key: s.key, label: s.label })),
		brands: out,
		focus: focusOut,
		next: missing.length
			? `No brief yet for ${missing.join(', ')}: ask the operator before guessing a voice. Follow the briefs above in every post; list_slots tells you when to post.`
			: 'Follow these rules in every post for the brand. list_slots tells you when to post; schedule_posts with runAt "next_slot" takes the next open slot.',
		summary: [
			...out.map((b) => b.markdown),
			...(focusOut?.platformNote
				? [`For ${focusOut.channel} (${platformName(focusOut.platform)}): ${focusOut.platformNote}`]
				: [])
		].join('\n\n---\n\n')
	};
}

export async function listSlotsOp(
	agent: AgentLike,
	input: { channels?: ChannelRef[]; brand?: string; from?: string; to?: string; limit?: number }
) {
	const { ctx, userId, timeZone, now } = agent;
	const dir = await loadChannels(ctx.db, userId);
	const rules = await loadPostingRules(ctx.db, userId);
	let channels: Channel[];
	if (input.channels?.length) {
		const problems: string[] = [];
		channels = [];
		for (const [i, ref] of input.channels.entries()) {
			const result = resolveChannelRef(ref, dir.channels, dir.brands, { requireActive: false });
			if (result.ok) channels.push(result.channel);
			else
				problems.push(
					`channels[${i}]: ${result.message} Valid channels: ${candidateLines(result.candidates).join('; ') || 'none'}.`
				);
		}
		if (problems.length)
			throw new ApiOperationError(problems[0], 400, { code: 'channel_unresolved', problems });
	} else {
		channels = dir.channels.filter((c) => c.status === 'active');
		if (input.brand !== undefined) {
			const brand = resolveBrand(input.brand, dir.brands);
			channels = channels.filter((c) => c.brand.id === brand.id);
		}
	}
	const bound = (raw: string | undefined, field: string, fallback: number, end: boolean) => {
		if (raw === undefined) return fallback;
		const value = raw.trim();
		if (isDateKey(value)) {
			const start = zonedToUtc(value, 0, timeZone);
			// "to": a day means through the end of it.
			return end ? zonedToUtc(addDays(value, 1), 0, timeZone) : start;
		}
		const at = parseAfter(value, timeZone);
		if (!at)
			throw new ApiOperationError(
				`${field} "${raw}" must be a day such as "2026-11-10" or an ISO 8601 time with an offset.`,
				400
			);
		return at.getTime();
	};
	const from = Math.max(bound(input.from, 'from', now.getTime(), false), now.getTime());
	const to = bound(input.to, 'to', from + 7 * DAY_MS, true);
	if (to <= from)
		throw new ApiOperationError('to must be after from (and after now).', 400, {
			now: describeInstant(now, timeZone)
		});
	if (to - from > SLOT_HORIZON_DAYS * DAY_MS)
		throw new ApiOperationError(`One call covers at most ${SLOT_HORIZON_DAYS} days.`, 400);
	const limit = input.limit ?? 10;
	const planner = await createSlotPlanner(ctx.db, userId, {
		timeZone,
		now,
		connectionIds: channels.map((c) => c.connectionId),
		from,
		to,
		rules
	});
	const out = channels.map((c) => {
		const r = rules.get(c.connectionId);
		const open = planner.openSlots(c.connectionId, from, to, limit);
		const all = planner.allSlots(c.connectionId, from, to);
		const next = planner.hasSlots(c.connectionId)
			? planner.nextOpenSlot(c.connectionId, from)
			: null;
		return {
			channel: {
				key: c.key,
				brand: c.brand.name,
				platform: c.platform,
				handle: c.handle,
				status: c.status
			},
			posting: rulesView(r, timeZone),
			openSlots: open.map((at) => describeInstant(at, timeZone)),
			slotsInRange: all.length,
			takenOrBlocked: all.length - planner.openSlots(c.connectionId, from, to).length,
			nextOpenSlot: next === null ? null : describeInstant(next, timeZone)
		};
	});
	const lines = out.map((c) => {
		if (!c.posting) return `${c.channel.key}: no slots or limits set; any time is allowed.`;
		if (!c.posting.slotsPerWeek)
			return `${c.channel.key}: no slots (${c.posting.description}); pick explicit times within the limits.`;
		const list = c.openSlots.length
			? c.openSlots.map((s) => s.display).join('; ')
			: 'none open in this range';
		return `${c.channel.key} (${c.posting.description}): ${list}`;
	});
	return {
		now: describeInstant(now, timeZone),
		timeZone,
		from: describeInstant(from, timeZone),
		to: describeInstant(to, timeZone),
		channels: out,
		next: 'Schedule into one of these with schedule_posts (runAt "next_slot" takes the first open one, or send the slot time itself). A time outside the limits is refused with the next allowed time.',
		summary: [
			`Open slots ${describeInstant(from, timeZone).display} → ${describeInstant(to, timeZone).display}:`,
			...lines
		].join('\n')
	};
}

/** Compact brief and slot facts for `list_channels`. */
export async function channelExtras(agent: AgentLike, channels: Channel[]) {
	const { ctx, userId, timeZone, now } = agent;
	const [briefs, rules] = await Promise.all([
		loadBriefs(ctx.db, userId),
		loadPostingRules(ctx.db, userId)
	]);
	const planner = await createSlotPlanner(ctx.db, userId, {
		timeZone,
		now,
		connectionIds: channels.filter((c) => rules.has(c.connectionId)).map((c) => c.connectionId),
		rules
	});
	return {
		briefOf(brandId: string | null) {
			if (!brandId) return null;
			const stored = briefs.get(brandId);
			const summary = briefSummary(stored ?? { sections: {}, platformNotes: {} });
			return {
				...summary,
				updatedAt: stored?.updatedAt ? new Date(stored.updatedAt).toISOString() : null
			};
		},
		postingOf(connectionId: string) {
			const view = rulesView(rules.get(connectionId), timeZone);
			if (!view) return null;
			const next = planner.hasSlots(connectionId)
				? planner.nextOpenSlot(connectionId, now.getTime())
				: null;
			return {
				slots: describeSlots(view.slots) || null,
				slotsPerWeek: view.slotsPerWeek,
				maxPerDay: view.maxPerDay,
				minGapMinutes: view.minGapMinutes,
				nextOpenSlot: next === null ? null : describeInstant(next, timeZone)
			};
		}
	};
}
