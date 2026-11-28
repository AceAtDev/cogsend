import type { CalendarMedia } from '#lib/domain/calendar.js';
import {
	coverUrl,
	imageUrl,
	isVideoMedia,
	mediaUrl,
	type MediaShape
} from '#lib/domain/media-layout.js';

export type Thumb = { url: string | null; video: boolean };

/** The first attachment as a small picture: an image's light copy, a video's chosen cover. */
export function thumbOf(media: CalendarMedia[] | undefined): Thumb | null {
	const first = media?.find((m) => m.storageKey);
	if (!first) return null;
	const shape = first as MediaShape;
	return isVideoMedia(first)
		? { url: coverUrl(shape), video: true }
		: { url: imageUrl(shape), video: false };
}

/** Full-size sources for the preview window. */
export function sourceOf(m: CalendarMedia): { src: string; poster: string | null; video: boolean } {
	const shape = m as MediaShape;
	return isVideoMedia(m)
		? { src: mediaUrl(m), poster: coverUrl(shape), video: true }
		: { src: imageUrl(shape), poster: null, video: false };
}
