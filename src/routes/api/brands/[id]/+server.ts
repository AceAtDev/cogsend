import type { RequestHandler } from './$types';
import { deleteBrand, updateBrand } from '#lib/server/brands.js';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		return ok(await updateBrand(locals.db, user.id, params.id, body));
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(await deleteBrand(locals.db, user.id, params.id));
	} catch (err) {
		return handleError(err);
	}
};
