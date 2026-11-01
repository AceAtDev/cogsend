import type { PageServerLoad } from './$types';
import {
	dayKeyOf,
	filteredConnectionIds,
	parseCalendarQuery,
	rangeBounds,
	safeTimeZone,
	visibleRange
} from '#lib/domain/calendar.js';
import { loadCalendar } from '#lib/server/calendar.js';
import { calendarOpenSlots, type CalendarSlot } from '#lib/server/posting-slots.js';
import { requireUser } from '#lib/server/require.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const timeZone = safeTimeZone(user.timezone);
	const now = new Date();
	const today = dayKeyOf(now.getTime(), timeZone);
	const query = parseCalendarQuery(url.searchParams, today);
	const range = visibleRange(query.view, query.date);
	const bounds = rangeBounds(range, timeZone);
	const base = { timeZone, today, query, range, now: now.getTime() };
	try {
		const loaded = await loadCalendar(locals.db, user.id, { ...bounds, filter: query, now });
		const shown = filteredConnectionIds(
			loaded.channels.map((c) => ({
				connectionId: c.connectionId,
				key: c.key,
				brandSlug: c.brand.slug
			})),
			query
		);
		let openSlots: CalendarSlot[] = [];
		try {
			openSlots = await calendarOpenSlots(locals.db, user.id, {
				timeZone,
				now,
				startMs: bounds.startMs,
				endMs: bounds.endMs,
				connectionIds: loaded.channels
					.filter((c) => c.key && c.status === 'active' && (!shown || shown.has(c.connectionId)))
					.map((c) => c.connectionId)
			});
		} catch (err) {
			// Open slots are a hint; the posts still show without them.
			console.error('[calendar] open slots failed', err);
		}
		return { ...base, ...loaded, openSlots, loadFailed: false };
	} catch (err) {
		// A transient D1 error shows an empty calendar with a notice, not a 500.
		console.error('[calendar] load failed', err);
		return {
			...base,
			brands: [],
			channels: [],
			items: [],
			media: {},
			unscheduled: [],
			unscheduledHasMore: false,
			truncated: false,
			openSlots: [] as CalendarSlot[],
			loadFailed: true
		};
	}
};
