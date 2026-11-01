import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { loadDeliveryMetrics, refreshDeliveryMetrics } from '#lib/server/metrics.js';
import { requireScope, requireUser } from '#lib/server/require.js';

/** A delivery's latest metrics and snapshot history. */
export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		return ok(await loadDeliveryMetrics(locals.db, user.id, params.id));
	} catch (err) {
		return handleError(err);
	}
};

/** Read the delivery's counts from the platform now (at most every five minutes). */
export const POST: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(await refreshDeliveryMetrics(locals.db, locals.env, user.id, params.id));
	} catch (err) {
		return handleError(err);
	}
};
