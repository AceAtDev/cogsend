import { describe, expect, it } from 'vitest';
import {
	compactCount,
	engagementOf,
	LINKEDIN_PERSONAL_MESSAGE,
	metricsSupport,
	nextAfterFailure,
	NOT_COLLECTED_YET,
	planAfterRead,
	retryDelayMs,
	SNAPSHOT_WINDOW_MS,
	TIKTOK_RECONNECT_MESSAGE
} from '#lib/domain/metrics.js';

const H = 3_600_000;
const D = 24 * H;
const published = Date.UTC(2026, 9, 1, 9, 0);

describe('snapshot schedule', () => {
	it('takes the first snapshot about an hour in, then a day, then a week', () => {
		const first = planAfterRead(published, 0, published + H + 60_000);
		expect(first).toEqual({ stage: 1, nextDueAt: published + D, kind: '1h' });
		const second = planAfterRead(published, 1, published + D + 5 * 60_000);
		expect(second).toEqual({ stage: 2, nextDueAt: published + 7 * D, kind: '24h' });
		const third = planAfterRead(published, 2, published + 7 * D + 60_000);
		expect(third).toEqual({ stage: 3, nextDueAt: null, kind: '7d' });
	});

	it('counts every offset a late tick passed as taken, instead of catching up one by one', () => {
		expect(planAfterRead(published, 0, published + 30 * H)).toEqual({
			stage: 2,
			nextDueAt: published + 7 * D,
			kind: '24h'
		});
	});

	it('labels a read before the next offset as on demand and keeps the plan', () => {
		expect(planAfterRead(published, 0, published + 10 * 60_000)).toEqual({
			stage: 0,
			nextDueAt: published + H,
			kind: 'manual'
		});
		expect(planAfterRead(published, 1, published + 3 * H)).toEqual({
			stage: 1,
			nextDueAt: published + D,
			kind: 'manual'
		});
	});

	it('stops scheduling once the window after the week snapshot has passed', () => {
		expect(planAfterRead(published, 3, published + 30 * D)).toEqual({
			stage: 3,
			nextDueAt: null,
			kind: 'manual'
		});
		expect(planAfterRead(published, 2, published + SNAPSHOT_WINDOW_MS + 1).nextDueAt).toBeNull();
	});
});

describe('backoff after a failed read', () => {
	it('doubles from 15 minutes and caps at six hours', () => {
		expect(retryDelayMs(0)).toBe(15 * 60_000);
		expect(retryDelayMs(1)).toBe(30 * 60_000);
		expect(retryDelayMs(3)).toBe(2 * H);
		expect(retryDelayMs(9)).toBe(6 * H);
	});

	it('follows what the platform asked for, within a minute and six hours', () => {
		expect(retryDelayMs(0, 120_000)).toBe(120_000);
		expect(retryDelayMs(0, 1000)).toBe(60_000);
		expect(retryDelayMs(0, 48 * H)).toBe(6 * H);
	});

	it('never schedules a deleted, unsupported or unreadable post again', () => {
		for (const state of ['not_found', 'unsupported', 'unavailable'] as const)
			expect(
				nextAfterFailure({ state, publishedAt: published, failures: 0, now: published + H })
			).toBe(null);
	});

	it('looks at a reconnect state once a day, and stops after the window', () => {
		expect(
			nextAfterFailure({
				state: 'reconnect',
				publishedAt: published,
				failures: 0,
				now: published + H
			})
		).toBe(published + H + D);
		expect(
			nextAfterFailure({
				state: 'error',
				publishedAt: published,
				failures: 0,
				now: published + SNAPSHOT_WINDOW_MS
			})
		).toBeNull();
	});
});

describe('which accounts give metrics', () => {
	it('collects Bluesky, Mastodon and TikTok accounts with video.list', () => {
		expect(metricsSupport({ platform: 'bluesky' }).supported).toBe(true);
		expect(metricsSupport({ platform: 'mastodon' }).supported).toBe(true);
		expect(
			metricsSupport({
				platform: 'tiktok',
				scopes: ['user.info.basic', 'video.publish', 'video.list']
			}).supported
		).toBe(true);
	});

	it('asks an older TikTok connection to reconnect rather than failing', () => {
		expect(
			metricsSupport({ platform: 'tiktok', scopes: ['user.info.basic', 'video.publish'] })
		).toEqual({ supported: false, state: 'reconnect', reason: TIKTOK_RECONNECT_MESSAGE });
	});

	it('reads LinkedIn company pages only', () => {
		expect(metricsSupport({ platform: 'linkedin' })).toEqual({
			supported: false,
			state: 'unsupported',
			reason: LINKEDIN_PERSONAL_MESSAGE
		});
		expect(metricsSupport({ platform: 'linkedin', linkedinOrganization: true }).supported).toBe(
			true
		);
	});

	it('says Instagram, Threads, X and Zernio accounts are not collected yet', () => {
		for (const platform of ['instagram', 'threads', 'x'])
			expect(metricsSupport({ platform })).toMatchObject({
				supported: false,
				reason: NOT_COLLECTED_YET
			});
		expect(metricsSupport({ platform: 'bluesky', zernio: true }).supported).toBe(false);
	});
});

describe('numbers', () => {
	it('engagement counts interactions, not reach', () => {
		expect(engagementOf({ likes: 3, comments: 2, shares: 1, quotes: 1, views: 900 })).toBe(7);
	});

	it('shortens large counts', () => {
		expect(compactCount(999)).toBe('999');
		expect(compactCount(1200)).toBe('1.2k');
		expect(compactCount(1000)).toBe('1k');
		expect(compactCount(45_600)).toBe('46k');
		expect(compactCount(2_500_000)).toBe('2.5M');
	});
});
