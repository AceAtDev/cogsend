import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';
import { loadReviewQueue } from '#lib/server/review.js';

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		return ok(
			await loadReviewQueue(locals.db, user.id, {
				includeRejected: url.searchParams.get('rejected') !== '0'
			})
		);
	} catch (err) {
		return handleError(err);
	}
};
