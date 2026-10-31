import { and, eq, ne } from 'drizzle-orm';
import {
	canAttachMoreImages,
	detectImageMime,
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_SEGMENT,
	MAX_VIDEO_BYTES,
	validateImageUpload,
	validateVideoUpload,
	videoMixProblem
} from '#lib/domain/media-limits.js';
import { first, newId, parseJson } from '#lib/server/db/client.js';
import { draftMedia } from '#lib/server/db/schema.js';
import {
	cleanAltText,
	draftMediaEditBlock,
	MAX_FILES_PER_DRAFT,
	MAX_FILES_PER_USER,
	overUserFileCap,
	ownDraft,
	parseSegmentIndex,
	segmentProblem,
	videoSlotProblem
} from '#lib/server/draft-media.js';
import {
	coverKey,
	deleteMediaObjects,
	isAnimatedWebpBytes,
	jpegKey,
	MAX_JPEG_COPY_BYTES,
	MAX_PREVIEW_BYTES,
	previewKey,
	probeStoredVideo,
	requirePlayableVideo,
	saveMediaBytes,
	videoMetaFrom,
	type StoredImageMeta,
	type StoredVideoMeta
} from '#lib/server/media.js';
import {
	newVideoKey,
	partCount,
	readClaim,
	signUploadClaim,
	UPLOAD_PART_BYTES,
	verifyUploadClaim
} from '#lib/server/media-uploads.js';
import { countingFetch } from '#lib/server/budget.js';
import { readCappedBody } from '#lib/server/opengraph.js';
import { fetchPublic } from '#lib/server/safe-fetch.js';
import { serializeMedia } from '#lib/server/serialize.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import type { FetchLike } from '#lib/server/providers/types.js';
import type { OperationContext } from '#lib/server/api/operations.js';

/**
 * Attaching, changing and removing a draft's media, shared by the REST media
 * routes and the MCP tools so both store and check a file the same way.
 */

function invalid(message: string, status = 400, details?: Record<string, unknown>): never {
	throw new ApiOperationError(message, status, details);
}

/** One file must fit in the 100 MB a request may carry, with its multipart framing. */
export const SINGLE_REQUEST_VIDEO_BYTES = 95_000_000;
/** Instagram takes covers up to 8 MB; a frame from the composer is a few hundred KB. */
export const MAX_COVER_BYTES = 8_000_000;

const isVideoType = (mime: string | null | undefined) =>
	(mime || '').toLowerCase().startsWith('video/');

async function editableDraft(ctx: OperationContext, userId: string, draftId: string) {
	const draft = await ownDraft(ctx, draftId, userId);
	if (!draft) invalid('Not found', 404);
	const blocked = await draftMediaEditBlock(ctx.db, draftId);
	if (blocked) invalid(blocked, 409);
	return draft;
}

/**
 * Keep a JPEG the composer made of an image: a smaller one for showing it, or
 * a full-size one for Instagram. One that is missing, too large or not a JPEG
 * is dropped, and the upload never fails over it.
 */
async function saveJpegVariant(
	ctx: OperationContext,
	key: string,
	file: Blob | null | undefined,
	maxBytes: number
): Promise<boolean> {
	if (!file || file.size > maxBytes) return false;
	const bytes = new Uint8Array(await file.arrayBuffer());
	const check = validateImageUpload({ mime: 'image/jpeg', size: bytes.length, maxBytes, bytes });
	if (!check.ok || check.mime !== 'image/jpeg') return false;
	try {
		await ctx.media.put(key, bytes, 'image/jpeg');
		return true;
	} catch {
		return false;
	}
}

export interface IncomingMedia {
	/** The file; its `type` decides whether it is checked as a video. */
	file: Blob;
	/** The composer's smaller copy, shown in place of the file in the app. */
	preview?: Blob | null;
	/** The composer's full-size JPEG of a PNG or WebP, for Instagram. */
	jpeg?: Blob | null;
}

export interface AttachRequest {
	segmentIndex: number;
	altText: string | null;
	files: IncomingMedia[];
}

