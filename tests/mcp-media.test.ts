import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import { SubrequestBudget } from '#lib/server/budget.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { newId } from '#lib/server/db/client.js';
import { connections, draftMedia, drafts, publishTargets } from '#lib/server/db/schema.js';
import { memoryMediaStore } from '#lib/server/media.js';
import { UPLOAD_PART_BYTES } from '#lib/server/media-uploads.js';
import { rotateApiKey, verifyApiKey } from '#lib/server/api-keys.js';
import type { MediaStore } from '#lib/server/providers/types.js';
import { POST } from '../src/routes/api/mcp/+server';
import { PUT as partPUT } from '../src/routes/api/drafts/[id]/media/uploads/part/+server';
import { buildMp4 } from './mp4-fixture';

let db: Awaited<ReturnType<typeof createTestDb>>['db'];
let closeDb: (() => void) | undefined;
let user: {
	id: string;
	email: string;
	timezone: string;
	totpEnabled: boolean;
	mfaVerified: boolean;
};
let media: MediaStore;
let clients: Client[] = [];
let extraLocals: Record<string, unknown> = {};

function pngBytes(width = 1080, height = 1080, padding = 0): Uint8Array<ArrayBuffer> {
	const b = new Uint8Array(33 + padding);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(b.buffer).setUint32(16, width);
	new DataView(b.buffer).setUint32(20, height);
	return b;
}

function jpegBytes(): Uint8Array<ArrayBuffer> {
	return new Uint8Array([
		0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1
	]);
}

function base64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('base64');
}

async function connect(scopes: Array<'read' | 'write'>): Promise<Client> {
	const raw = (await rotateApiKey(db, user.id, scopes)).raw;
	const transport = new StreamableHTTPClientTransport(new URL('https://cogsend.example/api/mcp'), {
		requestInit: { headers: { Authorization: `Bearer ${raw}` } },
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
			const verified = token ? await verifyApiKey(db, token) : null;
			if (!verified) return Response.json({ error: 'Unauthorized' }, { status: 401 });
			return POST({
				request,
				url: new URL(request.url),
				locals: {
					user,
					apiKeyScopes: verified.scopes,
					authMethod: 'bearer',
					authCredential: 'personal_api_key',
					db,
					env: TEST_ENV,
					media,
					...extraLocals
				}
			} as never);
		}
	});
	const client = new Client(
		{ name: 'cogsend-media-test', version: '1.0.0' },
		{ versionNegotiation: { mode: { pin: '2026-07-28' } } }
	);
	await client.connect(transport);
	clients.push(client);
	return client;
}

beforeEach(async () => {
	const testDb = await createTestDb();
	db = testDb.db;
	closeDb = testDb.close;
	const row = await createTestAdmin(db, { totpEnabled: true });
	user = {
		id: row.id,
		email: row.email,
		timezone: row.timezone,
		totpEnabled: true,
		mfaVerified: true
	};
	media = memoryMediaStore();
	extraLocals = {};
});

afterEach(async () => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	for (const client of clients) await client.close();
	clients = [];
	closeDb?.();
	closeDb = undefined;
});

