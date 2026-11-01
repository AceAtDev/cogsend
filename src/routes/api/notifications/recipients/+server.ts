import type { RequestHandler } from './$types';
import {
	DEFAULT_SUBSCRIPTIONS,
	MAX_RECIPIENTS,
	normalizeAddress,
	normalizeSubscriptions
} from '#lib/domain/notifications.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import { addRecipient, listRecipients } from '#lib/server/notify/store.js';

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== 'object') return fail('Invalid payload', 400);
		const email = normalizeAddress(body.email);
		if (!email) return fail('Enter a valid email address', 400);
		const subscriptions =
			body.subscriptions === undefined
				? DEFAULT_SUBSCRIPTIONS
				: normalizeSubscriptions(body.subscriptions);
		if (!subscriptions) return fail('Unknown subscription', 400);
		const existing = await listRecipients(locals.db, user.id);
		if (existing.length >= MAX_RECIPIENTS) {
			return fail(`At most ${MAX_RECIPIENTS} recipients`, 400);
		}
		const recipient = await addRecipient(locals.db, user.id, email, subscriptions);
		if (!recipient) return fail('That address is already on the list', 409);
		return ok({ recipient }, 201);
	} catch (err) {
		return handleError(err);
	}
};