/**
 * Store files on one segment of a draft. `load` reads the request only once
 * the draft is known to be the caller's and editable, so a body is never
 * parsed for a draft the caller cannot touch. Files are read one at a time,
 * after every check that can refuse them by size alone.
 */
export async function attachFiles(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	load: () => Promise<AttachRequest>
) {
	const draft = await editableDraft(ctx, userId, draftId);
	const { segmentIndex, altText, files } = await load();
	const problem = await segmentProblem(ctx, draft, segmentIndex);
	if (problem) invalid(problem);
	const existing = await ctx.db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId));
	const existingOnSegment = existing.filter((m) => (m.segmentIndex ?? 0) === segmentIndex).length;
	if (!files.length) invalid('file required');
	for (const { file } of files) {
		const isVideo = isVideoType(file.type);
		const cap = isVideo ? SINGLE_REQUEST_VIDEO_BYTES : MAX_IMAGE_BYTES;
		if (file.size > cap) {
			invalid(
				isVideo
					? 'Video must be 95MB or smaller here; larger ones go up in parts (POST /api/drafts/:id/media/uploads)'
					: 'Image must be 16MB or smaller'
			);
		}
	}
	if (existing.length + files.length > MAX_FILES_PER_DRAFT) {
		invalid(`Max ${MAX_FILES_PER_DRAFT} files per draft`, 413);
	}
	if (await overUserFileCap(ctx.db, userId, files.length)) {
		invalid(`Max ${MAX_FILES_PER_USER} files per account`, 413);
	}
	const remaining = MAX_IMAGES_PER_SEGMENT - existingOnSegment;
	if (remaining <= 0) invalid(`Max ${MAX_IMAGES_PER_SEGMENT} images per post`);
	if (files.length > remaining) {
		invalid(`Only ${remaining} more image(s) allowed on this post (max ${MAX_IMAGES_PER_SEGMENT})`);
	}
	const newVideos = files.filter(({ file }) => isVideoType(file.type)).length;
	const onSegment = existing.filter((m) => (m.segmentIndex ?? 0) === segmentIndex);
	const existingVideos = onSegment.filter((m) => isVideoType(m.mime)).length;
	const mix = videoMixProblem(
		newVideos + existingVideos,
		files.length - newVideos + onSegment.length - existingVideos
	);
	if (mix) invalid(mix);

	const created = [];
	for (let i = 0; i < files.length; i++) {
		const { file, preview, jpeg } = files[i];
		const bytes = new Uint8Array(await file.arrayBuffer());
		const saved = await saveMediaBytes(ctx.media, { bytes, mime: file.type || 'image/jpeg' });
		const imageMeta: StoredImageMeta = {};
		if (!saved.video) {
			const v = Date.now();
			const key = saved.storageKey;
			if (saved.mime === 'image/webp' && isAnimatedWebpBytes(bytes)) imageMeta.animated = true;
			if (await saveJpegVariant(ctx, previewKey(key), preview, MAX_PREVIEW_BYTES)) {
				imageMeta.preview = { v };
			}
			// A JPEG original is already what Instagram takes.
			if (
				saved.mime !== 'image/jpeg' &&
				(await saveJpegVariant(ctx, jpegKey(key), jpeg, MAX_JPEG_COPY_BYTES))
			) {
				imageMeta.jpeg = { v };
			}
		}
		let media;
		try {
			[media] = await ctx.db
				.insert(draftMedia)
				.values({
					id: newId(),
					draftId,
					storageKey: saved.storageKey,
					mime: saved.mime,
					size: saved.size,
					width: saved.width,
					height: saved.height,
					metaJson: saved.video
						? JSON.stringify(saved.video)
						: Object.keys(imageMeta).length
							? JSON.stringify(imageMeta)
							: null,
					altText: i === 0 ? altText : null,
					sortOrder: existingOnSegment + i,
					segmentIndex,
					createdAt: new Date()
				})
				.returning();
		} catch (err) {
			// put-before-insert leaks the object when the DB write fails:
			// compensate so a failed upload never orphans R2 bytes.
			await deleteMediaObjects(ctx.media, [saved.storageKey]).catch(() => {});
			throw err;
		}
		created.push(serializeMedia(media));
	}
	return created;
}

