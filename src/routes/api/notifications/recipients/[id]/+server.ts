import type { RequestHandler } from './$types';
import { normalizeSubscriptions } from '#lib/domain/notifications.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import { removeRecipient, updateRecipient } from '#lib/server/notify/store.js';

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		const subscriptions = normalizeSubscriptions(body?.subscriptions);
		if (!subscriptions) return fail('subscriptions must be a list of known kinds', 400);
		const recipient = await updateRecipient(locals.db, user.id, params.id, subscriptions);
		if (!recipient) return fail('Not found', 404);
		return ok({ recipient });
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		if (!(await removeRecipient(locals.db, user.id, params.id))) return fail('Not found', 404);
		return ok({ ok: true });
	} catch (err) {
		return handleError(err);
	}
};
