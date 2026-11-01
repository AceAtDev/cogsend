import { and, eq, gte, inArray, lt, ne, notInArray, sql } from 'drizzle-orm';
import {
	EMPTY_RULES,
	hasRules,
	parsePostingRules,
	rulesFromStored,
	SLOT_HORIZON_DAYS,
	slotCount,
	SlotPlanner,
	type PostingRules
} from '#lib/domain/posting-slots.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import type { AppDb } from '#lib/server/db/client.js';
import { chunkIds, first } from '#lib/server/db/client.js';
import { connections, drafts, postingSchedules, publishTargets } from '#lib/server/db/schema.js';

const DAY_MS = 86_400_000;

/**
 * Deliveries that take a place in an account's cadence: everything except
 * those that will never go out. Listing what is left out rather than what
 * counts keeps a new waiting state (a post held for review) counted without
 * this file knowing its name; a published one counts on the day it went out.
 */
const NOT_COUNTED = ['cancelled', 'failed', 'expired'];

export async function loadPostingRules(
	db: AppDb,
	userId: string,
	connectionIds?: string[]
): Promise<Map<string, PostingRules>> {
	const out = new Map<string, PostingRules>();
	if (connectionIds && !connectionIds.length) return out;
	const chunks = connectionIds ? chunkIds(connectionIds) : [null];
	for (const chunk of chunks) {
		const rows = await db
			.select()
			.from(postingSchedules)
			.where(
				and(
					eq(postingSchedules.userId, userId),
					chunk ? inArray(postingSchedules.connectionId, chunk) : undefined
				)
			);
		for (const row of rows)
			out.set(row.connectionId, rulesFromStored(row.slotsJson, row.maxPerDay, row.minGapMinutes));
	}
	return out;
}

/**
 * When each counted delivery on these accounts happens, in [fromMs, toMs):
 * its scheduled time, or for one sent at once (no scheduled time) when it last
 * changed. Deliveries in `ignore` are left out, so a reschedule does not
 * collide with the time it is moving away from.
 */
export async function loadOccupancy(
	db: AppDb,
	userId: string,
	connectionIds: string[],
	fromMs: number,
	toMs: number,
	ignore: string[] = []
): Promise<Map<string, number[]>> {
	const out = new Map<string, number[]>();
	if (!connectionIds.length) return out;
	const at = sql<number>`coalesce(${publishTargets.scheduledFor}, ${publishTargets.updatedAt})`;
	for (const chunk of chunkIds(connectionIds, 40)) {
		const rows = await db
			.select({ id: publishTargets.id, connectionId: publishTargets.connectionId, at })
			.from(publishTargets)
			.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
			.where(
				and(
					eq(drafts.userId, userId),
					inArray(publishTargets.connectionId, chunk),
					notInArray(publishTargets.status, NOT_COUNTED),
					gte(at, fromMs),
					lt(at, toMs)
				)
			);
		for (const row of rows) {
			if (ignore.includes(row.id)) continue;
			const list = out.get(row.connectionId) ?? [];
			list.push(Number(row.at));
			out.set(row.connectionId, list);
		}
	}
	return out;
}

/**
 * A planner over these accounts with every counted delivery from two days
 * before `from` (a day limit and a gap reach back) to the slot horizon past it.
 */
export async function createSlotPlanner(
	db: AppDb,
	userId: string,
	opts: {
		timeZone: string;
		now: Date;
		connectionIds: string[];
		from?: number;
		to?: number;
		ignore?: string[];
		rules?: Map<string, PostingRules>;
	}
) {
	const ids = [...new Set(opts.connectionIds)];
	const rules = opts.rules ?? (await loadPostingRules(db, userId, ids));
	const limited = ids.filter((id) => hasRules(rules.get(id)));
	const from = Math.min(opts.from ?? opts.now.getTime(), opts.now.getTime()) - 2 * DAY_MS;
	const to = Math.max(opts.to ?? 0, opts.now.getTime()) + (SLOT_HORIZON_DAYS + 2) * DAY_MS;
	const occupied = await loadOccupancy(db, userId, limited, from, to, opts.ignore);
	return new SlotPlanner({ timeZone: opts.timeZone, now: opts.now.getTime(), rules, occupied });
}

async function ownedConnection(db: AppDb, userId: string, connectionId: string) {
	const row = await first(
		db
			.select({ id: connections.id })
			.from(connections)
			.where(
				and(
					eq(connections.id, connectionId),
					eq(connections.userId, userId),
					ne(connections.status, 'disconnected')
				)
			)
	);
	if (!row) throw new ApiOperationError('Not found', 404);
}

export function serializeRules(rules: PostingRules) {
	return { slots: rules.slots, maxPerDay: rules.maxPerDay, minGapMinutes: rules.minGapMinutes };
}

export async function getPostingRules(db: AppDb, userId: string, connectionId: string) {
	await ownedConnection(db, userId, connectionId);
	const rules = (await loadPostingRules(db, userId, [connectionId])).get(connectionId);
	return { connectionId, rules: serializeRules(rules ?? EMPTY_RULES) };
}

/** Replaces the account's slots and limits; no slots and no limits removes the row. */
export async function savePostingRules(
	db: AppDb,
	userId: string,
	connectionId: string,
	input: unknown
) {
	await ownedConnection(db, userId, connectionId);
	const parsed = parsePostingRules(input);
	if (!parsed.ok) throw new ApiOperationError(parsed.error, 400);
	if (!hasRules(parsed.rules)) {
		await db
			.delete(postingSchedules)
			.where(
				and(eq(postingSchedules.connectionId, connectionId), eq(postingSchedules.userId, userId))
			);
		return { connectionId, rules: serializeRules(EMPTY_RULES) };
	}
	const values = {
		slotsJson: JSON.stringify(parsed.rules.slots),
		maxPerDay: parsed.rules.maxPerDay,
		minGapMinutes: parsed.rules.minGapMinutes,
		updatedAt: new Date()
	};
	await db
		.insert(postingSchedules)
		.values({ connectionId, userId, ...values })
		.onConflictDoUpdate({ target: postingSchedules.connectionId, set: values });
	return { connectionId, rules: serializeRules(parsed.rules) };
}

/** More than a month of four slots a day on ten accounts. */
export const CALENDAR_SLOT_CAP = 600;

export type CalendarSlot = { connectionId: string; at: number };

/**
 * The open slots the calendar draws in [startMs, endMs) for these accounts:
 * future ones only, and only where the planner would hand them to an agent.
 * Costs one statement when no shown account has slots.
 */
export async function calendarOpenSlots(
	db: AppDb,
	userId: string,
	opts: { timeZone: string; now: Date; connectionIds: string[]; startMs: number; endMs: number }
): Promise<CalendarSlot[]> {
	if (!opts.connectionIds.length || opts.endMs <= opts.now.getTime()) return [];
	const rules = await loadPostingRules(db, userId);
	const ids = opts.connectionIds.filter((id) => slotCount(rules.get(id)?.slots ?? {}) > 0);
	if (!ids.length) return [];
	const planner = await createSlotPlanner(db, userId, {
		timeZone: opts.timeZone,
		now: opts.now,
		connectionIds: ids,
		from: opts.startMs,
		to: opts.endMs,
		rules
	});
	const from = Math.max(opts.startMs, opts.now.getTime());
	const out: CalendarSlot[] = [];
	for (const id of ids)
		for (const at of planner.openSlots(id, from, opts.endMs, CALENDAR_SLOT_CAP))
			out.push({ connectionId: id, at });
	return out.sort((a, b) => a.at - b.at).slice(0, CALENDAR_SLOT_CAP);
}