/** Change an attachment's alt text or move it to another segment. */
export async function updateMedia(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	load: () => Promise<unknown>
) {
	const draft = await editableDraft(ctx, userId, draftId);
	const input = await load();
	if (!input || typeof input !== 'object') invalid('Invalid JSON');
	const body = input as Record<string, unknown>;
	const mediaId = String(body.mediaId || '');
	if (!mediaId) invalid('mediaId required');
	const existing = await first(
		ctx.db
			.select()
			.from(draftMedia)
			.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, draftId)))
	);
	if (!existing) invalid('Media not found', 404);
	const data: { altText?: string | null; segmentIndex?: number } = {};
	if (body.altText !== undefined) data.altText = cleanAltText(body.altText);
	if (body.segmentIndex !== undefined) {
		const si = parseSegmentIndex(body.segmentIndex);
		const problem = await segmentProblem(ctx, draft, si);
		if (problem) invalid(problem);
		const siblings = await ctx.db
			.select()
			.from(draftMedia)
			.where(
				and(
					eq(draftMedia.draftId, draftId),
					eq(draftMedia.segmentIndex, si),
					ne(draftMedia.id, mediaId)
				)
			);
		if (!canAttachMoreImages(siblings.length))
			invalid(`Max ${MAX_IMAGES_PER_SEGMENT} images per post`);
		// Moving must respect the same video invariants as upload: at most
		// one video per segment and no image/video mixing.
		const movingIsVideo = isVideoType(existing.mime);
		const sibVideos = siblings.filter((m) => isVideoType(m.mime)).length;
		const sibImages = siblings.length - sibVideos;
		if (movingIsVideo ? sibVideos > 0 || sibImages > 0 : sibVideos > 0) {
			invalid('Videos cannot mix with images on the same post');
		}
		data.segmentIndex = si;
	}
	if (Object.keys(data).length === 0) invalid('Nothing to update');
	const [media] = await ctx.db
		.update(draftMedia)
		.set(data)
		.where(eq(draftMedia.id, mediaId))
		.returning();
	return { media: serializeMedia(media) };
}

export async function removeMedia(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	mediaId: string | null
) {
	await editableDraft(ctx, userId, draftId);
	if (!mediaId) invalid('mediaId required');
	const gone = await first(
		ctx.db
			.select()
			.from(draftMedia)
			.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, draftId)))
	);
	await ctx.db
		.delete(draftMedia)
		.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, draftId)));
	if (gone) await deleteMediaObjects(ctx.media, [gone.storageKey]);
	return { ok: true as const };
}

async function videoRow(ctx: OperationContext, draftId: string, mediaId: string | null) {
	if (!mediaId) return null;
	const row = await first(
		ctx.db
			.select()
			.from(draftMedia)
			.where(and(eq(draftMedia.id, mediaId), eq(draftMedia.draftId, draftId)))
	);
	return row && isVideoType(row.mime) ? row : null;
}

/** Set a video's cover: a JPEG, a frame the composer captured or an image. */
export async function setVideoCover(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	input: { mediaId: string | null; read: () => Promise<Uint8Array>; atMs?: string | number | null }
) {
	await editableDraft(ctx, userId, draftId);
	const row = await videoRow(ctx, draftId, input.mediaId);
	if (!row) invalid('Video not found', 404);
	const bytes = await input.read();
	const check = validateImageUpload({
		mime: 'image/jpeg',
		size: bytes.length,
		maxBytes: MAX_COVER_BYTES,
		bytes
	});
	if (!check.ok) invalid(check.message);
	// Every platform that takes a cover takes JPEG; Instagram takes nothing else.
	if (check.mime !== 'image/jpeg') invalid('Cover must be a JPEG');
	await ctx.media.put(coverKey(row.storageKey), bytes, 'image/jpeg');
	const atMs =
		input.atMs === null || input.atMs === undefined || input.atMs === '' ? NaN : Number(input.atMs);
	const meta = parseJson<StoredVideoMeta>(row.metaJson, {} as StoredVideoMeta);
	meta.cover = {
		v: Date.now(),
		...(Number.isFinite(atMs) && atMs >= 0 ? { atMs: Math.round(atMs) } : {})
	};
	const [media] = await ctx.db
		.update(draftMedia)
		.set({ metaJson: JSON.stringify(meta) })
		.where(eq(draftMedia.id, row.id))
		.returning();
	return { media: serializeMedia(media) };
}

