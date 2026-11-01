import type { PageServerLoad } from './$types';
import { safeTimeZone } from '#lib/domain/calendar.js';
import { requireUser } from '#lib/server/require.js';
import { loadReviewQueue } from '#lib/server/review.js';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	const timeZone = safeTimeZone(user.timezone);
	const now = Date.now();
	try {
		return {
			timeZone,
			now,
			...(await loadReviewQueue(locals.db, user.id, { now: new Date(now) })),
			loadFailed: false
		};
	} catch (err) {
		// A transient D1 error shows an empty inbox with a notice, not a 500.
		console.error('[review] load failed', err);
		return {
			timeZone,
			now,
			groups: [],
			counts: { waiting: 0, overdue: 0, rejected: 0 },
			truncated: false,
			loadFailed: true
		};
	}
};