async function seedDraft(baseBody = 'Media test') {
	const id = newId();
	const now = new Date();
	await db.insert(drafts).values({
		id,
		userId: user.id,
		title: 'Media',
		baseBody,
		status: 'draft',
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function seedConnection(
	platform: string,
	handle: string,
	meta: Record<string, unknown> = {}
) {
	const id = newId();
	const now = new Date();
	await db.insert(connections).values({
		id,
		userId: user.id,
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

/** A row as if attached earlier, for shapes the attach tools refuse to build. */
async function seedMedia(
	draftId: string,
	row: { mime: string; size: number; segmentIndex?: number; width?: number; height?: number }
) {
	await db.insert(draftMedia).values({
		id: newId(),
		draftId,
		storageKey: `${Date.now()}-${newId().slice(0, 16).padEnd(16, '0')}.${row.mime.endsWith('mp4') ? 'mp4' : 'png'}`,
		mime: row.mime,
		size: row.size,
		width: row.width ?? 1080,
		height: row.height ?? 1080,
		metaJson: row.mime.startsWith('video/')
			? JSON.stringify({ durationMs: 30_000, videoCodec: 'avc', fps: 30, faststart: true })
			: null,
		altText: null,
		sortOrder: 0,
		segmentIndex: row.segmentIndex ?? 0,
		createdAt: new Date()
	});
}

type Result = { isError?: boolean; structuredContent?: unknown; content?: unknown };
const data = (result: Result) => result.structuredContent as Record<string, unknown>;
const text = (result: Result) =>
	(result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

/** A fetch that answers each URL from a table, and records what it was asked. */
function stubFetch(routes: Record<string, () => Response>) {
	const calls: string[] = [];
	const fake = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		calls.push(url);
		const route = routes[url];
		if (!route) throw new Error(`unexpected fetch ${url}`);
		return route();
	});
	vi.stubGlobal('fetch', fake);
	return calls;
}

describe('get_platform_requirements', () => {
	it('describes every platform with a read-only key, and each account asked for', async () => {
		const client = await connect(['read']);
		const mastodon = await seedConnection('mastodon', 'me@tiny.example', {
			videoSizeLimit: 40_000_000
		});
		const all = await client.callTool({ name: 'get_platform_requirements', arguments: {} });
		expect(all.isError).toBeFalsy();
		const platforms = data(all).platforms as Array<{ platform: string; summary: string }>;
		expect(platforms.map((p) => p.platform).sort()).toEqual(
			['bluesky', 'instagram', 'linkedin', 'mastodon', 'threads', 'tiktok', 'x'].sort()
		);
		expect(text(all)).toContain('Instagram: ');
		expect(data(all).attach).toMatchObject({
			base64MaxBytes: 3_000_000,
			uploadSessionMaxBytes: 300_000_000
		});

		const one = data(
			await client.callTool({
				name: 'get_platform_requirements',
				arguments: { channels: [mastodon] }
			})
		);
		expect((one.platforms as unknown[]).length).toBe(1);
		expect(one.accounts).toEqual([
			expect.objectContaining({
				connectionId: mastodon,
				video: expect.objectContaining({ maxBytes: 40_000_000 })
			})
		]);
	});

	it('is also a resource', async () => {
		const client = await connect(['read']);
		const { resources } = await client.listResources();
		expect(resources.map((r) => r.uri)).toContain('cogsend://platform-requirements');
		const read = await client.readResource({ uri: 'cogsend://platform-requirements' });
		const body = JSON.parse((read.contents[0] as { text: string }).text);
		expect(body.platforms).toHaveLength(7);
		expect(body.attach.base64MaxBytes).toBe(3_000_000);
	});
});

describe('attach_media by URL', () => {
	it('fetches an image, trusts its bytes over its Content-Type, and attaches it with alt text', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft();
		const png = pngBytes(1200, 900);
		const calls = stubFetch({
			'https://cdn.example.com/photo': () =>
				new Response(new Response(png).body, { headers: { 'content-type': 'text/plain' } })
		});
		const result = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, url: 'https://cdn.example.com/photo', altText: 'A harbour' }
		});
		expect(result.isError).toBeFalsy();
		expect(data(result).media).toMatchObject({
			mime: 'image/png',
			width: 1200,
			height: 900,
			altText: 'A harbour',
			segmentIndex: 0
		});
		expect(calls).toEqual(['https://cdn.example.com/photo']);
		const [item] = await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId));
		expect(await media.get(item.storageKey)).toEqual(png);
	});

	it('streams a video into storage in parts and reads what it stored', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft();
		const video = buildMp4({ durationMs: 12_000, mdatBytes: UPLOAD_PART_BYTES * 2 + 1234 });
		let uploaded = 0;
		const multipart = media.multipart!;
		const uploadPart = multipart.uploadPart.bind(multipart);
		multipart.uploadPart = async (...args) => {
			uploaded += 1;
			return uploadPart(...args);
		};
		// Small chunks, as a network delivers them, and no Content-Length.
		stubFetch({
			'https://cdn.example.com/clip.mp4': () =>
				new Response(
					new ReadableStream({
						start(controller) {
							for (let at = 0; at < video.length; at += 1_000_000) {
								controller.enqueue(video.slice(at, at + 1_000_000));
							}
							controller.close();
						}
					}),
					{ headers: { 'content-type': 'video/mp4' } }
				)
		});
		const result = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, url: 'https://cdn.example.com/clip.mp4' }
		});
		expect(result.isError).toBeFalsy();
		expect(data(result).media).toMatchObject({
			mime: 'video/mp4',
			size: video.length,
			meta: expect.objectContaining({ durationMs: 12_000, videoCodec: 'avc' })
		});
		expect(uploaded).toBe(3);
	});

	it('never fetches a private, loopback or metadata address, nor a redirect to one', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft();
		const calls = stubFetch({
			'https://public.example/a.png': () =>
				new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/a.png' } }),
			'https://public.example/b.png': () =>
				new Response(null, {
					status: 301,
					headers: { location: 'http://[::ffff:169.254.169.254]/latest' }
				})
		});
		for (const url of [
			'http://127.0.0.1/a.png',
			'http://169.254.169.254/latest/meta-data/',
			'http://192.168.1.1/a.png',
			'http://[::1]/a.png',
			'http://localhost/a.png'
		]) {
			const refused = await client.callTool({
				name: 'attach_media',
				arguments: { draftId, url }
			});
			expect(refused.isError, url).toBe(true);
			expect(data(refused)).toMatchObject({ status: 400, error: 'URL host not allowed' });
		}
		const notHttp = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, url: 'ftp://public.example/a.png' }
		});
		expect(data(notHttp)).toMatchObject({ error: 'Only http(s) URLs are supported' });
		expect(calls).toEqual([]);
		for (const url of ['https://public.example/a.png', 'https://public.example/b.png']) {
			const redirected = await client.callTool({
				name: 'attach_media',
				arguments: { draftId, url }
			});
			expect(data(redirected)).toMatchObject({ status: 400, error: 'URL host not allowed' });
		}
		// Each redirect was refused before the server followed it.
		expect(calls).toEqual(['https://public.example/a.png', 'https://public.example/b.png']);
		expect(await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId))).toEqual([]);
	});

	it('refuses an oversized image by its header or while it streams, and a file of the wrong type', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft();
		let pulled = 0;
		stubFetch({
			'https://cdn.example.com/declared.png': () =>
				new Response(pngBytes(), { headers: { 'content-length': '20000000' } }),
			'https://cdn.example.com/endless.png': () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(pngBytes());
						},
						pull(controller) {
							pulled += 1;
							controller.enqueue(new Uint8Array(1_000_000));
						}
					})
				),
			'https://cdn.example.com/page': () =>
				new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } })
		});
		const declared = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, url: 'https://cdn.example.com/declared.png' }
		});
		expect(data(declared)).toMatchObject({ status: 413, error: 'Image must be 16MB or smaller' });
		const endless = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, url: 'https://cdn.example.com/endless.png' }
		});
		expect(data(endless)).toMatchObject({ status: 413, error: 'Image must be 16MB or smaller' });
		// Cut off just past the cap, not read to the end.
		expect(pulled).toBeLessThan(20);
		const html = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, url: 'https://cdn.example.com/page' }
		});
		expect(data(html).status).toBe(400);
		expect(String(data(html).error)).toMatch(
			/not a PNG, JPEG, WebP or GIF image or an MP4 video \(it sent text\/html\)/
		);
		expect(await db.select().from(draftMedia).where(eq(draftMedia.draftId, draftId))).toEqual([]);
	});

	it('sends a video too large for one request’s call budget to the upload session', async () => {
		extraLocals = { budget: new SubrequestBudget(30) };
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft();
		stubFetch({
			'https://cdn.example.com/long.mp4': () =>
				new Response(buildMp4(), {
					headers: { 'content-type': 'video/mp4', 'content-length': '200000000' }
				})
		});
		const result = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, url: 'https://cdn.example.com/long.mp4' }
		});
		expect(result.isError).toBe(true);
		expect(data(result)).toMatchObject({ status: 413, useUploadSession: true });
		expect(String(data(result).error)).toContain('media_upload');
	});
});