/** Back to the platforms' own choice of cover. */
export async function removeVideoCover(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	mediaId: string | null
) {
	await editableDraft(ctx, userId, draftId);
	const row = await videoRow(ctx, draftId, mediaId);
	if (!row) invalid('Video not found', 404);
	await ctx.media.delete(coverKey(row.storageKey));
	const meta = parseJson<StoredVideoMeta>(row.metaJson, {} as StoredVideoMeta);
	delete meta.cover;
	const [media] = await ctx.db
		.update(draftMedia)
		.set({ metaJson: JSON.stringify(meta) })
		.where(eq(draftMedia.id, row.id))
		.returning();
	return { media: serializeMedia(media) };
}

/**
 * Start a video upload in parts. Every check that can refuse the video runs
 * here, before any bytes move; completing runs them again.
 */
export async function startVideoUpload(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	body: Record<string, unknown>
) {
	const size = Number(body.size);
	if (!Number.isInteger(size) || size <= 0) invalid('size required');
	if (size > MAX_VIDEO_BYTES)
		invalid(`Video too large (max ${MAX_VIDEO_BYTES / 1_000_000}MB)`, 413);
	if (String(body.mime ?? '').toLowerCase() !== 'video/mp4') {
		invalid('Only MP4 video goes up in parts');
	}
	const draft = await editableDraft(ctx, userId, draftId);
	const segmentIndex = parseSegmentIndex(body.segmentIndex);
	const problem = await videoSlotProblem(ctx, draft, segmentIndex);
	if (problem) invalid(problem.message, problem.status);
	if (!ctx.media.multipart) invalid('This storage cannot take uploads in parts', 501);
	const key = newVideoKey();
	const uploadId = await ctx.media.multipart.create(key, 'video/mp4');
	const claim = { draftId, key, uploadId, size, segmentIndex };
	const token = await signUploadClaim(ctx.env.APP_ENCRYPTION_KEY, claim);
	return { ...claim, token, partSize: UPLOAD_PART_BYTES, parts: partCount(size) };
}

async function verifiedClaim(
	ctx: OperationContext,
	draftId: string,
	body: Record<string, unknown>
) {
	const claim = readClaim(draftId, body);
	if (!claim) invalid('Upload details required');
	if (!(await verifyUploadClaim(ctx.env.APP_ENCRYPTION_KEY, claim, String(body.token)))) {
		invalid('Bad upload token', 403);
	}
	return claim;
}

/** Abandon an upload. R2 also drops unfinished ones on its own after 7 days. */
export async function abortVideoUpload(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	body: Record<string, unknown>
) {
	const claim = await verifiedClaim(ctx, draftId, body);
	if (!(await ownDraft(ctx, draftId, userId))) invalid('Not found', 404);
	await ctx.media.multipart?.abort(claim.key, claim.uploadId).catch(() => {});
	return { ok: true as const };
}

function readParts(value: unknown, count: number): { partNumber: number; etag: string }[] | null {
	if (!Array.isArray(value) || value.length !== count) return null;
	const parts: { partNumber: number; etag: string }[] = [];
	for (let i = 0; i < value.length; i++) {
		const part = value[i] as { partNumber?: unknown; etag?: unknown } | null;
		if (part?.partNumber !== i + 1 || typeof part.etag !== 'string' || !part.etag) return null;
		parts.push({ partNumber: i + 1, etag: part.etag });
	}
	return parts;
}

async function keyInUse(db: OperationContext['db'], key: string): Promise<boolean> {
	const rows = await db
		.select({ id: draftMedia.id })
		.from(draftMedia)
		.where(eq(draftMedia.storageKey, key))
		.limit(1);
	return rows.length > 0;
}

