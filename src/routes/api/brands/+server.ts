import type { RequestHandler } from './$types';
import { brandDirectory, createBrand } from '#lib/server/brands.js';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		return ok(await brandDirectory(locals.db, user.id));
	} catch (err) {
		return handleError(err);
	}
};

export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await request.json().catch(() => null);
		return ok(await createBrand(locals.db, user.id, body), 201);
	} catch (err) {
		return handleError(err);
	}
};
