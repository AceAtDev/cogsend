import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	DAY_MS,
	dayKeyOf,
	droppedInstant,
	reschedulePayload,
	zonedParts
} from '#lib/domain/calendar.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	brands,
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { loadCalendar } from '#lib/server/calendar.js';
import { load as calendarLoad } from '../src/routes/calendar/+page.server';
import { POST as bulkPOST } from '../src/routes/api/targets/bulk/+server';

const TORONTO = 'America/Toronto';
// Saturday Oct 31 2026, noon in Toronto. The week shown is Oct 26 – Nov 1.
const NOW = new Date('2026-10-31T16:00:00Z');
const WEEK = {
	startMs: Date.parse('2026-10-26T04:00:00Z'),
	endMs: Date.parse('2026-11-02T05:00:00Z')
};
const ALL = { brands: [] as string[], channels: [] as string[], cancelled: false };

type LoadResult = Awaited<ReturnType<typeof loadCalendar>> & {
	loadFailed: boolean;
	timeZone: string;
	range: { start: string };
};

describe('calendar load', () => {
	let db: AppDb;
	let close: () => void;
	let count: () => number;
	let reset: () => void;
	let maxParams: () => number;
	const userId = newId();
	const otherId = newId();
	const ids: Record<string, string> = {};

	async function connection(
		name: string,
		platform: string,
		brandId: string | null,
		status = 'active',
		owner = userId
	) {
		ids[name] = newId();
		await db.insert(connections).values({
			id: ids[name],
			userId: owner,
			platform,
			handle: name,
			credentialsEncrypted: 'enc',
			status,
			brandId,
			createdAt: new Date(Object.keys(ids).length * 1000),
			updatedAt: NOW
		});
	}

	async function post(
		name: string,
		body: string,
		targets: Array<{
			conn: string;
			status?: string;
			at: string | null;
			updated?: string;
			remotePostId?: string;
		}>,
		owner = userId
	) {
		ids[name] = newId();
		await db.insert(drafts).values({
			id: ids[name],
			userId: owner,
			baseBody: body,
			status: targets.length ? 'scheduled' : 'draft',
			createdAt: NOW,
			updatedAt: NOW
		});
		for (const [i, t] of targets.entries()) {
			ids[`${name}:${t.conn}`] = newId();
			await db.insert(publishTargets).values({
				id: ids[`${name}:${t.conn}`],
				draftId: ids[name],
				connectionId: ids[t.conn],
				status: t.status ?? 'scheduled',
				scheduledFor: t.at ? new Date(t.at) : null,
				remotePostId: t.remotePostId ?? null,
				createdAt: NOW,
				updatedAt: new Date(t.updated ?? `2026-10-20T00:00:0${i}Z`)
			});
		}
	}

	beforeAll(async () => {
		const ctx = await createTestDb();
		({ db, close, count, reset, maxParams } = ctx);
		for (const [id, email] of [
			[userId, 'cal@localhost'],
			[otherId, 'other@localhost']
		]) {
			await db.insert(users).values({
				id,
				email,
				passwordHash: 'x',
				timezone: TORONTO,
				createdAt: NOW,
				updatedAt: NOW
			});
		}
		await db.insert(brands).values([
			{
				id: 'b-job',
				userId,
				name: 'JobJob',
				slug: 'jobjob',
				color: '#2563eb',
				createdAt: NOW,
				updatedAt: NOW
			},
			{
				id: 'b-cal',
				userId,
				name: '465Cal',
				slug: '465cal',
				color: '#db2777',
				createdAt: NOW,
				updatedAt: NOW
			}
		]);
		await connection('jobli', 'linkedin', 'b-job');
		await connection('jobig', 'instagram', 'b-job');
		await connection('caltt', 'tiktok', 'b-cal');
		await connection('calig', 'instagram', 'b-cal');
		await connection('mybs', 'bluesky', null);
		await connection('oldx', 'x', 'b-job', 'disconnected');
		await connection('theirs', 'mastodon', null, 'active', otherId);

		// One post to three channels, Tuesday 9:00 EDT.
		await post('launch', 'Launch day\nsecond line', [
			{ conn: 'jobli', at: '2026-10-27T13:00:00Z' },
			{ conn: 'jobig', at: '2026-10-27T13:00:00Z' },
			{ conn: 'mybs', at: '2026-10-27T13:00:00Z' }
		]);
		await db.insert(draftVariants).values({
			id: newId(),
			draftId: ids.launch,
			platform: 'linkedin',
			body: 'Launch day, LinkedIn edition',
			createdAt: NOW,
			updatedAt: NOW
		});
		await db.insert(draftMedia).values({
			id: newId(),
			draftId: ids.launch,
			storageKey: 'u/launch.jpg',
			mime: 'image/jpeg',
			size: 10,
			createdAt: NOW
		});
		// 23:30 local on Sunday Nov 1, after the DST change: 04:30 UTC Monday, still in range.
		await post('late', 'Late night', [{ conn: 'caltt', at: '2026-11-02T04:30:00Z' }]);
		// 00:30 local Monday Nov 2: the next week.
		await post('next', 'Next week', [{ conn: 'calig', at: '2026-11-02T05:30:00Z' }]);
		// 23:59 local Sunday Oct 25: the week before.
		await post('before', 'Last week', [{ conn: 'calig', at: '2026-10-26T03:59:00Z' }]);
		await post('published', 'Went out', [
			{ conn: 'calig', status: 'published', at: '2026-10-28T15:00:00Z', remotePostId: 'r1' }
		]);
		await post('now', 'Publish now', [
			{ conn: 'jobli', status: 'pending', at: null, updated: '2026-10-31T15:59:00Z' }
		]);
		await post('dropped', 'Cancelled one', [
			{ conn: 'caltt', status: 'cancelled', at: null, updated: '2026-10-29T12:00:00Z' }
		]);
		await post('gone', 'Disconnected, never sent', [{ conn: 'oldx', at: '2026-10-29T12:00:00Z' }]);
		await post('history', 'Disconnected, sent', [
			{ conn: 'oldx', status: 'published', at: '2026-10-29T13:00:00Z', remotePostId: 'r2' }
		]);
		await post('foreign', 'Not yours', [{ conn: 'theirs', at: '2026-10-28T12:00:00Z' }], otherId);
		await post('idea', 'An idea with no time', []);
	});

	afterAll(() => close());
	beforeEach(() => reset());

	const load = (filter: Partial<typeof ALL> = {}) =>
		loadCalendar(db, userId, { ...WEEK, filter: { ...ALL, ...filter }, now: NOW });
	const names = (items: Array<{ id: string }>) =>
		items.map((i) => Object.keys(ids).find((k) => ids[k] === i.id)).sort();

	it('returns one item per target in the visible range, in time order', async () => {
		const { items } = await load();
		expect(names(items)).toEqual(
			[
				'launch:jobli',
				'launch:jobig',
				'launch:mybs',
				'late:caltt',
				'published:calig',
				'now:jobli',
				'history:oldx'
			].sort()
		);
		expect(items.map((i) => i.at)).toEqual([...items.map((i) => i.at)].sort((a, b) => a - b));
		const byName = Object.fromEntries(items.map((i) => [names([i])[0], i]));
		expect(byName['launch:jobli'].text).toBe('Launch day, LinkedIn edition');
		expect(byName['launch:jobig'].text).toBe('Launch day\nsecond line');
		expect(byName['launch:jobig'].mediaCount).toBe(1);
		expect(byName['now:jobli']).toMatchObject({ status: 'due', scheduledFor: null });
		expect(byName['published:calig'].status).toBe('published');
		expect(byName['late:caltt'].status).toBe('scheduled');
	});

	it('shows cancelled rows only when asked', async () => {
		const { items } = await load({ cancelled: true });
		expect(names(items)).toContain('dropped:caltt');
		expect(items.find((i) => i.id === ids['dropped:caltt'])?.status).toBe('cancelled');
	});

	it('joins in brand and channel, with unbranded accounts grouped', async () => {
		const result = await load();
		expect(result.brands.map((b) => b.name)).toEqual(['465Cal', 'JobJob', 'Unbranded']);
		const channel = (name: string) => result.channels.find((c) => c.connectionId === ids[name]);
		expect(channel('jobli')).toMatchObject({
			key: 'jobjob.linkedin',
			brand: { name: 'JobJob', color: '#2563eb' }
		});
		expect(channel('calig')?.key).toBe('465cal.instagram');
		expect(channel('mybs')).toMatchObject({
			key: 'unbranded.bluesky',
			brand: { id: null, slug: 'unbranded' }
		});
		expect(channel('oldx')).toMatchObject({
			key: '',
			status: 'disconnected',
			brand: { name: 'JobJob' }
		});
		expect(channel('theirs')).toBeUndefined();
		expect(result.media[ids.launch]).toHaveLength(1);
	});

	it('filters by brand, by channel, and by both together', async () => {
		expect(names((await load({ brands: ['465cal'] })).items)).toEqual(
			['late:caltt', 'published:calig'].sort()
		);
		expect(names((await load({ brands: ['unbranded'] })).items)).toEqual(['launch:mybs']);
		expect(names((await load({ channels: ['jobjob.instagram'] })).items)).toEqual(['launch:jobig']);
		expect(
			names((await load({ brands: ['unbranded'], channels: ['465cal.tiktok'] })).items)
		).toEqual(['late:caltt', 'launch:mybs'].sort());
		expect((await load({ brands: ['nobody'] })).items).toEqual([]);
	});

	it('lists drafts with no time apart from the grid', async () => {
		const { unscheduled } = await load();
		expect(unscheduled.map((d) => d.body)).toEqual(['An idea with no time']);
	});

	it('stays inside the D1 statement and bound-parameter budgets', async () => {
		await load();
		expect(count()).toBeLessThanOrEqual(7);
		expect(maxParams()).toBeLessThanOrEqual(100);
	});

	it('loads the page from the address in the account zone', async () => {
		const user = {
			id: userId,
			email: 'cal@localhost',
			timezone: TORONTO,
			totpEnabled: true,
			mfaVerified: true
		};
		const result = (await calendarLoad({
			locals: { db, env: TEST_ENV, user },
			url: new URL('http://localhost/calendar?date=2026-10-28&brand=jobjob')
		} as never)) as LoadResult;
		expect(result.loadFailed).toBe(false);
		expect(result.timeZone).toBe(TORONTO);
		expect(result.range.start).toBe('2026-10-26');
		expect(
			result.items.every(
				(i) =>
					result.channels.find((c) => c.connectionId === i.connectionId)?.brand.slug === 'jobjob'
			)
		).toBe(true);
	});

	it('moves a target with the payload a drag builds', async () => {
		// The route refuses past times, so the drop lands three days from the real now.
		const day = dayKeyOf(Date.now() + 3 * DAY_MS, TORONTO);
		const runAt = droppedInstant(Date.parse('2026-11-02T04:30:00Z'), { day, hour: 10 }, TORONTO);
		const res = await bulkPOST({
			request: new Request('http://localhost/api/targets/bulk', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(reschedulePayload([ids['late:caltt']], runAt))
			}),
			locals: {
				db,
				user: {
					id: userId,
					email: 'cal@localhost',
					timezone: TORONTO,
					totpEnabled: true,
					mfaVerified: true
				}
			}
		} as never);
		expect(res.status).toBe(200);
		const [row] = await db
			.select()
			.from(publishTargets)
			.where(eq(publishTargets.id, ids['late:caltt']));
		expect(zonedParts(row.scheduledFor!.getTime(), TORONTO)).toEqual({
			key: day,
			minutes: 10 * 60 + 30
		});
		expect(row.status).toBe('scheduled');
	});
});
