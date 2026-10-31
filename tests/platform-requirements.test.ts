import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLATFORM_IDS } from '#lib/domain/platforms.js';
import { isBlockedInstanceHost } from '#lib/domain/instance-host.js';
import { newId } from '#lib/server/db/client.js';
import { connections } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb } from '#lib/server/db/test.js';
import {
	loadPlatformRequirements,
	platformRequirements
} from '#lib/server/platform-requirements.js';
import { assertPublicHttpUrl, fetchPublic } from '#lib/server/safe-fetch.js';

describe('platformRequirements', () => {
	it('describes every platform CogSend has a provider for', () => {
		for (const platform of PLATFORM_IDS) {
			const r = platformRequirements(platform);
			expect(r.platform).toBe(platform);
			expect(r.summary).toMatch(new RegExp(`^${r.name}: `));
			expect(r.images.maxPerPost).toBeGreaterThan(0);
			expect(r.images.maxPerSegment).toBe(4);
			expect(r.images.mimes.length).toBeGreaterThan(0);
			for (const mime of r.images.mimes) expect(r.images.maxBytesByMime[mime]).toBeGreaterThan(0);
			expect(r.media.mixImagesAndVideo).toBe(false);
			expect(r.video).toMatchObject({ supported: true, mimes: ['video/mp4'], perPost: 1 });
			expect(r.video.maxBytes).toBeLessThanOrEqual(300_000_000);
			expect(r.altText.maxLength).toBeLessThanOrEqual(1500);
		}
	});

	it('gives Instagram its required media, carousel, JPEG and Reel rules', () => {
		const r = platformRequirements('instagram');
		expect(r).toMatchObject({
			text: { maxCharacters: 2200 },
			threads: { supported: false, flattened: true },
			media: { required: true, limitsApplyTo: 'post' },
			images: {
				maxPerPost: 10,
				mimes: ['image/jpeg'],
				maxBytes: 8_000_000,
				aspectRatio: { min: 0.8, max: 1.91 }
			},
			video: {
				codecs: ['avc', 'hevc'],
				minDurationMs: 3_000,
				maxDurationMs: 15 * 60_000,
				maxBytes: 300_000_000,
				maxWidth: 1920,
				minFps: 23,
				maxFps: 60,
				faststart: true,
				cover: true
			},
			altText: { images: true, videos: false, maxLength: 1000 }
		});
		expect(r.summary).toContain('needs at least one image or video');
		// With the Images binding a PNG or WebP gets its JPEG copy, so they are taken.
		expect(platformRequirements('instagram', { canMakeJpegCopies: true }).images.mimes).toEqual([
			'image/jpeg',
			'image/png',
			'image/webp'
		]);
	});

	it('gives X its per-type image caps, GIF rule and free-plan video length', () => {
		const r = platformRequirements('x');
		expect(r.text.maxCharacters).toBe(280);
		expect(r.images).toMatchObject({ maxPerPost: 4, maxBytes: 5_000_000 });
		expect(r.images.maxBytesByMime['image/gif']).toBe(15_000_000);
		expect(r.video).toMatchObject({ maxDurationMs: 140_000, codecs: ['avc'], cover: false });
		expect(r.video.notes.join(' ')).toMatch(/Premium/);
		expect(r.notes.join(' ')).toMatch(/GIF/);
		expect(r.threads).toEqual({ supported: true, flattened: false });
	});

	it('describes Bluesky, LinkedIn, Threads and Mastodon from their own limits', () => {
		expect(platformRequirements('bluesky')).toMatchObject({
			text: { maxCharacters: 300 },
			images: { maxPerPost: 4, maxBytes: 2_000_000 },
			video: { maxDurationMs: 600_000 }
		});
		expect(platformRequirements('linkedin')).toMatchObject({
			text: { maxCharacters: 3000 },
			threads: { supported: false, flattened: true },
			images: { maxPerPost: 4, mimes: ['image/jpeg', 'image/png', 'image/gif'] },
			video: { minDurationMs: 3_000, minBytes: 75_000, cover: true },
			altText: { images: true, videos: false }
		});
		// Threads takes 10 in a carousel, but one composer card holds 4.
		expect(platformRequirements('threads')).toMatchObject({
			images: { maxPerPost: 4, mimes: ['image/jpeg', 'image/png'], maxBytes: 8_000_000 },
			video: { maxWidth: 1920, faststart: true },
			altText: { images: false, videos: true }
		});
		expect(platformRequirements('mastodon')).toMatchObject({
			text: { maxCharacters: 500 },
			video: { maxBytes: 99_000_000, maxPixels: 8_294_400, maxFps: 120, cover: true }
		});
	});
});

