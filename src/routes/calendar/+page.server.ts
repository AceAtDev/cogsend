import type { PageServerLoad } from './$types';
import {
	dayKeyOf,
	parseCalendarQuery,
	rangeBounds,
	safeTimeZone,
	visibleRange
} from '#lib/domain/calendar.js';
import { loadCalendar } from '#lib/server/calendar.js';
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
		return {
			...base,
			...(await loadCalendar(locals.db, user.id, { ...bounds, filter: query, now })),
			loadFailed: false
		};
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
			loadFailed: true
		};
	}
};