/**
 * Decide on a video already in storage: the size must be the one the checks
 * ran against, and the file must be a video the server can read. Anything
 * refused here is deleted, so a failed upload leaves nothing behind.
 */
async function recordStoredVideo(
	ctx: OperationContext,
	draft: { id: string; baseBody: string | null; userId: string },
	video: {
		key: string;
		size: number;
		expectedSize?: number;
		segmentIndex: number;
		altText: unknown;
	}
) {
	let stored = false;
	try {
		if (video.expectedSize !== undefined && video.size !== video.expectedSize) {
			invalid('The upload is not the size it started as');
		}
		const facts = requirePlayableVideo(await probeStoredVideo(ctx.media, video.key, video.size));
		const problem = await videoSlotProblem(ctx, draft, video.segmentIndex);
		if (problem) invalid(problem.message, problem.status);
		const siblings = await ctx.db
			.select({ id: draftMedia.id })
			.from(draftMedia)
			.where(
				and(eq(draftMedia.draftId, draft.id), eq(draftMedia.segmentIndex, video.segmentIndex))
			);
		const [media] = await ctx.db
			.insert(draftMedia)
			.values({
				id: newId(),
				draftId: draft.id,
				storageKey: video.key,
				mime: 'video/mp4',
				size: video.size,
				width: facts.width,
				height: facts.height,
				metaJson: JSON.stringify(videoMetaFrom(facts)),
				altText: cleanAltText(video.altText),
				sortOrder: siblings.length,
				segmentIndex: video.segmentIndex,
				createdAt: new Date()
			})
			.returning();
		stored = true;
		return { media: serializeMedia(media) };
	} finally {
		// A replayed `complete` for an upload that already landed is refused
		// as a second video; the object it names belongs to the first row.
		if (!stored && !(await keyInUse(ctx.db, video.key))) {
			await deleteMediaObjects(ctx.media, [video.key]).catch(() => {});
		}
	}
}

/** Join the parts of an upload and attach the video they make. */
export async function completeVideoUpload(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	body: Record<string, unknown>
) {
	const claim = await verifiedClaim(ctx, draftId, body);
	const parts = readParts(body.parts, partCount(claim.size));
	if (!parts) invalid('parts must list every part in order');
	const draft = await editableDraft(ctx, userId, draftId);
	if (!ctx.media.multipart) invalid('This storage cannot take uploads in parts', 501);
	const size = await ctx.media.multipart.complete(claim.key, claim.uploadId, parts);
	return recordStoredVideo(ctx, draft, {
		key: claim.key,
		size,
		expectedSize: claim.size,
		segmentIndex: claim.segmentIndex,
		altText: body.altText
	});
}

/**
 * The largest image an agent may send inline as base64. An MCP message is one
 * JSON body that the Worker parses whole, and base64 adds a third: 3 MB of
 * image is a 4 MB message, small enough for clients that cap tool arguments
 * and for the CPU a Workers Free request gets to parse it. Anything larger
 * goes by URL or in parts.
 */
export const BASE64_MAX_BYTES = 3_000_000;

/** Attach a small image sent inline. Video never goes this way. */
export async function attachBase64Image(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	input: { data: string; segmentIndex?: number; altText?: string | null }
) {
	const draft = await editableDraft(ctx, userId, draftId);
	const bytes = base64Payload(
		input.data,
		BASE64_MAX_BYTES,
		`Inline images are limited to ${BASE64_MAX_BYTES / 1_000_000}MB; use attach_media with a url, or media_upload, for larger files`
	);
	const mime = detectImageMime(bytes);
	if (!mime) {
		invalid(
			isMp4(bytes)
				? 'Videos cannot be sent inline; use attach_media with a url, or media_upload'
				: 'data is not a PNG, JPEG, WebP or GIF image'
		);
	}
	const items = await attachFiles(ctx, userId, draft.id, async () => ({
		segmentIndex: parseSegmentIndex(input.segmentIndex ?? 0),
		altText: cleanAltText(input.altText),
		files: [{ file: new Blob([bytes as BlobPart], { type: mime }) }]
	}));
	return { media: items[0] };
}

