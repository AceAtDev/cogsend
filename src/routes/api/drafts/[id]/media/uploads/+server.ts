import type { RequestHandler } from './$types';
import { abortVideoUpload, startVideoUpload } from '#lib/server/api/media-operations.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const body = (await request.json()) as unknown;
		return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Start a video upload in parts; see startVideoUpload. */
export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await readJson(request);
		if (!body) return fail('Invalid JSON');
		return ok(await startVideoUpload(locals, user.id, params.id, body), 201);
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const body = await readJson(request);
		if (!body) return fail('Upload details required');
		return ok(await abortVideoUpload(locals, user.id, params.id, body));
	} catch (err) {
		return handleError(err);
	}
};
