import { describe, expect, it, vi } from 'vitest';
import { reconcileSlotDrafts } from '#lib/domain/slot-drafts.js';
import { cancelReviewDeliveries } from '#lib/domain/review-cancel.js';
import { MAX_TARGET_CONNECTION_IDS } from '#lib/domain/request-limits.js';
import { previewPhotoTitle } from '#lib/server/preview-content.js';
import { EMPTY_TIKTOK_CHOICE } from '#lib/domain/tiktok.js';

describe('account posting-slot working copies', () => {
	it('preserves unsaved B slots, limits and pending time when saved A reloads', () => {
		const channels = ['a', 'b'].map((connectionId) => ({
			connectionId,
			rules: { slots: { mon: ['09:00'] }, maxPerDay: null, minGapMinutes: null }
		}));
		const initial = reconcileSlotDrafts(channels, {}, new Map());
		initial.drafts.b.slots.mon = ['11:00'];
		initial.drafts.b.maxPerDay = 3;
		initial.drafts.b.minGap = 45;
		initial.drafts.b.adding.tue = '12:00';
		channels[0].rules.slots.mon = ['10:00'];
		const reloaded = reconcileSlotDrafts(channels, initial.drafts, initial.signatures);
		expect(reloaded.drafts.a.slots.mon).toEqual(['10:00']);
		expect(reloaded.drafts.b).toBe(initial.drafts.b);
		expect(reloaded.drafts.b).toMatchObject({
			slots: { mon: ['11:00'] },
			maxPerDay: 3,
			minGap: 45,
			adding: { tue: '12:00' }
		});
		expect(channels[1].rules.slots.mon).toEqual(['09:00']);
	});
	it('removes disconnected accounts while preserving unchanged copies on refresh', () => {
		const channels = ['a', 'b'].map((connectionId) => ({
			connectionId,
			rules: { slots: {}, maxPerDay: null, minGapMinutes: null }
		}));
		const initial = reconcileSlotDrafts(channels, {}, new Map());
		const refreshed = reconcileSlotDrafts(channels.slice(1), initial.drafts, initial.signatures);
		expect(Object.keys(refreshed.drafts)).toEqual(['b']);
		expect(refreshed.drafts.b).toBe(initial.drafts.b);
	});
});

describe('review grouped cancellation', () => {
	it('cancels every delivery without exceeding the server request cap', async () => {
		const ids = Array.from({ length: 23 }, (_, i) => `delivery-${i}`);
		const send = vi.fn(async (batch: string[]) => ({
			results: batch.map((id) => ({ id, ok: true }))
		}));
		expect(await cancelReviewDeliveries(ids, send)).toEqual({ cancelled: 23, failures: [] });
		expect(send.mock.calls.flatMap(([batch]) => batch)).toEqual(ids);
		expect(send.mock.calls.every(([batch]) => batch.length <= MAX_TARGET_CONNECTION_IDS)).toBe(
			true
		);
	});
	it('reports HTTP-200 per-item failures and missing confirmations instead of success', async () => {
		const outcome = await cancelReviewDeliveries(['ok', 'sent', 'missing'], async () => ({
			results: [
				{ id: 'ok', ok: true },
				{ id: 'sent', ok: false, error: 'Already published' }
			]
		}));
		expect(outcome).toEqual({
			cancelled: 1,
			failures: ['Already published', 'Cancellation was not confirmed']
		});
	});
	it('retains successful batches when a later request fails', async () => {
		const ids = Array.from({ length: 11 }, (_, i) => `${i}`);
		const send = vi.fn(async (batch: string[]) => {
			if (batch.includes('10')) throw new Error('Network unavailable');
			return { results: batch.map((id) => ({ id, ok: true })) };
		});
		expect(await cancelReviewDeliveries(ids, send)).toEqual({
			cancelled: 10,
			failures: ['Network unavailable']
		});
	});
});

describe('calendar and review TikTok photo title policy', () => {
	const options = { tiktok: { account: { ...EMPTY_TIKTOK_CHOICE, title: 'Old photo title' } } };
	it('keeps the saved photo title for photo posts', () => {
		expect(previewPhotoTitle('tiktok', options, 'account', [{ mime: 'image/jpeg' }])).toBe(
			'Old photo title'
		);
	});
	it.each([
		{ kind: 'video', media: [{ mime: 'video/mp4' }] },
		{ kind: 'mixed', media: [{ mime: 'image/jpeg' }, { mime: 'video/mp4' }] },
		{ kind: 'empty', media: [] }
	])('omits stale titles for $kind media', ({ media }) => {
		expect(previewPhotoTitle('tiktok', options, 'account', media)).toBeNull();
	});
	it('does not show another platform or account title', () => {
		expect(previewPhotoTitle('instagram', options, 'account', [{ mime: 'image/jpeg' }])).toBeNull();
		expect(previewPhotoTitle('tiktok', options, 'other', [{ mime: 'image/jpeg' }])).toBeNull();
	});
});