describe('loadPlatformRequirements', () => {
	let db: Awaited<ReturnType<typeof createTestDb>>['db'];
	let close: () => void;
	let userId: string;

	beforeEach(async () => {
		const t = await createTestDb();
		db = t.db;
		close = t.close;
		userId = (await createTestAdmin(db)).id;
	});
	afterEach(() => close());

	async function connection(platform: string, meta: Record<string, unknown>, handle: string) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId,
			platform,
			handle,
			credentialsEncrypted: '{}',
			metaJson: JSON.stringify(meta),
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	it('filters platforms and adds what each account changes', async () => {
		const mastodon = await connection(
			'mastodon',
			{ maxCharacters: 11_000, videoSizeLimit: 40_000_000, videoFrameRateLimit: 60 },
			'me@small.example'
		);
		const x = await connection('x', { maxCharacters: 25_000, longPosts: true }, 'me');
		const result = await loadPlatformRequirements(db, userId, {
			platforms: ['bluesky'],
			connectionIds: [mastodon, x]
		});
		expect(result.platforms.map((p) => p.platform).sort()).toEqual(['bluesky', 'mastodon', 'x']);
		const byId = Object.fromEntries(result.accounts.map((a) => [a.connectionId, a]));
		expect(byId[mastodon]).toMatchObject({
			text: { maxCharacters: 11_000 },
			video: { maxBytes: 40_000_000, maxFps: 60 }
		});
		expect(byId[mastodon].summary).toContain('MP4 up to 40 MB');
		expect(byId[x]).toMatchObject({
			text: { maxCharacters: 25_000 },
			video: { maxDurationMs: 125 * 60_000 }
		});
		expect(result.store).toMatchObject({ maxVideoBytes: 300_000_000, maxFilesPerDraft: 32 });
	});

	it('refuses an account that is not the caller’s', async () => {
		await expect(
			loadPlatformRequirements(db, userId, { connectionIds: ['nope'] })
		).rejects.toMatchObject({ status: 404 });
	});
});

describe('SSRF guard', () => {
	it('refuses private, loopback, link-local, metadata and reserved hosts', () => {
		for (const url of [
			'http://127.0.0.1/a.png',
			'http://10.1.2.3/a.png',
			'http://192.168.0.10/a.png',
			'http://169.254.169.254/latest/meta-data',
			'http://[::1]/a.png',
			'http://[fe80::1]/a.png',
			'http://[::ffff:127.0.0.1]/a.png',
			'http://[64:ff9b::7f00:1]/a.png',
			'http://[::127.0.0.1]/a.png',
			'http://198.18.0.1/a.png',
			'http://224.0.0.1/a.png',
			'http://localhost:8787/a.png',
			'http://metadata.google.internal/a',
			'http://0x7f000001/a.png'
		]) {
			expect(() => assertPublicHttpUrl(url), url).toThrow();
		}
		expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(/http/);
		expect(() => assertPublicHttpUrl('ftp://example.com/a.png')).toThrow(/http/);
		expect(() => assertPublicHttpUrl('https://user:pw@example.com/a.png')).toThrow(/credentials/);
		expect(assertPublicHttpUrl('https://cdn.example.com/a.png').hostname).toBe('cdn.example.com');
		expect(isBlockedInstanceHost('8.8.8.8')).toBe(false);
	});

	it('checks every redirect hop before following it', async () => {
		const seen: string[] = [];
		const fetchImpl = async (input: RequestInfo | URL) => {
			seen.push(String(input));
			return new Response(null, {
				status: 302,
				headers: { location: 'http://169.254.169.254/latest/meta-data' }
			});
		};
		await expect(
			fetchPublic('https://public.example/a.png', fetchImpl, {
				accept: '*/*',
				userAgent: 'test',
				timeoutMs: 1000,
				maxRedirects: 3
			})
		).rejects.toThrow('URL host not allowed');
		expect(seen).toEqual(['https://public.example/a.png']);
	});

	it('stops after too many redirects and on a timeout', async () => {
		let n = 0;
		const loop = async () =>
			new Response(null, { status: 301, headers: { location: `https://a.example/${++n}` } });
		const opts = { accept: '*/*', userAgent: 'test', timeoutMs: 1000, maxRedirects: 2 };
		await expect(fetchPublic('https://a.example/0', loop, opts)).rejects.toThrow(
			'Too many redirects'
		);
		expect(n).toBe(3);
		const hang = (_: RequestInfo | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () =>
					reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
				);
			});
		await expect(
			fetchPublic('https://slow.example/', hang, { ...opts, timeoutMs: 20 })
		).rejects.toMatchObject({ status: 504 });
	});
});
