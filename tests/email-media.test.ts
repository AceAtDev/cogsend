import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { draftMedia, drafts, users } from '#lib/server/db/schema.js';
import { coverKey, previewKey } from '#lib/server/media.js';
import { signEmailMediaUrl, signPublicMediaUrl } from '#lib/server/public-media.js';
import { isPublicPath } from '../src/hooks.server';
import { GET } from '../src/routes/api/media/email/[key]/+server';

const IMAGE = '1700000000000-0123456789abcdef.png';
const VIDEO = '1700000000000-0123456789abcdef.mp4';
const BARE_VIDEO = '1700000000001-0123456789abcdef.mp4';

describe('email thumbnails', () => {
	let db: AppDb;
	let close: () => void;
	const media = createTestMedia();

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		const now = new Date();
		const userId = newId();
		await db.insert(users).values({
			id: userId,
			email: 'mail@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
		const draftId = newId();
		await db
			.insert(drafts)
			.values({
				id: draftId,
				userId,
				baseBody: 'x',
				status: 'draft',
				createdAt: now,
				updatedAt: now
			});
		for (const [key, mime] of [
			[IMAGE, 'image/png'],
			[VIDEO, 'video/mp4'],
			[BARE_VIDEO, 'video/mp4']
		]) {
			await db
				.insert(draftMedia)
				.values({ id: newId(), draftId, storageKey: key, mime, size: 4, createdAt: now });
		}
		await media.put(IMAGE, new Uint8Array([1, 2, 3, 4]), 'image/png');
		await media.put(previewKey(IMAGE), new Uint8Array([0xff, 0xd8, 1]), 'image/jpeg');
		await media.put(VIDEO, new Uint8Array([9, 9, 9, 9]), 'video/mp4');
		await media.put(coverKey(VIDEO), new Uint8Array([0xff, 0xd8, 2]), 'image/jpeg');
		await media.put(BARE_VIDEO, new Uint8Array([9, 9, 9, 9]), 'video/mp4');
	});
	afterAll(() => close());

	const get = (key: string, url: string) =>
		GET({
			params: { key },
			url: new URL(url),
			locals: { db, media, env: TEST_ENV, bindings: {} },
			request: new Request(url)
		} as never) as Promise<Response>;
	const signed = (key: string) =>
		signEmailMediaUrl(TEST_ENV.APP_ENCRYPTION_KEY, 'https://app.test', key);

	it('is reachable without a session', () => {
		expect(isPublicPath('/api/media/email/abc.jpg')).toBe(true);
	});

	it('serves an image’s small preview copy and a video’s cover, never the video', async () => {
		const image = await get(IMAGE, await signed(IMAGE));
		expect(image.status).toBe(200);
		expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 1]));

		const video = await get(VIDEO, await signed(VIDEO));
		expect(video.status).toBe(200);
		expect(video.headers.get('Content-Type')).toBe('image/jpeg');
		expect(new Uint8Array(await video.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 2]));

		expect((await get(BARE_VIDEO, await signed(BARE_VIDEO))).status).toBe(404);
	});

	it('stays valid for weeks, and refuses tampered or publish-time signatures', async () => {
		const url = new URL(await signed(IMAGE));
		expect(Number(url.searchParams.get('exp')) - Date.now()).toBeGreaterThan(29 * 86_400_000);

		const tampered = new URL(url);
		tampered.searchParams.set('sig', 'nope');
		expect((await get(IMAGE, tampered.toString())).status).toBe(403);

		// A publish URL's signature does not open the email route.
		const publish = new URL(
			await signPublicMediaUrl(TEST_ENV.APP_ENCRYPTION_KEY, 'https://app.test', IMAGE)
		);
		const crossed = new URL(url);
		crossed.searchParams.set('exp', publish.searchParams.get('exp')!);
		crossed.searchParams.set('sig', publish.searchParams.get('sig')!);
		expect((await get(IMAGE, crossed.toString())).status).toBe(403);
	});
});