describe('attach_media inline', () => {
	it('attaches a small image to a thread segment and refuses what does not belong inline', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft('first\n---\nsecond');
		const ok = await client.callTool({
			name: 'attach_media',
			arguments: {
				draftId,
				base64: `data:image/png;base64,${base64(pngBytes(800, 600))}`,
				segmentIndex: 1,
				altText: 'Second card'
			}
		});
		expect(data(ok).media).toMatchObject({
			mime: 'image/png',
			segmentIndex: 1,
			altText: 'Second card'
		});

		const big = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, base64: base64(pngBytes(10, 10, 3_100_000)) }
		});
		expect(data(big)).toMatchObject({ status: 413 });
		expect(String(data(big).error)).toMatch(/3MB.*attach_media with a url, or media_upload/);

		const video = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, base64: base64(buildMp4()) }
		});
		expect(String(data(video).error)).toMatch(/Videos cannot be sent inline/);
		const junk = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, base64: '%%%' }
		});
		expect(String(data(junk).error)).toMatch(/not valid base64/);
		const pastEnd = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, base64: base64(pngBytes()), segmentIndex: 5 }
		});
		expect(String(data(pastEnd).error)).toMatch(/past the last segment/);
	});

	it('holds a segment to four images and keeps a video on its own', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft();
		for (let i = 0; i < 4; i++) {
			const r = await client.callTool({
				name: 'attach_media',
				arguments: { draftId, base64: base64(pngBytes()) }
			});
			expect(r.isError).toBeFalsy();
		}
		const fifth = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, base64: base64(pngBytes()) }
		});
		expect(data(fifth)).toMatchObject({ error: 'Max 4 images per post' });
		const post = data(await client.callTool({ name: 'get_post', arguments: { postId: draftId } }))
			.post as { media: unknown[] };
		expect(post.media).toHaveLength(4);
	});
});

