import {
	addDays,
	canDrag,
	droppedInstant,
	itemActions,
	zonedParts,
	type CalendarStatus
} from './calendar.js';

export type SelectableItem = {
	id: string;
	status: CalendarStatus;
	at: number;
	/** The account's own state; only an active account can be rescheduled. */
	channelStatus: string;
};

export type BulkPlan = {
	approve: string[];
	reject: string[];
	move: string[];
	retry: string[];
	cancel: string[];
	/** Held posts whose time has passed: approving them publishes at once. */
	approveNow: string[];
};

/** Which of the selected items each bulk action applies to, matching the detail panel per item. */
export function bulkPlan(items: SelectableItem[], now: number): BulkPlan {
	const plan: BulkPlan = {
		approve: [],
		reject: [],
		move: [],
		retry: [],
		cancel: [],
		approveNow: []
	};
	for (const item of items) {
		const actions = itemActions(item.status);
		if (item.status === 'review' || item.status === 'rejected') {
			plan.approve.push(item.id);
			if (item.at <= now) plan.approveNow.push(item.id);
		}
		if (actions.includes('review')) plan.reject.push(item.id);
		if (canDrag(item.status) && item.channelStatus === 'active') plan.move.push(item.id);
		if (actions.includes('retry')) plan.retry.push(item.id);
		if (actions.includes('cancel')) plan.cancel.push(item.id);
	}
	return plan;
}

/**
 * Reschedule calls for moving items to new instants: the bulk route takes one
 * time per call and at most `chunk` ids, so items landing on the same minute
 * share a call.
 */
export function rescheduleCalls(
	moves: { id: string; to: number }[],
	chunk = 10
): { runAt: number; ids: string[] }[] {
	const byTime = new Map<number, string[]>();
	for (const move of moves) {
		const minute = Math.floor(move.to / 60_000) * 60_000;
		byTime.set(minute, [...(byTime.get(minute) ?? []), move.id]);
	}
	const calls: { runAt: number; ids: string[] }[] = [];
	for (const [runAt, ids] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
		for (let i = 0; i < ids.length; i += chunk) calls.push({ runAt, ids: ids.slice(i, i + chunk) });
	}
	return calls;
}

export type Box = { left: number; top: number; right: number; bottom: number };

/** The rectangle between two pointer positions, whichever way it was dragged. */
export function boxBetween(a: { x: number; y: number }, b: { x: number; y: number }): Box {
	return {
		left: Math.min(a.x, b.x),
		top: Math.min(a.y, b.y),
		right: Math.max(a.x, b.x),
		bottom: Math.max(a.y, b.y)
	};
}

export function boxesOverlap(a: Box, b: Box): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** "+1 day 2 hr", "−30 min": how far a group move shifts each post. */
export function shiftLabel(deltaMs: number): string {
	const sign = deltaMs < 0 ? '−' : '+';
	let minutes = Math.round(Math.abs(deltaMs) / 60_000);
	const days = Math.floor(minutes / 1440);
	minutes -= days * 1440;
	const hours = Math.floor(minutes / 60);
	minutes -= hours * 60;
	const parts = [
		days ? `${days} day${days === 1 ? '' : 's'}` : '',
		hours ? `${hours} hr` : '',
		minutes ? `${minutes} min` : ''
	].filter(Boolean);
	return parts.length ? `${sign}${parts.join(' ')}` : 'no change';
}

/**
 * Spread a batch out to one post a day: posts in time order, the first keeps
 * its day and each next one lands a day later, all at their own time of day.
 * A post's accounts move together, so one post going to two accounts stays one post.
 */
export function spreadMoves(
	items: { id: string; draftId: string; at: number }[],
	timeZone: string
): { id: string; to: number }[] {
	const byDraft = new Map<string, { id: string; at: number }[]>();
	for (const item of items) byDraft.set(item.draftId, [...(byDraft.get(item.draftId) ?? []), item]);
	const groups = [...byDraft.values()].sort(
		(a, b) => Math.min(...a.map((i) => i.at)) - Math.min(...b.map((i) => i.at))
	);
	if (!groups.length) return [];
	const firstDay = zonedParts(Math.min(...groups[0].map((i) => i.at)), timeZone).key;
	return groups.flatMap((group, index) =>
		group.map((item) => ({
			id: item.id,
			to: droppedInstant(item.at, { day: addDays(firstDay, index) }, timeZone)
		}))
	);
}

/** Shift-click: every id from the anchor to the clicked one, in the order the calendar shows them. */
export function rangeBetween(ordered: string[], anchor: string, target: string): string[] {
	const a = ordered.indexOf(anchor);
	const b = ordered.indexOf(target);
	if (a === -1 || b === -1) return [target];
	return ordered.slice(Math.min(a, b), Math.max(a, b) + 1);
}