type Base64Decoder = (input: string) => Uint8Array;

// The native decoder where the runtime has one: a JavaScript loop over a few
// million characters is CPU the Workers Free plan's 10 ms cannot spare.
function decodeBase64(input: string): Uint8Array {
	const native = (Uint8Array as unknown as { fromBase64?: Base64Decoder }).fromBase64;
	if (native) return native(input);
	const binary = atob(input);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** Decode base64 (a `data:` URL prefix allowed), refusing more than `max` bytes before decoding. */
function base64Payload(data: string, max: number, tooLarge: string): Uint8Array {
	const cleaned = data.replace(/^data:[^;,]*;base64,/i, '').replace(/\s+/g, '');
	if (Math.floor((cleaned.length * 3) / 4) > max + 2) invalid(tooLarge, 413);
	if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(cleaned)) invalid('data is not valid base64');
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64(cleaned.replace(/-/g, '+').replace(/_/g, '/'));
	} catch {
		invalid('data is not valid base64');
	}
	if (bytes.length > max) invalid(tooLarge, 413);
	return bytes;
}

function isMp4(head: Uint8Array): boolean {
	return validateVideoUpload({ mime: 'video/mp4', size: head.length || 1, bytes: head }).ok;
}

/** Outbound calls an attach-by-URL needs besides its parts: redirects, D1, the probe, cleanup. */
const URL_ATTACH_RESERVE = 26;
const URL_FETCH_TIMEOUT_MS = 120_000;
const URL_MAX_REDIRECTS = 3;

/** The largest video this request could still fetch by URL, set by its call budget. */
function urlVideoLimit(ctx: OperationContext): number {
	const parts = ctx.budget
		? Math.max(0, ctx.budget.remaining - URL_ATTACH_RESERVE)
		: Number.POSITIVE_INFINITY;
	return Math.min(MAX_VIDEO_BYTES, parts * UPLOAD_PART_BYTES);
}

/** The ways an agent can get a file in, and how large each may be. */
export function attachLimits(ctx: OperationContext) {
	return {
		base64MaxBytes: BASE64_MAX_BYTES,
		base64Types: 'images only',
		urlImageMaxBytes: MAX_IMAGE_BYTES,
		urlVideoMaxBytes: urlVideoLimit(ctx),
		uploadSessionMaxBytes: MAX_VIDEO_BYTES,
		uploadPartBytes: UPLOAD_PART_BYTES,
		coverMaxBytes: MAX_COVER_BYTES,
		segments:
			'segmentIndex 0 is the first post of a thread; media on segment n goes with post n. Platforms without threads join every segment into one post.'
	};
}

/** A cover's JPEG, sent inline or fetched from a public URL. */
export async function coverBytes(
	ctx: OperationContext,
	input: { data?: string; url?: string },
	fetchImpl: FetchLike = fetch
): Promise<Uint8Array> {
	const tooLarge = `Cover must be ${MAX_COVER_BYTES / 1_000_000}MB or smaller`;
	if (input.data !== undefined) return base64Payload(input.data, MAX_COVER_BYTES, tooLarge);
	if (!input.url) invalid('data or url required');
	const outbound = ctx.budget ? countingFetch(fetchImpl, ctx.budget) : fetchImpl;
	const fetched = await fetchPublic(input.url, outbound, {
		accept: 'image/jpeg,image/*;q=0.8',
		userAgent: 'cogsend/1.0 (+media-attach)',
		timeoutMs: 30_000,
		maxRedirects: URL_MAX_REDIRECTS
	});
	try {
		if (!fetched.response.ok) invalid(`The URL answered ${fetched.response.status}`);
		return await readCappedBody(fetched.response, MAX_COVER_BYTES).catch((err) => {
			if ((err as { status?: number }).status === 400) invalid(tooLarge, 413);
			throw err;
		});
	} finally {
		fetched.done();
	}
}

