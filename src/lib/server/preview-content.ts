import { supportsThreads } from '#lib/domain/platforms.js';
import { joinThreadTexts, resolvePublishSegments } from '#lib/domain/thread-segments.js';
import { readTiktokChoices } from '#lib/domain/tiktok.js';

/** Photo titles survive media replacement in saved choices, but are never sent for videos. */
export function previewPhotoTitle(
	platform: string,
	options: Record<string, unknown>,
	connectionId: string,
	media: Array<{ mime: string }>
): string | null {
	if (
		platform !== 'tiktok' ||
		!media.some((m) => m.mime.startsWith('image/')) ||
		media.some((m) => m.mime.startsWith('video/'))
	)
		return null;
	return readTiktokChoices(options.tiktok)[connectionId]?.title ?? null;
}

/** Match normalizeDraftContent and the single-post providers' flattening, without media reads. */
export function previewContent(
	body: string,
	options: Record<string, unknown>,
	media: Array<{ segmentIndex?: number | null }>,
	platform: string
): { previewSegments: string[]; previewSegmentIndices?: number[] } {
	const explicit = options.threadSegments;
	const segments =
		Array.isArray(explicit) && explicit.length > 1 && explicit.every((s) => typeof s === 'string')
			? explicit.map((text, segmentIndex) => ({ text: text as string, segmentIndex }))
			: resolvePublishSegments(body, (index) => media.some((m) => (m.segmentIndex ?? 0) === index));
	if (!supportsThreads(platform)) {
		return { previewSegments: [joinThreadTexts(segments.map((s) => s.text))] };
	}
	return {
		previewSegments: segments.map((s) => s.text),
		previewSegmentIndices: segments.map((s) => s.segmentIndex)
	};
}
