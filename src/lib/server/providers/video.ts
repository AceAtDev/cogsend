import { videoMixProblem } from '#lib/domain/media-limits.js';
import {
	factsOfMedia,
	videoIssues,
	type VideoFacts,
	type VideoRuleMeta
} from '#lib/domain/video-rules.js';
import type { MediaAttachment, MediaReader, ValidationIssue } from './types';

export function isVideoAttachment(m: { mime?: string | null }): boolean {
	return (m.mime ?? '').toLowerCase().startsWith('video/');
}

/** The single video of a segment, or null when it carries images or nothing. */
export function segmentVideo(media: MediaAttachment[] | undefined): MediaAttachment | null {
	const list = media ?? [];
	return list.length === 1 && isVideoAttachment(list[0]) ? list[0] : null;
}

export function videoFactsOf(m: MediaAttachment): VideoFacts {
	return factsOfMedia({ ...m, meta: m.video });
}

/**
 * The composer's checks, run again at publish: an API client or an older draft
 * can reach here without them. Warnings stay in the composer.
 */
export function videoValidation(
	platform: string,
	media: MediaAttachment[] | undefined,
	meta: VideoRuleMeta | null | undefined,
	field: string
): ValidationIssue[] {
	const list = media ?? [];
	const videos = list.filter(isVideoAttachment);
	if (!videos.length) return [];
	const mix = videoMixProblem(videos.length, list.length - videos.length);
	if (mix) return [{ field, message: mix, code: 'video_mix' }];
	return videoIssues(platform, videoFactsOf(videos[0]), meta)
		.filter((issue) => issue.level === 'error')
		.map((issue) => ({ field, message: issue.message, code: 'video' }));
}

export const MISSING_VIDEO_MESSAGE = 'The video file is missing from storage — attach it again';

export function requireMediaReader(reader: MediaReader | undefined): MediaReader {
	if (!reader) throw new Error('Publishing a video needs the media store');
	return reader;
}

/** Bytes `start`..`end` inclusive of a stored video. */
export async function readVideoSlice(
	reader: MediaReader,
	storageKey: string,
	start: number,
	end: number
): Promise<Uint8Array> {
	const bytes = await reader.getRange(storageKey, start, end);
	if (!bytes) throw new Error(MISSING_VIDEO_MESSAGE);
	return bytes;
}

/**
 * Bytes `start`–`end` of a stored video as a stream with a known length, so a
 * chunk goes out without being copied into memory first: copying a 5–20 MB
 * part each time costs CPU time a Free-plan request does not have.
 */
export async function openVideoRange(
	reader: MediaReader,
	storageKey: string,
	start: number,
	end: number
): Promise<{ body: ReadableStream<Uint8Array>; length: number }> {
	const opened = await reader.open(storageKey, { start, end });
	if (!opened) throw new Error(MISSING_VIDEO_MESSAGE);
	const length = end - start + 1;
	return { body: fixedLengthBody(opened.body as ReadableStream<Uint8Array>, length), length };
}

/**
 * A multipart/form-data body of `fields` then one streamed file part, with
 * its exact length, without buffering the file.
 */
export function streamedMultipart(
	fields: Record<string, string>,
	file: {
		name: string;
		filename: string;
		mime: string;
		body: ReadableStream<Uint8Array>;
		length: number;
	},
	boundary: string
): { body: ReadableStream<Uint8Array>; length: number; contentType: string } {
	const enc = new TextEncoder();
	let head = '';
	for (const [name, value] of Object.entries(fields)) {
		head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
	}
	head += `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`;
	const before = enc.encode(head);
	const after = enc.encode(`\r\n--${boundary}--\r\n`);
	const length = before.length + file.length + after.length;
	return {
		body: fixedLengthBody(wrapStream(before, file.body, after), length),
		length,
		contentType: `multipart/form-data; boundary=${boundary}`
	};
}

/** The size the store reports, which is what gets uploaded. */
export async function storedVideoSize(reader: MediaReader, storageKey: string): Promise<number> {
	const size = await reader.size(storageKey);
	if (size == null) throw new Error(MISSING_VIDEO_MESSAGE);
	return size;
}

/**
 * Workers send a stream of unknown length chunked, which upload endpoints
 * refuse; FixedLengthStream gives the request a Content-Length without
 * buffering the file. Elsewhere (tests, Node) the stream goes as it is.
 */
export function fixedLengthBody(body: ReadableStream, size: number): ReadableStream {
	const Fixed = (globalThis as { FixedLengthStream?: new (n: number) => TransformStream })
		.FixedLengthStream;
	return Fixed ? body.pipeThrough(new Fixed(size)) : body;
}

/** `before`, then the stored file as it streams, then `after`. */
export function wrapStream(
	before: Uint8Array,
	file: ReadableStream<Uint8Array>,
	after: Uint8Array
): ReadableStream<Uint8Array> {
	const reader = file.getReader();
	let started = false;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (!started) {
				started = true;
				controller.enqueue(before);
				return;
			}
			const { done, value } = await reader.read();
			if (done) {
				controller.enqueue(after);
				controller.close();
				return;
			}
			controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		}
	});
}

/**
 * Below this much time a run parks instead of sending another part: a part
 * cut off half-way is sent again, but a run cut off between writes leaves the
 * post stuck as Sending until its claim goes stale.
 */
export const PART_UPLOAD_MS = 10_000;

/**
 * Ask `check` until it answers, at most `polls` times and only while the
 * request has `reserve` calls and the time for another wait left, sleeping between asks but never before
 * giving up. Null means "not ready": the caller parks the video.
 */
export async function pollVideo<T>(
	opts: {
		polls: number;
		delayMs: number;
		reserve: number;
		callsLeft?: () => number;
		timeLeft?: () => number;
	},
	check: () => Promise<T | null>
): Promise<T | null> {
	const callsLeft = opts.callsLeft ?? (() => Infinity);
	const timeLeft = opts.timeLeft ?? (() => Infinity);
	for (let poll = 0; poll < opts.polls && callsLeft() >= opts.reserve; poll++) {
		const done = await check();
		if (done !== null) return done;
		if (poll + 1 >= opts.polls || callsLeft() < opts.reserve || timeLeft() <= opts.delayMs) break;
		await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
	}
	return null;
}
