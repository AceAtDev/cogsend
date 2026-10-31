import type { RequestHandler } from './$types';
import { completeVideoUpload } from '#lib/server/api/media-operations.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

/** Join the parts and attach the video; see completeVideoUpload. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return fail('Invalid JSON');
		}
		if (!body || typeof body !== 'object') return fail('Upload details required');
		return ok(
			await completeVideoUpload(locals, user.id, params.id, body as Record<string, unknown>),
			201
		);
	} catch (err) {
		return handleError(err);
	}
};