describe('upload session', () => {
	it('creates an upload, takes its parts over HTTP, completes through MCP, and sets a cover', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft();
		const video = buildMp4({ durationMs: 20_000, mdatBytes: UPLOAD_PART_BYTES + 5000 });
		const created = await client.callTool({
			name: 'media_upload',
			arguments: { action: 'start', draftId, size: video.length }
		});
		expect(created.isError).toBeFalsy();
		const session = data(created) as {
			upload: Record<string, unknown> & { parts: number; partSize: number };
			parts: Array<{ partNumber: number; offset: number; length: number; url: string }>;
			request: { method: string; headers: Record<string, string> };
			complete: { url: string };
		};
		expect(session.upload.parts).toBe(2);
		expect(session.request.method).toBe('PUT');
		expect(session.complete.url).toBe(
			`${TEST_ENV.APP_URL}/api/drafts/${draftId}/media/uploads/complete`
		);
		const etags = [];
		for (const part of session.parts) {
			const url = new URL(part.url);
			expect(url.pathname).toBe(`/api/drafts/${draftId}/media/uploads/part`);
			const body = video.slice(part.offset, part.offset + part.length);
			const request = new Request(url, {
				method: 'PUT',
				headers: { 'content-length': String(body.length) },
				body
			});
			const response = await partPUT({
				params: { id: draftId },
				request,
				url,
				locals: { user, apiKeyScopes: ['read', 'write'], db, env: TEST_ENV, media }
			} as never);
			expect(response.status).toBe(200);
			etags.push(await response.json());
		}
		const done = await client.callTool({
			name: 'media_upload',
			arguments: {
				action: 'complete',
				draftId,
				upload: session.upload,
				parts: etags,
				altText: 'Clip'
			}
		});
		expect(done.isError).toBeFalsy();
		const stored = data(done).media as { mediaId: string; size: number; altText: string };
		expect(stored).toMatchObject({ size: video.length, altText: 'Clip' });

		const cover = await client.callTool({
			name: 'edit_media',
			arguments: {
				draftId,
				mediaId: stored.mediaId,
				action: 'set_cover',
				coverBase64: base64(jpegBytes()),
				atMs: 1500
			}
		});
		expect(data(cover).media).toMatchObject({
			meta: expect.objectContaining({ cover: expect.objectContaining({ atMs: 1500 }) })
		});
		const notJpeg = await client.callTool({
			name: 'edit_media',
			arguments: {
				draftId,
				mediaId: stored.mediaId,
				action: 'set_cover',
				coverBase64: base64(pngBytes())
			}
		});
		expect(data(notJpeg)).toMatchObject({ error: 'Cover must be a JPEG' });
		const uncovered = await client.callTool({
			name: 'edit_media',
			arguments: { draftId, mediaId: stored.mediaId, action: 'remove_cover' }
		});
		expect((data(uncovered).media as { meta: Record<string, unknown> }).meta.cover).toBeUndefined();

		// The card now holds a video, so nothing else can join it.
		const image = await client.callTool({
			name: 'attach_media',
			arguments: { draftId, base64: base64(pngBytes()) }
		});
		expect(data(image)).toMatchObject({ error: 'Videos cannot mix with images on the same post' });
	});

	it('refuses a session too large, not MP4, or with a forged token', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft();
		const big = await client.callTool({
			name: 'media_upload',
			arguments: { action: 'start', draftId, size: 300_000_001 }
		});
		expect(data(big)).toMatchObject({ status: 413 });
		const created = data(
			await client.callTool({
				name: 'media_upload',
				arguments: { action: 'start', draftId, size: 1000 }
			})
		);
		const upload = { ...(created.upload as Record<string, unknown>), token: 'f'.repeat(64) };
		const forged = await client.callTool({
			name: 'media_upload',
			arguments: { action: 'complete', draftId, upload, parts: [{ partNumber: 1, etag: 'x' }] }
		});
		expect(data(forged)).toMatchObject({ status: 403, error: 'Bad upload token' });
		const aborted = await client.callTool({
			name: 'media_upload',
			arguments: { action: 'abort', draftId, upload: created.upload }
		});
		expect(data(aborted)).toMatchObject({ status: 'aborted' });
	});
});

