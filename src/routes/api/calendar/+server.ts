import type { RequestHandler } from './$types';
import {
	addDays,
	isDateKey,
	parseCalendarQuery,
	rangeBounds,
	safeTimeZone
} from '#lib/domain/calendar.js';
import { loadCalendar } from '#lib/server/calendar.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

/** Longest span one request reads: the scrolling month view asks for two months at a time. */
const MAX_DAYS = 100;

/**
 * Posts between two days, for the month view to fill in weeks as they scroll
 * into reach without reloading the page. Same filters as the calendar address.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const start = url.searchParams.get('start');
		const end = url.searchParams.get('end');
		if (!isDateKey(start) || !isDateKey(end) || end <= start) {
			return fail('start and end must be YYYY-MM-DD, end after start', 400);
		}
		if (addDays(start, MAX_DAYS) < end) return fail(`At most ${MAX_DAYS} days at a time`, 400);
		const timeZone = safeTimeZone(user.timezone);
		const filter = parseCalendarQuery(url.searchParams, start);
		const loaded = await loadCalendar(locals.db, user.id, {
			...rangeBounds({ start, end }, timeZone),
			filter,
			now: new Date()
		});
		return ok({ items: loaded.items, media: loaded.media, truncated: loaded.truncated });
	} catch (err) {
		return handleError(err);
	}
};
