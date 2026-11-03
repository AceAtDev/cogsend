import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import { fail, handleError } from '#lib/server/http.js';
import {
	assertSafeStorageKey,
	coverKey,
	jpegResponse,
	previewKey,
	serveMediaBytes,
	storedThumbnail,
	thumbCandidate,
	type ImageResizer
} from '#lib/server/media.js';
import { verifyEmailMediaSig } from '#lib/server/public-media.js';

/** Kept briefly so a removed post's thumbnail stops showing soon after. */
const EMAIL_IMAGE_CACHE = 'private, max-age=3600';
const STILL_IMAGES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Thumbnails in notification emails. The signed URL is the authorization, as
// for /api/media/public, but it only ever answers with a small still image:
// a video's cover, an image's resized or preview copy. Never the video itself.
export const GET: RequestHandler = async ({ params, url, locals, request }) => {
	try {
		const key = assertSafeStorageKey(params.key);
		const checked = await verifyEmailMediaSig(
			locals.env.APP_ENCRYPTION_KEY,
			key,
			Number(url.searchParams.get('exp')),
			url.searchParams.get('sig') ?? ''
		);
		if (!checked.ok) return fail(checked.error, 403);
		const media = await first(
			locals.db.select().from(draftMedia).where(eq(draftMedia.storageKey, key))
		);
		if (!media) return fail('Not found', 404);
		const mime = (media.mime || '').toLowerCase();
		if (mime.startsWith('video/')) {
			const cover = await locals.media.get(coverKey(key));
			if (!cover) return fail('Not found', 404);
			return jpegResponse(cover, EMAIL_IMAGE_CACHE);
		}
		if (!STILL_IMAGES.includes(mime)) return fail('Not found', 404);
		const images = (locals.bindings as { IMAGES?: ImageResizer }).IMAGES ?? null;
		if (images && thumbCandidate(media.mime, media.width, media.height)) {
			const thumb = await storedThumbnail(locals.media, key, images);
			if (thumb) return jpegResponse(thumb, EMAIL_IMAGE_CACHE);
		}
		const preview = await locals.media.get(previewKey(key));
		if (preview) return jpegResponse(preview, EMAIL_IMAGE_CACHE);
		return await serveMediaBytes(locals.media, key, request, {
			mime: media.mime,
			cacheControl: EMAIL_IMAGE_CACHE
		});
	} catch (err) {
		return handleError(err);
	}
};
