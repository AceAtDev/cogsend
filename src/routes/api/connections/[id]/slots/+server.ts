import type { RequestHandler } from './$types';
import { getPostingRules, savePostingRules } from '#lib/server/posting-slots.js';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		return ok(await getPostingRules(locals.db, user.id, params.id));
	} catch (err) {
		return handleError(err);
	}
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		return ok(await savePostingRules(locals.db, user.id, params.id, body));
	} catch (err) {
		return handleError(err);
	}
};
