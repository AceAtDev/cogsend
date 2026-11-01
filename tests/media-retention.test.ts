import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { connections, draftMedia, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { memoryMediaStore } from '#lib/server/media.js';
import { readAppSetting } from '#lib/server/app-settings.js';
import {
	MEDIA_PURGE_SETTING,
	PUBLISHED_MEDIA_RETENTION_MS,
	purgePublishedMedia
} from '#lib/server/media-retention.js';

const DAY = 24 * 60 * 60_000;

describe('published media retention', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;
	let connId: string;
	const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
	const store = memoryMediaStore(objects);
	const now = Date.UTC(2026, 11, 1, 12);

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		connId = newId();
		const at = new Date(now - 100 * DAY);
		await db.insert(users).values({
			id: userId,
			email: 'retention@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: at,
			updatedAt: at
		});
		await db.insert(connections).values({
			id: connId,
			userId,
			platform: 'bluesky',
			handle: 'r.test',
			credentialsEncrypted: 'enc',
			status: 'active',
			createdAt: at,
			updatedAt: at
		});
	});
	afterAll(() => close());

	/** A post with one video, its deliveries in the given states, last touched `ago` ms before now. */
	async function post(name: string, ago: number, statuses: string[]) {
		const draftId = newId();
		const at = new Date(now - ago);
		const allPublished = statuses.every((s) => s === 'published');
		await db.insert(drafts).values({
			id: draftId,
			userId,
			baseBody: name,
			status: allPublished ? 'published' : 'partial',
			createdAt: at,
			updatedAt: at
		});
		for (const status of statuses) {
			const conn = newId();
			await db.insert(connections).values({
				id: conn,
				userId,
				platform: 'bluesky',
				handle: `r-${conn.slice(0, 6)}.test`,
				credentialsEncrypted: 'enc',
				status: 'active',
				createdAt: at,
				updatedAt: at
			});
			await db.insert(publishTargets).values({
				id: newId(),
				draftId,
				connectionId: conn,
				status,
				remotePostId: status === 'published' ? `r-${newId()}` : null,
				createdAt: at,
				updatedAt: at
			});
		}
		const key = `${userId}/${name}.mp4`;
		objects.set(key, { bytes: new Uint8Array([1]), mime: 'video/mp4' });
		await db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey: key,
			mime: 'video/mp4',
			size: 1,
			createdAt: at
		});
		return key;
	}

	it('clears files of posts published more than 14 days ago, and keeps everything else', async () => {
		const old = await post('old', 15 * DAY, ['published', 'published']);
		const recent = await post('recent', 3 * DAY, ['published']);
		const withFailure = await post('partial', 20 * DAY, ['published', 'failed']);
		const stillDue = await post('due', 20 * DAY, ['published', 'scheduled']);

		const result = await purgePublishedMedia(db, store, { now });
		expect(result).toEqual({ files: 1, drafts: 1 });
		expect(objects.has(old)).toBe(false);
		for (const kept of [recent, withFailure, stillDue]) expect(objects.has(kept)).toBe(true);
		const keys = (await db.select().from(draftMedia)).map((m) => m.storageKey).sort();
		expect(keys).toEqual([recent, withFailure, stillDue].sort());
		expect(Number(await readAppSetting(db, MEDIA_PURGE_SETTING, { fresh: true }))).toBe(
			now - PUBLISHED_MEDIA_RETENTION_MS
		);
	});

	it('picks up the recent post once it crosses the line, scanning from the mark', async () => {
		const later = now + 12 * DAY;
		const result = await purgePublishedMedia(db, store, { now: later });
		expect(result.files).toBe(1);
		const keys = (await db.select().from(draftMedia)).map((m) => m.storageKey);
		expect(keys.some((k) => k.endsWith('recent.mp4'))).toBe(false);
		expect(keys).toHaveLength(2);
	});

	it('does nothing when there is nothing old enough', async () => {
		const result = await purgePublishedMedia(db, store, { now: now + 12 * DAY + 60 * 60_000 });
		expect(result).toEqual({ files: 0, drafts: 0 });
		expect(TEST_ENV).toBeTruthy();
	});
});
