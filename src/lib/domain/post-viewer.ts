import { isPlatformId, platformName, type PlatformId } from './platforms.js';

export type ViewerProfile = {
	name: string;
	layout: 'grid' | 'carousel';
	captionFirst: boolean;
	captionLimit: number;
	avatar: 'circle' | 'square';
};

/** Feed conventions, not a promise of pixel-identical third-party UI. */
export const VIEWER_PROFILES: Record<PlatformId, ViewerProfile> = {
	x: { name: 'X', layout: 'grid', captionFirst: true, captionLimit: 280, avatar: 'circle' },
	threads: {
		name: 'Threads',
		layout: 'carousel',
		captionFirst: true,
		captionLimit: 300,
		avatar: 'circle'
	},
	instagram: {
		name: 'Instagram',
		layout: 'carousel',
		captionFirst: false,
		captionLimit: 125,
		avatar: 'circle'
	},
	tiktok: {
		name: 'TikTok',
		layout: 'carousel',
		captionFirst: false,
		captionLimit: 150,
		avatar: 'circle'
	},
	linkedin: {
		name: 'LinkedIn',
		layout: 'grid',
		captionFirst: true,
		captionLimit: 210,
		avatar: 'square'
	},
	mastodon: {
		name: 'Mastodon',
		layout: 'grid',
		captionFirst: true,
		captionLimit: 500,
		avatar: 'square'
	},
	bluesky: {
		name: 'Bluesky',
		layout: 'grid',
		captionFirst: true,
		captionLimit: 300,
		avatar: 'circle'
	}
};

export function viewerProfile(platform: string): ViewerProfile {
	return isPlatformId(platform)
		? VIEWER_PROFILES[platform]
		: {
				name: platformName(platform) || 'Post',
				layout: 'grid',
				captionFirst: true,
				captionLimit: 280,
				avatar: 'circle'
			};
}

export function clampSlide(index: number, count: number): number {
	if (!Number.isFinite(index) || count <= 0) return 0;
	return Math.max(0, Math.min(count - 1, Math.trunc(index)));
}

export function stepSlide(index: number, delta: number, count: number): number {
	return clampSlide(clampSlide(index, count) + delta, count);
}

/** Only a deliberate horizontal swipe changes a slide; vertical scrolling remains native. */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
	if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.3) return 0;
	return dx < 0 ? 1 : -1;
}

export function captionPreview(content: string, limit: number, expanded: boolean): string {
	const characters = Array.from(content);
	return expanded || characters.length <= limit
		? content
		: `${characters.slice(0, limit).join('').trimEnd()}…`;
}

export function segmentItems<T extends { segmentIndex?: number | null }>(
	items: T[],
	segment: number,
	segmentCount: number,
	segmentIndices?: number[]
): T[] {
	const storedIndex = segmentIndices?.[segment] ?? segment;
	return segmentIndices?.length || segmentCount > 1
		? items.filter((item) => (item.segmentIndex ?? 0) === storedIndex)
		: items;
}

/** Translate a flattened route attachment index into the owning thread post and local slide. */
export function initialPosition<T extends { segmentIndex?: number | null }>(
	items: T[],
	initialIndex: number,
	segmentCount: number,
	segmentIndices?: number[]
): { segment: number; index: number } {
	const initial = clampSlide(initialIndex, items.length);
	const storedIndex = items[initial]?.segmentIndex ?? 0;
	const segment = clampSlide(
		segmentIndices ? segmentIndices.indexOf(storedIndex) : storedIndex,
		segmentCount || 1
	);
	return {
		segment,
		index:
			segmentIndices?.length || segmentCount > 1
				? segmentItems(items.slice(0, initial), segment, segmentCount, segmentIndices).length
				: initial
	};
}