function tooLargeForUrl(limit: number): never {
	invalid(
		`This file is larger than ${Math.floor(limit / 1_000_000)}MB, the most one request can fetch here; upload it with media_upload (action start) instead`,
		413,
		{ useUploadSession: true, maxBytes: limit }
	);
}

/** Read from `reader` until at least `n` bytes have arrived, or it ends. */
async function readHead(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	n: number
): Promise<{ chunks: Uint8Array[]; bytes: number; ended: boolean }> {
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	while (bytes < n) {
		const { done, value } = await reader.read();
		if (done) return { chunks, bytes, ended: true };
		chunks.push(value);
		bytes += value.byteLength;
	}
	return { chunks, bytes, ended: false };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/**
 * Stream a video into storage in parts of UPLOAD_PART_BYTES, so at most one
 * part is ever held in the isolate however large the file is. Every part is a
 * storage call, so the most this request may take is set by its call budget.
 */
async function streamVideoToStore(
	ctx: OperationContext,
	reader: ReadableStreamDefaultReader<Uint8Array>,
	head: Uint8Array[],
	limit: number
): Promise<{ key: string; size: number }> {
	const multipart = ctx.media.multipart;
	if (!multipart) invalid('This storage cannot take uploads in parts', 501);
	const key = newVideoKey();
	const uploadId = await multipart.create(key, 'video/mp4');
	const parts: { partNumber: number; etag: string }[] = [];
	let part = new Uint8Array(UPLOAD_PART_BYTES);
	let filled = 0;
	let total = 0;
	const flush = async (length: number) => {
		parts.push(
			await multipart.uploadPart(key, uploadId, parts.length + 1, part.subarray(0, length))
		);
		part = new Uint8Array(UPLOAD_PART_BYTES);
		filled = 0;
	};
	const take = async (chunk: Uint8Array) => {
		total += chunk.byteLength;
		if (total > limit) tooLargeForUrl(limit);
		let offset = 0;
		while (offset < chunk.byteLength) {
			const n = Math.min(UPLOAD_PART_BYTES - filled, chunk.byteLength - offset);
			part.set(chunk.subarray(offset, offset + n), filled);
			filled += n;
			offset += n;
			if (filled === UPLOAD_PART_BYTES) await flush(filled);
		}
	};
	try {
		for (const chunk of head) await take(chunk);
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			await take(value);
		}
		if (filled > 0 || parts.length === 0) await flush(filled);
		const size = await multipart.complete(key, uploadId, parts);
		return { key, size };
	} catch (err) {
		await multipart.abort(key, uploadId).catch(() => {});
		throw err;
	}
}

/**
 * Fetch a public image or MP4 into a draft. The URL and every redirect are
 * checked against private, loopback, link-local and metadata hosts before the
 * server connects; the type is decided by the file's own first bytes, not the
 * server's Content-Type; and the size cap holds while the body streams, so a
 * server that lies about its length or never stops is cut off.
 */
