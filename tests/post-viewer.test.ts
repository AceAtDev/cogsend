import { describe, expect, it } from 'vitest';
import { PLATFORM_IDS } from '#lib/domain/platforms.js';
import {
	captionPreview,
	clampSlide,
	initialPosition,
	segmentItems,
	stepSlide,
	swipeStep,
	viewerProfile,
	VIEWER_PROFILES
} from '#lib/domain/post-viewer.js';
import {
	clampPxPerCm,
	feedAspect,
	formatCm,
	phoneById,
	phoneLayout,
	PHONES,
	screenCm,
	toCm
} from '#lib/domain/true-size.js';

describe('provider viewer model', () => {
	it('isolates thread attachments and translates a flattened selected attachment index', () => {
		const media = [
			{ id: 'a', segmentIndex: null },
			{ id: 'b', segmentIndex: 1 },
			{ id: 'c', segmentIndex: 1 },
			{ id: 'd', segmentIndex: 2 }
		];
		expect(segmentItems(media, 0, 3).map((item) => item.id)).toEqual(['a']);
		expect(segmentItems(media, 1, 3).map((item) => item.id)).toEqual(['b', 'c']);
		expect(initialPosition(media, 2, 3)).toEqual({ segment: 1, index: 1 });
		expect(initialPosition(media, 3, 3)).toEqual({ segment: 2, index: 0 });
		expect(initialPosition(media, 0, 0)).toEqual({ segment: 0, index: 0 });
		expect(segmentItems(media, 0, 0)).toBe(media);
		expect(segmentItems(media, 0, 1)).toBe(media);
		expect(segmentItems(media, 0, 1, [2]).map((item) => item.id)).toEqual(['d']);
		expect(initialPosition(media, 3, 2, [0, 2])).toEqual({ segment: 1, index: 0 });
	});
	it('defines every supported provider with a distinct named profile', () => {
		expect(Object.keys(VIEWER_PROFILES).sort()).toEqual([...PLATFORM_IDS].sort());
		for (const platform of PLATFORM_IDS) expect(viewerProfile(platform).name).toBeTruthy();
	});
	it('distinguishes native carousel and grid feed conventions', () => {
		for (const platform of ['instagram', 'tiktok', 'threads'])
			expect(viewerProfile(platform).layout).toBe('carousel');
		for (const platform of ['x', 'linkedin', 'mastodon', 'bluesky'])
			expect(viewerProfile(platform).layout).toBe('grid');
		expect(viewerProfile('unknown').name).toBe('Unknown');
	});
	it('keeps slide navigation bounded without wrapping', () => {
		expect(clampSlide(50, 4)).toBe(3);
		expect(clampSlide(-1, 4)).toBe(0);
		expect(clampSlide(NaN, 4)).toBe(0);
		expect(clampSlide(4, 0)).toBe(0);
		expect(stepSlide(0, -1, 4)).toBe(0);
		expect(stepSlide(3, 1, 4)).toBe(3);
		expect(stepSlide(1, 1, 4)).toBe(2);
	});
	it('requires a deliberate horizontal swipe and preserves vertical scroll', () => {
		expect(swipeStep(-80, 10)).toBe(1);
		expect(swipeStep(80, 10)).toBe(-1);
		expect(swipeStep(-20, 1)).toBe(0);
		expect(swipeStep(60, 90)).toBe(0);
	});
	it('expands the full caption and never cuts a unicode code point in half', () => {
		expect(captionPreview('Hello world', 5, false)).toBe('Hello…');
		expect(captionPreview('Hello world', 5, true)).toBe('Hello world');
		expect(captionPreview('😀😀😀', 2, false)).toBe('😀😀…');
		expect(captionPreview('short', 20, false)).toBe('short');
	});
});

describe('true-size phone preview', () => {
	it('derives the physical screen from panel pixels and density', () => {
		const iphone = screenCm(phoneById('iphone-6-1'));
		expect(iphone.width).toBeCloseTo(6.51, 2);
		expect(iphone.height).toBeCloseTo(14.11, 2);
		expect(phoneById('unknown').id).toBe(PHONES[0].id);
	});

	it('scales the app viewport to the real screen width and never hides a shrink', () => {
		const phone = phoneById('iphone-6-1');
		const roomy = phoneLayout(phone, 50, { width: 2000, height: 2000 }, 0);
		expect(roomy.fit).toBe(1);
		expect(phone.viewport.width * roomy.scale).toBeCloseTo(screenCm(phone).width * 50, 6);
		const tight = phoneLayout(phone, 50, { width: 2000, height: 400 }, 0);
		expect(tight.fit).toBeLessThan(1);
		expect(tight.frame.height).toBeCloseTo(400, 6);
		expect(toCm(100 * tight.fit, 50, tight.fit)).toBeCloseTo(2, 6);
	});

	it('rejects nonsense calibration and crops Instagram feed media to its allowed range', () => {
		expect(clampPxPerCm(Number.NaN)).toBeNull();
		expect(clampPxPerCm(5)).toBe(20);
		expect(clampPxPerCm(500)).toBe(120);
		expect(feedAspect('instagram', 9 / 16)).toBe(0.8);
		expect(feedAspect('instagram', 3)).toBe(1.91);
		expect(feedAspect('tiktok', 9 / 16)).toBe(9 / 16);
		expect(formatCm(6.512, 8.14)).toBe('6.5 × 8.1 cm');
	});
});