describe('edit_media', () => {
	it('changes alt text, moves an image between segments, and removes it with its file', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft('one\n---\ntwo');
		const attached = data(
			await client.callTool({
				name: 'attach_media',
				arguments: { draftId, base64: base64(pngBytes()) }
			})
		).media as { mediaId: string };
		const [row] = await db.select().from(draftMedia).where(eq(draftMedia.id, attached.mediaId));
		const updated = await client.callTool({
			name: 'edit_media',
			arguments: {
				draftId,
				mediaId: attached.mediaId,
				action: 'update',
				altText: 'Now described',
				segmentIndex: 1
			}
		});
		expect(data(updated).media).toMatchObject({ altText: 'Now described', segmentIndex: 1 });
		const nothing = await client.callTool({
			name: 'edit_media',
			arguments: { draftId, mediaId: attached.mediaId, action: 'update' }
		});
		expect(data(nothing)).toMatchObject({ error: 'Nothing to update' });
		expect(
			data(
				await client.callTool({
					name: 'edit_media',
					arguments: { draftId, mediaId: attached.mediaId, action: 'remove' }
				})
			)
		).toMatchObject({ status: 'removed' });
		expect(await media.get(row.storageKey)).toBeNull();
	});
});

describe('scopes', () => {
	it('lets a read-only key read requirements and media but never attach or change them', async () => {
		const client = await connect(['read']);
		const draftId = await seedDraft();
		const fetchSpy = stubFetch({});
		expect(
			(await client.callTool({ name: 'get_post', arguments: { postId: draftId } })).isError
		).toBeFalsy();
		for (const [name, args] of [
			['attach_media', { draftId, url: 'https://cdn.example.com/a.png' }],
			['attach_media', { draftId, base64: base64(pngBytes()) }],
			['media_upload', { action: 'start', draftId, size: 1000 }],
			['edit_media', { draftId, mediaId: 'm', action: 'update', altText: 'x' }],
			['edit_media', { draftId, mediaId: 'm', action: 'remove' }],
			[
				'edit_media',
				{ draftId, mediaId: 'm', action: 'set_cover', coverBase64: base64(jpegBytes()) }
			]
		] as const) {
			const refused = await client.callTool({ name, arguments: args });
			expect(refused.isError, name).toBe(true);
			expect(data(refused), name).toMatchObject({ status: 403 });
			expect(text(refused), name).toContain('read-only');
		}
		expect(fetchSpy).toEqual([]);
		expect(await db.select().from(draftMedia)).toEqual([]);
	});
});

