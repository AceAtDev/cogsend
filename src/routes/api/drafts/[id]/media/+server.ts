import type { RequestHandler } from './$types';
import { attachFiles, removeMedia, updateMedia } from '#lib/server/api/media-operations.js';
import { cleanAltText, parseSegmentIndex } from '#lib/server/draft-media.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

// A request body ceiling applied before the multipart parse: formData()
// buffers the whole body in the isolate, and the per-file caps can only run
// afterwards. Matches the platform's own request-body limit, so anything
// larger is refused with a clean 413 instead of a parse-then-OOM.
const MAX_UPLOAD_BYTES = 100_000_000;

export const POST: RequestHandler = async ({ params, request, locals }) => {
	try {
		// Cheapest check first: refuse a body that cannot be legitimate before
		// any query or parse runs.
		const declaredBytes = Number(request.headers.get('content-length') ?? '');
		if (Number.isFinite(declaredBytes) && declaredBytes > MAX_UPLOAD_BYTES) {
			return fail('Upload too large', 413);
		}
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const created = await attachFiles(locals, user.id, params.id, async () => {
			const form = await request.formData();
			const fileField = (name: string) => {
				const value = form.get(name);
				return value instanceof File && value.size > 0 ? value : null;
			};
			const files: File[] = [];
			const items: { file: File; preview: File | null; jpeg: File | null }[] = [];
			// `preview-<n>` is the composer's smaller copy of the n-th file entry,
			// `jpeg-<n>` its full-size JPEG copy of a PNG or WebP.
			[...form.getAll('files'), ...form.getAll('file')].forEach((entry, n) => {
				if (!(entry instanceof File) || entry.size <= 0 || files.includes(entry)) return;
				files.push(entry);
				items.push({
					file: entry,
					preview: fileField(`preview-${n}`),
					jpeg: fileField(`jpeg-${n}`)
				});
			});
			return {
				segmentIndex: parseSegmentIndex(form.get('segmentIndex')),
				altText: cleanAltText(form.get('altText')),
				files: items
			};
		});
		return ok({ media: created.length === 1 ? created[0] : created, items: created }, 201);
	} catch (err) {
		return handleError(err);
	}
};

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		const result = await updateMedia(locals, user.id, params.id, () =>
			request.json().catch(() => undefined)
		);
		return ok(result);
	} catch (err) {
		return handleError(err);
	}
};

export const DELETE: RequestHandler = async ({ params, url, locals }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'write');
		return ok(await removeMedia(locals, user.id, params.id, url.searchParams.get('mediaId')));
	} catch (err) {
		return handleError(err);
	}
};
