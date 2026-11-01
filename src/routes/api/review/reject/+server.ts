import type { RequestHandler } from './$types';
import { actorOf } from '#lib/server/activity.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import { rejectDeliveries } from '#lib/server/review.js';

/** Session only, like approving. The note is what the agent reads back. */
export const POST: RequestHandler = async ({ locals, request }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== 'object') return fail('Invalid JSON body', 400);
		return ok(await rejectDeliveries(locals.db, user.id, actorOf(locals), body));
	} catch (err) {
		return handleError(err);
	}
};
