import type { CalendarChannel, CalendarItem, CalendarStatus } from './calendar.js';
import { addDays, zonedParts } from './calendar.js';
import { draftExcerpt } from './excerpt.js';

export type OverviewAccount = { platform: string; handle: string | null; color: string };

/** One post at one time: the accounts it goes to share a line, so a four-platform post reads once. */
export type OverviewLine = {
	key: string;
	draftId: string;
	at: number;
	status: CalendarStatus;
	text: string;
	accounts: OverviewAccount[];
};

export type OverviewDay = { day: string; lines: OverviewLine[] };

export type ComposeOverviewData = {
	timeZone: string;
	today: string;
	days: OverviewDay[];
	failed: number;
	drafts: { id: string; label: string; updatedAt: number }[];
	/** Undated drafts, counted up to the calendar's cap; `moreDrafts` says there are more. */
	draftCount: number;
	moreDrafts: boolean;
};

/** States the rail leaves out: they need nothing and are not going out. */
const HIDDEN: CalendarStatus[] = ['cancelled', 'rejected'];

// When one post's accounts disagree, the line shows whichever needs a person most.
const URGENCY: CalendarStatus[] = [
	'failed',
	'review',
	'due',
	'sending',
	'processing',
	'scheduled',
	'published'
];

function moreUrgent(a: CalendarStatus, b: CalendarStatus): CalendarStatus {
	const ia = URGENCY.indexOf(a);
	const ib = URGENCY.indexOf(b);
	return (ia === -1 ? 99 : ia) <= (ib === -1 ? 99 : ib) ? a : b;
}

/**
 * The compose page's "what is coming" list: the calendar's items for the next
 * days, grouped by local day and merged per post and minute.
 */
export function overviewDays(
	items: CalendarItem[],
	channels: CalendarChannel[],
	timeZone: string,
	today: string,
	days = 7
): OverviewDay[] {
	const channelById = new Map(channels.map((c) => [c.connectionId, c]));
	const last = addDays(today, days);
	const lines = new Map<string, OverviewLine & { day: string }>();
	for (const item of items) {
		if (HIDDEN.includes(item.status)) continue;
		const channel = channelById.get(item.connectionId);
		if (!channel) continue;
		const { key: day } = zonedParts(item.at, timeZone);
		if (day < today || day >= last) continue;
		const lineKey = `${item.draftId}:${Math.floor(item.at / 60_000)}`;
		const account = {
			platform: channel.platform,
			handle: channel.handle,
			color: channel.brand.color
		};
		const existing = lines.get(lineKey);
		if (existing) {
			existing.accounts.push(account);
			existing.status = moreUrgent(existing.status, item.status);
			continue;
		}
		lines.set(lineKey, {
			key: lineKey,
			day,
			draftId: item.draftId,
			at: item.at,
			status: item.status,
			text: draftExcerpt((item.previewTitle || item.text).split('\n')[0], 90),
			accounts: [account]
		});
	}
	const byDay = new Map<string, OverviewLine[]>();
	for (const { day, ...line } of [...lines.values()].sort((a, b) => a.at - b.at)) {
		byDay.set(day, [...(byDay.get(day) ?? []), line]);
	}
	return [...byDay.entries()].map(([day, list]) => ({ day, lines: list }));
}
