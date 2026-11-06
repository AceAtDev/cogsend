import { WEEKDAYS, type PostingRules, type Weekday, type WeeklySlots } from './posting-slots';

export type SlotDraft = {
	slots: WeeklySlots;
	maxPerDay: number | null;
	minGap: number | null;
	adding: Record<Weekday, string>;
};

/** Refresh only accounts whose saved rules changed, not other accounts' working copies. */
export function reconcileSlotDrafts(
	channels: Array<{ connectionId: string; rules: PostingRules }>,
	drafts: Record<string, SlotDraft>,
	previous: Map<string, string>
) {
	const signatures = new Map<string, string>();
	const next = Object.fromEntries(
		channels.map((c) => {
			const signature = JSON.stringify(c.rules);
			signatures.set(c.connectionId, signature);
			return [
				c.connectionId,
				previous.get(c.connectionId) === signature && drafts[c.connectionId]
					? drafts[c.connectionId]
					: {
							slots: structuredClone(c.rules.slots),
							maxPerDay: c.rules.maxPerDay,
							minGap: c.rules.minGapMinutes,
							adding: Object.fromEntries(WEEKDAYS.map((d) => [d, ''])) as Record<Weekday, string>
						}
			];
		})
	);
	return { drafts: next, signatures };
}
