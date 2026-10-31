import type { RequestHandler } from './$types';
import {
	MAX_COVER_BYTES,
	removeVideoCover,
	setVideoCover
} from '#lib/server/api/media-operations.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

/** Set a video's cover from a JPEG body. */
export const PUT: RequestHandler = async ({ params, request, url, locals }) => {
	try {
		const declared = Number(request.headers.get('content-length') ?? '');
		if (Number.isFinite(declared) && declared > MAX_COVER_BYTES) {
			return fail('Cover must be 8MB or smaller', 413);
		}
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const result = await setVideoCover(locals, user.id, params.id, {
			mediaId: url.searchParams.get('mediaId'),
			read: async () => new Uint8Array(await request.arrayBuffer()),
			atMs: url.searchParams.get('atMs')
		});
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(await removeVideoCover(locals, user.id, params.id, url.searchParams.get('mediaId')));
	} catch (err) {
		return handleError(err);
	}
};