describe('validation that explains', () => {
	it('reports each channel’s media problems, with counts, through validate_post', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft('one\n---\ntwo');
		const instagram = await seedConnection('instagram', 'shop');
		const linkedin = await seedConnection('linkedin', 'Pat');
		const bluesky = await seedConnection('bluesky', 'pat.bsky.social');
		const mastodon = await seedConnection('mastodon', 'pat@tiny.example', {
			videoSizeLimit: 40_000_000
		});
		await seedMedia(draftId, { mime: 'image/png', size: 3_000_000 });
		await seedMedia(draftId, { mime: 'image/png', size: 100_000 });
		await seedMedia(draftId, { mime: 'image/png', size: 100_000 });
		for (let i = 0; i < 3; i++)
			await seedMedia(draftId, { mime: 'image/png', size: 100_000, segmentIndex: 1 });
		const result = await client.callTool({
			name: 'validate_post',
			arguments: {
				draftId,
				channels: ['unbranded.instagram', 'unbranded.linkedin', bluesky]
			}
		});
		expect(result.isError).toBeFalsy();
		const check = data(result) as {
			ok: boolean;
			problems: string[];
			channels: Array<{
				channel: { connectionId: string; key: string };
				ok: boolean;
				issues: Array<Record<string, unknown>>;
			}>;
		};
		expect(check.ok).toBe(false);
		expect(check.problems).toEqual(
			expect.arrayContaining([
				'Instagram @shop: Instagram takes JPEG only — attach this image again, or as a JPEG',
				'LinkedIn @Pat: LinkedIn allows max 4 images, 6 attached',
				'Bluesky @pat.bsky.social (post 1): Bluesky allows max 2MB per image'
			])
		);
		const linkedinIssues = check.channels.find((a) => a.channel.connectionId === linkedin)!.issues;
		expect(linkedinIssues).toContainEqual(
			expect.objectContaining({
				kind: 'media',
				code: 'max_images',
				attached: { images: 6, videos: 0 }
			})
		);
		expect(text(result)).toContain('LinkedIn @Pat: LinkedIn allows max 4 images, 6 attached');

		const videoDraft = await seedDraft('A clip');
		await seedMedia(videoDraft, { mime: 'video/mp4', size: 50_000_000, width: 1920, height: 1080 });
		const empty = await seedDraft('No media at all');
		const videoCheck = data(
			await client.callTool({
				name: 'validate_post',
				arguments: { draftId: videoDraft, channels: [mastodon] }
			})
		) as { problems: string[] };
		expect(videoCheck.problems).toEqual([
			'Mastodon @pat@tiny.example: Mastodon takes videos up to 40 MB — this one is 50 MB'
		]);
		const emptyCheck = data(
			await client.callTool({
				name: 'validate_post',
				arguments: { draftId: empty, channels: [instagram] }
			})
		) as { problems: string[] };
		expect(emptyCheck.problems).toEqual(['Instagram @shop: Instagram needs a photo or video']);
		const fits = data(
			await client.callTool({
				name: 'validate_post',
				arguments: { draftId: empty, channels: [mastodon] }
			})
		);
		expect(fits).toMatchObject({ ok: true, problems: [] });
		const textOnly = data(
			await client.callTool({
				name: 'validate_post',
				arguments: { text: 'No media at all', channels: ['unbranded.instagram'] }
			})
		) as { problems: string[] };
		expect(textOnly.problems).toEqual(['unbranded.instagram: Instagram needs a photo or video']);
	});

	it('refuses publish and schedule before anything is sent, listing every problem', async () => {
		const client = await connect(['read', 'write']);
		const draftId = await seedDraft('A clip');
		await seedConnection('mastodon', 'pat@tiny.example', { videoSizeLimit: 40_000_000 });
		await seedConnection('instagram', 'shop');
		await seedMedia(draftId, { mime: 'video/mp4', size: 50_000_000, width: 1920, height: 1080 });
		await seedMedia(draftId, { mime: 'video/mp4', size: 1_000_000, segmentIndex: 0 });
		const publishSpy = vi.fn();
		vi.stubGlobal('fetch', publishSpy);
		const published = await client.callTool({
			name: 'publish_now',
			arguments: { postId: draftId, channels: ['unbranded.mastodon', 'unbranded.instagram'] }
		});
		expect(published.isError).toBe(true);
		const refusal = data(published) as { status: number; problems: string[] };
		expect(refusal.status).toBe(400);
		expect(refusal.problems).toEqual(
			expect.arrayContaining([
				'Mastodon @pat@tiny.example: Only one video per post',
				'Instagram @shop: Instagram posts a video on its own, as a Reel'
			])
		);
		expect(text(published)).toContain(refusal.problems.join('\n'));
		const scheduled = await client.callTool({
			name: 'schedule_posts',
			arguments: {
				posts: [
					{
						draftId,
						channels: ['unbranded.mastodon'],
						runAt: new Date(Date.now() + 3_600_000).toISOString()
					}
				]
			}
		});
		expect(data(scheduled)).toMatchObject({
			status: 400,
			problems: [
				'posts[0] unbranded.mastodon (Mastodon @pat@tiny.example): Only one video per post'
			]
		});
		expect(publishSpy).not.toHaveBeenCalled();
		expect(
			await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId))
		).toEqual([]);
	});
});