export async function attachMediaFromUrl(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	input: { url: string; segmentIndex?: number; altText?: string | null },
	fetchImpl: FetchLike = fetch
) {
	const draft = await editableDraft(ctx, userId, draftId);
	const segmentIndex = parseSegmentIndex(input.segmentIndex ?? 0);
	const segment = await segmentProblem(ctx, draft, segmentIndex);
	if (segment) invalid(segment);
	const altText = cleanAltText(input.altText);
	const videoLimit = urlVideoLimit(ctx);
	const outbound = ctx.budget ? countingFetch(fetchImpl, ctx.budget) : fetchImpl;
	const fetched = await fetchPublic(input.url, outbound, {
		accept: 'image/*,video/mp4;q=0.9,*/*;q=0.1',
		userAgent: 'cogsend/1.0 (+media-attach)',
		timeoutMs: URL_FETCH_TIMEOUT_MS,
		maxRedirects: URL_MAX_REDIRECTS
	});
	const res = fetched.response;
	try {
		if (!res.ok) {
			invalid(`The URL answered ${res.status}`, res.status >= 500 ? 502 : 400);
		}
		const declared = Number(res.headers.get('content-length') ?? '');
		const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
		if (Number.isFinite(declared) && declared > Math.max(MAX_IMAGE_BYTES, videoLimit)) {
			tooLargeForUrl(Math.max(MAX_IMAGE_BYTES, videoLimit));
		}
		if (!res.body) invalid('The URL returned no file');
		const reader = res.body.getReader();
		try {
			const head = await readHead(reader, 16);
			const start = concat(head.chunks, head.bytes);
			const imageMime = detectImageMime(start);
			if (imageMime) {
				if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
					invalid('Image must be 16MB or smaller', 413);
				}
				const chunks = [...head.chunks];
				let total = head.bytes;
				if (!head.ended) {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						total += value.byteLength;
						if (total > MAX_IMAGE_BYTES) invalid('Image must be 16MB or smaller', 413);
						chunks.push(value);
					}
				}
				const bytes = concat(chunks, total);
				const items = await attachFiles(ctx, userId, draftId, async () => ({
					segmentIndex,
					altText,
					files: [{ file: new Blob([bytes as BlobPart], { type: imageMime }) }]
				}));
				return { media: items[0], sourceUrl: fetched.url };
			}
			if (!isMp4(start)) {
				invalid(
					`The URL is not a PNG, JPEG, WebP or GIF image or an MP4 video (it sent ${contentType || 'an unknown type'})`
				);
			}
			// Refuse a video the draft cannot take before moving its bytes.
			const slot = await videoSlotProblem(ctx, draft, segmentIndex);
			if (slot) invalid(slot.message, slot.status);
			if (Number.isFinite(declared) && declared > videoLimit) tooLargeForUrl(videoLimit);
			const stored = await streamVideoToStore(ctx, reader, head.chunks, videoLimit);
			const recorded = await recordStoredVideo(ctx, draft, {
				key: stored.key,
				size: stored.size,
				segmentIndex,
				altText
			});
			return { ...recorded, sourceUrl: fetched.url };
		} finally {
			await reader.cancel().catch(() => {});
		}
	} finally {
		fetched.done();
	}
}

/**
 * Everything an agent needs to send a large video over plain HTTP with its
 * own API key, in the same parts the composer uses: the REST part route is the
 * only way the bytes travel, so MCP never carries them.
 */
export async function createMediaUpload(
	ctx: OperationContext,
	userId: string,
	draftId: string,
	input: { size: number; mime?: string; segmentIndex?: number },
	appUrl: string
) {
	const upload = await startVideoUpload(ctx, userId, draftId, {
		size: input.size,
		mime: input.mime ?? 'video/mp4',
		segmentIndex: input.segmentIndex ?? 0
	});
	const base = `${appUrl.replace(/\/+$/, '')}/api/drafts/${encodeURIComponent(draftId)}/media/uploads`;
	const claim = {
		key: upload.key,
		uploadId: upload.uploadId,
		size: String(upload.size),
		segmentIndex: String(upload.segmentIndex),
		token: upload.token
	};
	const partList = Array.from({ length: upload.parts }, (_, i) => {
		const n = i + 1;
		const offset = i * upload.partSize;
		const length = Math.min(upload.partSize, upload.size - offset);
		const query = new URLSearchParams({ ...claim, n: String(n) });
		return { partNumber: n, offset, length, url: `${base}/part?${query.toString()}` };
	});
	return {
		upload: { ...upload },
		parts: partList,
		request: {
			method: 'PUT',
			headers: {
				Authorization: 'Bearer <your CogSend API key>',
				'Content-Type': 'application/octet-stream',
				'Content-Length': '<the part length>'
			},
			body: 'bytes offset to offset + length - 1 of the file',
			response: '{ "partNumber": n, "etag": "…" }'
		},
		complete: {
			tool: 'media_upload (action complete)',
			method: 'POST',
			url: `${base}/complete`,
			body: { ...upload, parts: '[{ "partNumber": 1, "etag": "…" }, …] in order' }
		},
		abort: { method: 'DELETE', url: base, body: { ...upload } }
	};
}
