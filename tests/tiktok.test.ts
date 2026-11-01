import { describe, expect, it } from 'vitest';
import { createTestMedia } from '#lib/server/db/test.js';
import {
	TIKTOK_CHUNK_BYTES,
	tiktokApiError,
	tiktokAuthorizeUrl,
	tiktokChunkPlan,
	tiktokChunkRange,
	tiktokExchangeCode,
	tiktokProvider,
	UNAUDITED_MESSAGE
} from '#lib/server/providers/tiktok.js';
import {
	PROCESSING_MARK,
	ProviderError,
	UNCONFIRMED_POST_MARK,
	type ConnectionCredentials,
	type ConnectionMeta,
	type FetchLike,
	type MediaAttachment,
	type PlatformProvider,
	type PublishPending
} from '#lib/server/providers/types.js';
import { EMPTY_TIKTOK_CHOICE, type TiktokPostChoice } from '#lib/domain/tiktok.js';

type Opts = NonNullable<Parameters<PlatformProvider['publish']>[4]>;

const OK = { code: 'ok', message: '', log_id: 'log' };
const CREATOR = {
	creator_avatar_url: 'https://p16.tiktokcdn.test/a.jpg',
	creator_username: 'acme',
	creator_nickname: 'Acme Studio',
	privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
	comment_disabled: false,
	duet_disabled: false,
	stitch_disabled: true,
	max_video_post_duration_sec: 600
};
const UPLOAD_HOST = 'https://open-upload.tiktokapis.test';

type Answer = Response | (() => Response | Promise<Response>);
const answer = (a: Answer) => (typeof a === 'function' ? a() : a.clone());

/**
 * A stand-in for TikTok: creator_info, the upload start, the upload address and
 * the status fetch, each recording what it was sent. `statuses` are answered in
 * order, the last one repeating.
 */
function tiktokNetwork(
	opts: {
		creator?: Answer;
		init?: Answer;
		part?: (index: number, last: boolean) => Response | Promise<Response>;
		statuses?: Array<Record<string, unknown> | string>;
	} = {}
) {
	const record = {
		creatorCalls: 0,
		inits: [] as Array<Record<string, unknown>>,
		parts: [] as Array<{
			url: string;
			range: string | null;
			type: string | null;
			bytes: Uint8Array;
		}>,
		statusIds: [] as string[],
		auth: [] as string[]
	};
	const statuses = [...(opts.statuses ?? [{ status: 'PUBLISH_COMPLETE' }])];
	const net = { left: Infinity };
	const fetchImpl: FetchLike = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		net.left -= 1;
		const req = new Request(url, init);
		if (url.startsWith('https://open.tiktokapis.com/'))
			record.auth.push(req.headers.get('authorization') ?? '');
		if (url === 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/') {
			record.creatorCalls += 1;
			return opts.creator ? answer(opts.creator) : Response.json({ data: CREATOR, error: OK });
		}
		if (url === 'https://open.tiktokapis.com/v2/post/publish/video/init/') {
			record.inits.push((await req.json()) as Record<string, unknown>);
			const n = record.inits.length;
			return opts.init
				? answer(opts.init)
				: Response.json({
						data: {
							publish_id: `v_pub_file~v2.${n}`,
							upload_url: `${UPLOAD_HOST}/upload/?id=${n}`
						},
						error: OK
					});
		}
		if (url.startsWith(UPLOAD_HOST)) {
			const bytes = new Uint8Array(await req.arrayBuffer());
			const range = req.headers.get('content-range');
			record.parts.push({ url, range, type: req.headers.get('content-type'), bytes });
			const total = Number(range?.split('/')[1]);
			const last = Number(range?.split('-')[1]?.split('/')[0]) === total - 1;
			if (opts.part) return opts.part(record.parts.length - 1, last);
			return new Response(null, { status: last ? 201 : 206 });
		}
		if (url === 'https://open.tiktokapis.com/v2/post/publish/status/fetch/') {
			record.statusIds.push(((await req.json()) as { publish_id: string }).publish_id);
			const next = statuses.length > 1 ? statuses.shift()! : statuses[0];
			if (typeof next === 'string') return new Response(next, { status: 200 });
			return Response.json({ data: next, error: OK });
		}
		return new Response(`unmocked ${url}`, { status: 404 });
	};
	return { record, net, fetchImpl, callsLeft: () => net.left };
}

function patterned(size: number): Uint8Array<ArrayBuffer> {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = i % 251;
	return bytes;
}

async function storedVideo(size: number, durationMs = 30_000) {
	const store = createTestMedia();
	const bytes = patterned(size);
	await store.put('v.mp4', bytes, 'video/mp4');
	const video: MediaAttachment = {
		storageKey: 'v.mp4',
		mime: 'video/mp4',
		size,
		width: 1080,
		height: 1920,
		video: { durationMs, videoCodec: 'avc', fps: 30, faststart: true }
	};
	return { store, bytes, video };
}

const creds: ConnectionCredentials = {
	accessToken: 'act.token',
	refreshToken: 'rft.token',
	clientId: 'tt-key',
	clientSecret: 'tt-secret',
	expiresAt: Date.now() + 20 * 60 * 60_000,
	tiktokOpenId: 'open-1',
	tiktokUsername: 'acme'
};

async function failure(run: Promise<unknown>): Promise<ProviderError> {
	const err = await run.then(
		() => null,
		(e: unknown) => e
	);
	expect(err).toBeInstanceOf(ProviderError);
	return err as ProviderError;
}

async function parked(run: Promise<unknown>): Promise<ProviderError> {
	const err = await failure(run);
	expect(err.code).toBe('processing');
	expect(err.message).toContain(PROCESSING_MARK);
	return err;
}

function resumeFrom(err: ProviderError, startedAt = Date.now()): Opts['resume'] {
	const pending: PublishPending = { ...err.pending!, startedAt };
	return { segmentIds: [], pending };
}

function publish(
	video: MediaAttachment,
	store: ReturnType<typeof createTestMedia>,
	n: ReturnType<typeof tiktokNetwork>,
	extra: Partial<Opts> & {
		meta?: ConnectionMeta;
		text?: string;
		choice?: Partial<TiktokPostChoice> | null;
	} = {}
) {
	const { meta, text = 'Behind the scenes #studio', choice = {}, ...opts } = extra;
	// Every post carries the creator's own choice; SELF_ONLY stands in for one.
	const tiktok =
		choice === null
			? undefined
			: { ...EMPTY_TIKTOK_CHOICE, privacy: 'SELF_ONLY' as const, ...choice };
	const content = { text, media: [video], options: tiktok ? { tiktok } : undefined };
	return tiktokProvider.publish(content, creds, meta, n.fetchImpl, {
		mediaReader: store as never,
		callsLeft: n.callsLeft,
		...opts
	});
}

describe('TikTok OAuth', () => {
	it('builds the v2 authorize URL with client_key and comma-separated scopes', () => {
		const url = new URL(tiktokAuthorizeUrl('tt-key', 'https://social.example/', 'st4te'));
		expect(url.origin + url.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
		expect(Object.fromEntries(url.searchParams)).toEqual({
			client_key: 'tt-key',
			scope: 'user.info.basic,video.publish,video.list',
			response_type: 'code',
			redirect_uri: 'https://social.example/api/connections/tiktok/callback',
			state: 'st4te'
		});
	});

	it('exchanges the code, then names the account from user info and creator_info', async () => {
		const sent: Record<string, string>[] = [];
		const fetchImpl: FetchLike = async (input, init) => {
			const url = String(input);
			if (url === 'https://open.tiktokapis.com/v2/oauth/token/') {
				expect(new Headers(init?.headers).get('content-type')).toBe(
					'application/x-www-form-urlencoded'
				);
				sent.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
				return Response.json({
					access_token: 'act.1',
					expires_in: 86400,
					open_id: 'open-1',
					refresh_token: 'rft.1',
					refresh_expires_in: 31536000,
					scope: 'user.info.basic,video.publish',
					token_type: 'Bearer'
				});
			}
			if (url.startsWith('https://open.tiktokapis.com/v2/user/info/')) {
				expect(new URL(url).searchParams.get('fields')).toBe(
					'open_id,union_id,avatar_url,display_name'
				);
				expect(new Headers(init?.headers).get('authorization')).toBe('Bearer act.1');
				return Response.json({
					data: {
						user: { open_id: 'open-1', display_name: 'Acme', avatar_url: 'https://a.test/x' }
					},
					error: OK
				});
			}
			if (url.endsWith('/creator_info/query/')) return Response.json({ data: CREATOR, error: OK });
			return new Response('unmocked', { status: 404 });
		};
		const before = Date.now();
		const out = await tiktokExchangeCode(
			{
				clientKey: 'tt-key',
				clientSecret: 'tt-secret',
				code: 'C0DE*!',
				appUrl: 'https://s.example'
			},
			fetchImpl
		);
		expect(sent).toEqual([
			{
				client_key: 'tt-key',
				client_secret: 'tt-secret',
				code: 'C0DE*!',
				grant_type: 'authorization_code',
				redirect_uri: 'https://s.example/api/connections/tiktok/callback'
			}
		]);
		expect(out).toMatchObject({
			accessToken: 'act.1',
			refreshToken: 'rft.1',
			clientId: 'tt-key',
			clientSecret: 'tt-secret',
			tiktokOpenId: 'open-1',
			tiktokUsername: 'acme',
			handle: '@acme',
			displayName: 'Acme Studio',
			avatarUrl: 'https://a.test/x',
			maxCharacters: 2200,
			tiktokPrivacyOptions: CREATOR.privacy_level_options,
			tiktokMaxVideoSec: 600,
			tiktokStitchDisabled: true
		});
		expect(out.expiresAt! - before).toBeGreaterThanOrEqual(86_400_000 - 1000);
		expect(out.refreshExpiresAt! - before).toBeGreaterThanOrEqual(31_536_000_000 - 1000);
	});

	it('refuses a grant without video.publish: nothing could ever post', async () => {
		const fetchImpl: FetchLike = async () =>
			Response.json({ access_token: 'a', refresh_token: 'r', scope: 'user.info.basic' });
		await expect(
			tiktokExchangeCode(
				{ clientKey: 'k', clientSecret: 's', code: 'c', appUrl: 'https://s.example' },
				fetchImpl
			)
		).rejects.toThrow(/video\.publish/);
	});

	it('reports the token endpoint’s own error shape', async () => {
		const fetchImpl: FetchLike = async () =>
			Response.json(
				{
					error: 'invalid_grant',
					error_description: 'Authorization code is expired.',
					log_id: 'l'
				},
				{ status: 400 }
			);
		await expect(
			tiktokExchangeCode(
				{ clientKey: 'k', clientSecret: 's', code: 'c', appUrl: 'https://s.example' },
				fetchImpl
			)
		).rejects.toThrow('TikTok token exchange failed (400): Authorization code is expired.');
	});
});

describe('TikTok token refresh', () => {
	const refreshNetwork = (respond: () => Response) => {
		const sent: Record<string, string>[] = [];
		const fetchImpl: FetchLike = async (input, init) => {
			expect(String(input)).toBe('https://open.tiktokapis.com/v2/oauth/token/');
			sent.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
			return respond();
		};
		return { sent, fetchImpl };
	};

	it('leaves a token with more than an hour left alone', async () => {
		const n = refreshNetwork(() => new Response('', { status: 500 }));
		expect(await tiktokProvider.refreshIfNeeded!(creds, n.fetchImpl)).toBe(creds);
		expect(n.sent).toHaveLength(0);
	});

	it('refreshes a day-old token and keeps the refresh token TikTok rotates in', async () => {
		const n = refreshNetwork(() =>
			Response.json({
				access_token: 'act.2',
				expires_in: 86400,
				refresh_token: 'rft.2',
				refresh_expires_in: 31536000,
				open_id: 'open-1',
				scope: 'user.info.basic,video.publish',
				token_type: 'Bearer'
			})
		);
		const due = { ...creds, expiresAt: Date.now() + 10 * 60_000 };
		const out = await tiktokProvider.refreshIfNeeded!(due, n.fetchImpl);
		expect(n.sent).toEqual([
			{
				client_key: 'tt-key',
				client_secret: 'tt-secret',
				grant_type: 'refresh_token',
				refresh_token: 'rft.token'
			}
		]);
		expect(out.accessToken).toBe('act.2');
		expect(out.refreshToken).toBe('rft.2');
		expect(out.expiresAt).toBeGreaterThan(Date.now() + 23 * 60 * 60_000);
	});

	it('expires the account when TikTok refuses the refresh token, in either answer shape', async () => {
		const due = { ...creds, expiresAt: Date.now() - 1000 };
		for (const status of [400, 200]) {
			const n = refreshNetwork(() =>
				Response.json(
					{ error: 'invalid_grant', error_description: 'Refresh token is invalid', log_id: 'l' },
					{ status }
				)
			);
			const err = await failure(tiktokProvider.refreshIfNeeded!(due, n.fetchImpl));
			expect([status, err.code, err.status]).toEqual([status, 'auth', 401]);
		}
	});

	it('keeps the current token through TikTok’s own trouble', async () => {
		const due = { ...creds, expiresAt: Date.now() + 60_000 };
		for (const status of [429, 503]) {
			const n = refreshNetwork(() => new Response('busy', { status }));
			expect(await tiktokProvider.refreshIfNeeded!(due, n.fetchImpl)).toBe(due);
		}
	});

	it('says when no refresh can help', () => {
		expect(tiktokProvider.refreshImpossibleReason!(creds)).toBeNull();
		expect(
			tiktokProvider.refreshImpossibleReason!({ ...creds, refreshExpiresAt: Date.now() - 1 })
		).toMatch(/reconnect/);
		expect(
			tiktokProvider.refreshImpossibleReason!({
				accessToken: 'a',
				expiresAt: Date.now() - 1
			})
		).toMatch(/cannot be refreshed/);
	});
});

describe('TikTok validation', () => {
	const video: MediaAttachment = {
		storageKey: 'v.mp4',
		mime: 'video/mp4',
		width: 1080,
		height: 1920,
		video: { durationMs: 200_000, videoCodec: 'avc', fps: 30 }
	};
	const messages = (content: Parameters<PlatformProvider['validate']>[0], meta?: ConnectionMeta) =>
		tiktokProvider.validate(content, meta).map((i) => i.message);

	it('takes one video with a caption', () => {
		expect(messages({ text: 'hello', media: [video] })).toEqual([]);
	});

	it('needs a video, and takes no photos', () => {
		expect(messages({ text: 'just text' })).toEqual(['TikTok needs a video']);
		expect(messages({ text: 'x', media: [{ mime: 'image/jpeg' }] })).toEqual([
			'TikTok takes a video, not photos'
		]);
		expect(messages({ text: 'x', media: [video, { mime: 'image/jpeg' }] })).toEqual([
			'TikTok posts one video on its own'
		]);
	});

	it('counts the caption in UTF-16 units, as TikTok does', () => {
		// 1100 emoji are 1100 graphemes but 2200 units: at the limit, not past it.
		expect(messages({ text: '😀'.repeat(1100), media: [video] })).toEqual([]);
		expect(messages({ text: `${'😀'.repeat(1100)}a`, media: [video] })).toEqual([
			'2201 / 2200 characters (TikTok max 2200)'
		]);
	});

	it('holds a video to the creator’s own longest length once it is known', () => {
		expect(messages({ text: '', media: [video] }, { tiktokMaxVideoSec: 180 })).toEqual([
			'TikTok takes videos up to 3:00 — this one is 3:20'
		]);
		expect(messages({ text: '', media: [video] }, { tiktokMaxVideoSec: 600 })).toEqual([]);
	});
});

describe('TikTok chunk plan', () => {
	const MB = 1_000_000;

	it('sends anything under two parts whole', () => {
		expect(tiktokChunkPlan(1234)).toEqual({ chunkSize: 1234, count: 1 });
		expect(tiktokChunkPlan(2 * TIKTOK_CHUNK_BYTES - 1)).toEqual({
			chunkSize: 2 * TIKTOK_CHUNK_BYTES - 1,
			count: 1
		});
	});

	it('rounds the part count down, so the last part carries the remainder', () => {
		expect(tiktokChunkPlan(40 * MB)).toEqual({ chunkSize: 20 * MB, count: 2 });
		expect(tiktokChunkPlan(61 * MB)).toEqual({ chunkSize: 20 * MB, count: 3 });
		expect(tiktokChunkPlan(300 * MB)).toEqual({ chunkSize: 20 * MB, count: 15 });
		const plan = tiktokChunkPlan(61 * MB);
		expect(tiktokChunkRange(plan, 61 * MB, 0)).toEqual([0, 20 * MB - 1]);
		expect(tiktokChunkRange(plan, 61 * MB, 2)).toEqual([40 * MB, 61 * MB - 1]);
	});

	it('stays inside TikTok’s part sizes for every video CogSend stores', () => {
		const MiB = 1024 * 1024;
		for (const size of [1, 5 * MB, 39 * MB, 40 * MB, 64 * MB, 99_999_999, 300 * MB]) {
			const plan = tiktokChunkPlan(size);
			const [first] = [tiktokChunkRange(plan, size, 0)];
			const [lastStart, lastEnd] = tiktokChunkRange(plan, size, plan.count - 1);
			const lastSize = lastEnd - lastStart + 1;
			expect(plan.count).toBe(Math.floor(size / plan.chunkSize));
			expect(lastEnd).toBe(size - 1);
			if (plan.count > 1) {
				expect(first[1] - first[0] + 1).toBeGreaterThanOrEqual(5 * MiB);
				expect(plan.chunkSize).toBeLessThanOrEqual(64 * MB);
			}
			expect(lastSize).toBeLessThanOrEqual(64 * MB);
			expect(plan.count).toBeLessThanOrEqual(1000);
		}
	});
});

describe('TikTok publish', () => {
	it('checks creator_info, starts a Direct Post, uploads, and waits for it', async () => {
		const { store, bytes, video } = await storedVideo(5000);
		const n = tiktokNetwork({
			statuses: [
				'{"data":{"status":"PUBLISH_COMPLETE","publicaly_available_post_id":[7301234567890123456]},"error":{"code":"ok","message":"","log_id":"l"}}'
			]
		});
		const checkpoints: string[][] = [];
		const result = await publish(video, store, n, {
			choice: { privacy: 'PUBLIC_TO_EVERYONE', allowComment: true, allowStitch: true },
			checkpoint: (c) => {
				checkpoints.push(c.segmentIds);
			}
		});
		expect(n.record.inits).toEqual([
			{
				post_info: {
					privacy_level: 'PUBLIC_TO_EVERYONE',
					disable_comment: false,
					// Not ticked here.
					disable_duet: true,
					// Ticked here, but turned off in TikTok: it stays off.
					disable_stitch: true,
					brand_content_toggle: false,
					brand_organic_toggle: false,
					title: 'Behind the scenes #studio'
				},
				source_info: {
					source: 'FILE_UPLOAD',
					video_size: 5000,
					chunk_size: 5000,
					total_chunk_count: 1
				}
			}
		]);
		expect(n.record.parts).toHaveLength(1);
		expect(n.record.parts[0].range).toBe('bytes 0-4999/5000');
		expect(n.record.parts[0].type).toBe('video/mp4');
		expect(Buffer.from(n.record.parts[0].bytes).equals(Buffer.from(bytes))).toBe(true);
		expect(n.record.statusIds).toEqual(['v_pub_file~v2.1']);
		expect(n.record.auth.every((a) => a === 'Bearer act.token')).toBe(true);
		// The id is past what a JS number holds exactly; it must arrive intact.
		expect(result).toEqual({
			remotePostId: '7301234567890123456',
			remoteUrl: 'https://www.tiktok.com/@acme/video/7301234567890123456'
		});
		expect(checkpoints).toEqual([['7301234567890123456']]);
	});

	it('keeps interactions off unless they were ticked', async () => {
		const { store, video } = await storedVideo(100);
		const n = tiktokNetwork();
		const result = await publish(video, store, n, { text: '' });
		expect(n.record.inits[0].post_info).toEqual({
			privacy_level: 'SELF_ONLY',
			disable_comment: true,
			disable_duet: true,
			disable_stitch: true,
			brand_content_toggle: false,
			brand_organic_toggle: false
		});
		// A private post gets no public id: TikTok's publish id stands in, with no link.
		expect(result).toEqual({ remotePostId: 'v_pub_file~v2.1', remoteUrl: undefined });
	});

	it('sends a large video in parts, each read from storage as it goes', async () => {
		const size = 3 * TIKTOK_CHUNK_BYTES + 12_345;
		const { store, bytes, video } = await storedVideo(size);
		const n = tiktokNetwork();
		await publish(video, store, n);
		expect(n.record.inits[0].source_info).toEqual({
			source: 'FILE_UPLOAD',
			video_size: size,
			chunk_size: TIKTOK_CHUNK_BYTES,
			total_chunk_count: 3
		});
		const c = TIKTOK_CHUNK_BYTES;
		expect(n.record.parts.map((p) => p.range)).toEqual([
			`bytes 0-${c - 1}/${size}`,
			`bytes ${c}-${2 * c - 1}/${size}`,
			`bytes ${2 * c}-${size - 1}/${size}`
		]);
		const joined = Buffer.concat(n.record.parts.map((p) => Buffer.from(p.bytes)));
		expect(joined.equals(Buffer.from(bytes))).toBe(true);
	});

	it('parks between parts when the request runs low, and resumes without starting over', async () => {
		const size = 2 * TIKTOK_CHUNK_BYTES + 10;
		const { store, video } = await storedVideo(size);
		const n = tiktokNetwork();
		// creator_info and the start, one part, then too few calls for another.
		n.net.left = 8;
		const err = await parked(publish(video, store, n));
		expect(n.record.parts).toHaveLength(1);
		expect(err.pending?.state).toMatchObject({ publishId: 'v_pub_file~v2.1', next: 1 });
		expect(err.pending?.state.sent).toBeUndefined();

		n.net.left = Infinity;
		const result = await publish(video, store, n, { resume: resumeFrom(err) });
		expect(result.remotePostId).toBe('v_pub_file~v2.1');
		expect(n.record.inits).toHaveLength(1);
		expect(n.record.creatorCalls).toBe(1);
		expect(n.record.parts.map((p) => p.range)).toEqual([
			`bytes 0-${TIKTOK_CHUNK_BYTES - 1}/${size}`,
			`bytes ${TIKTOK_CHUNK_BYTES}-${size - 1}/${size}`
		]);
	});

	it('parks a post TikTok is still processing, and resumes by asking, never uploading again', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({ statuses: [{ status: 'PROCESSING_UPLOAD' }] });
		// Time runs out once TikTok has been asked once.
		const err = await parked(
			publish(video, store, n, { timeLeft: () => (n.record.statusIds.length ? 0 : Infinity) })
		);
		expect(err.pending?.state).toMatchObject({ publishId: 'v_pub_file~v2.1', sent: true });

		const later = tiktokNetwork({ statuses: [{ status: 'PUBLISH_COMPLETE' }] });
		const result = await publish(video, store, later, { resume: resumeFrom(err) });
		expect(result.remotePostId).toBe('v_pub_file~v2.1');
		expect(later.record.inits).toHaveLength(0);
		expect(later.record.parts).toHaveLength(0);
		expect(later.record.creatorCalls).toBe(0);
		expect(later.record.statusIds).toEqual(['v_pub_file~v2.1']);
	});

	it('takes a lost answer to the last part as sent: it polls, and never sends the video twice', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({
			part: () => {
				throw new TypeError('fetch failed');
			},
			statuses: [{ status: 'PUBLISH_COMPLETE' }]
		});
		const result = await publish(video, store, n);
		expect(result.remotePostId).toBe('v_pub_file~v2.1');
		expect(n.record.parts).toHaveLength(1);
		expect(n.record.inits).toHaveLength(1);
	});

	it('ends as unconfirmed, not as a retry, when a sent post stays processing too long', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({ statuses: [{ status: 'PROCESSING_UPLOAD' }] });
		const resume = {
			segmentIds: [],
			pending: {
				segment: 0,
				storageKey: 'v.mp4',
				startedAt: Date.now() - 41 * 60_000,
				state: {
					publishId: 'v_pub_old',
					uploadUrl: `${UPLOAD_HOST}/upload/?id=old`,
					size: 5000,
					chunkSize: 5000,
					count: 1,
					next: 1,
					sent: true,
					confirmed: true
				}
			}
		};
		const err = await failure(publish(video, store, n, { resume, timeLeft: () => 0 }));
		expect(err.code).toBe('unconfirmed');
		expect(err.message).toContain(UNCONFIRMED_POST_MARK);
		expect(err.retryable).toBe(false);
		expect(n.record.inits).toHaveLength(0);
	});

	it('starts a fresh upload when a resumed post failed for TikTok’s own reasons', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({
			statuses: [{ status: 'FAILED', fail_reason: 'internal' }, { status: 'PUBLISH_COMPLETE' }]
		});
		const resume = {
			segmentIds: [],
			pending: {
				segment: 0,
				storageKey: 'v.mp4',
				startedAt: Date.now(),
				state: {
					publishId: 'v_pub_dead',
					uploadUrl: `${UPLOAD_HOST}/upload/?id=dead`,
					size: 5000,
					chunkSize: 5000,
					count: 1,
					next: 1,
					sent: true
				}
			}
		};
		const result = await publish(video, store, n, { resume });
		expect(result.remotePostId).toBe('v_pub_file~v2.1');
		expect(n.record.statusIds).toEqual(['v_pub_dead', 'v_pub_file~v2.1']);
		expect(n.record.inits).toHaveLength(1);
	});

	it('names a failure TikTok gives a reason for, and does not retry it', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({
			statuses: [{ status: 'FAILED', fail_reason: 'frame_rate_check_failed' }]
		});
		const err = await failure(publish(video, store, n));
		expect(err.code).toBe('forbidden');
		expect(err.message).toBe('TikTok could not publish the video: frame_rate_check_failed');
		expect(n.record.inits).toHaveLength(1);
	});

	it('explains the audit when an unaudited app posts to a public account', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({
			init: Response.json(
				{
					error: {
						code: 'unaudited_client_can_only_post_to_private_accounts',
						message: 'Please review our integration guidelines',
						logid: 'l'
					}
				},
				{ status: 403 }
			)
		});
		const err = await failure(publish(video, store, n));
		expect(err.code).toBe('forbidden');
		expect(err.retryable).toBe(false);
		expect(err.message).toBe(UNAUDITED_MESSAGE);
		expect(err.message).not.toMatch(/403|forbidden/i);
		expect(n.record.parts).toHaveLength(0);
	});

	it('treats a rejected token as an expired account', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({
			creator: Response.json(
				{
					error: {
						code: 'access_token_invalid',
						message: 'The access token is invalid or not found in the request.',
						log_id: 'l'
					}
				},
				{ status: 401 }
			)
		});
		const err = await failure(publish(video, store, n));
		expect(err.code).toBe('auth');
		expect(err.status).toBe(401);
		expect(n.record.inits).toHaveLength(0);
	});

	it('reads a creator who may not post right now from an HTTP 200', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({
			creator: Response.json({
				data: {},
				error: { code: 'spam_risk_too_many_posts', message: 'too many', log_id: 'l' }
			})
		});
		const err = await failure(publish(video, store, n));
		expect(err.code).toBe('rate_limited');
		expect(err.retryAfterMs).toBe(60 * 60_000);
		expect(n.record.inits).toHaveLength(0);
	});

	it('stops before uploading when TikTok no longer offers the chosen privacy', async () => {
		const { store, video } = await storedVideo(5000);
		const n = tiktokNetwork({
			creator: Response.json({
				data: {
					...CREATOR,
					privacy_level_options: ['FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY']
				},
				error: OK
			})
		});
		const err = await failure(
			publish(video, store, n, { choice: { privacy: 'PUBLIC_TO_EVERYONE' } })
		);
		expect(err.code).toBe('forbidden');
		expect(err.message).toMatch(/does not offer “Everyone”/);
		// The account learns what it may choose now.
		expect(err.metaPatch?.tiktokPrivacyOptions).toEqual([
			'FOLLOWER_OF_CREATOR',
			'MUTUAL_FOLLOW_FRIENDS',
			'SELF_ONLY'
		]);
		expect(n.record.inits).toHaveLength(0);
	});

	it('refuses a video longer than this creator may post', async () => {
		const { store, video } = await storedVideo(5000, 200_000);
		const n = tiktokNetwork({
			creator: Response.json({ data: { ...CREATOR, max_video_post_duration_sec: 180 }, error: OK })
		});
		const err = await failure(publish(video, store, n));
		expect(err.message).toBe(
			'TikTok lets this account post videos up to 3:00, and this one is 3:20'
		);
		expect(n.record.inits).toHaveLength(0);
	});

	it('returns what an earlier run already published', async () => {
		const { store, video } = await storedVideo(10);
		const n = tiktokNetwork();
		const result = await publish(video, store, n, { resume: { segmentIds: ['v_pub_done'] } });
		expect(result.remotePostId).toBe('v_pub_done');
		expect(n.record.creatorCalls).toBe(0);
	});
});

describe('TikTok error codes', () => {
	const body = (code: string) => JSON.stringify({ error: { code, message: code, log_id: 'l' } });

	it('classifies by code', () => {
		expect(tiktokApiError('x', 401, body('scope_not_authorized')).code).toBe('auth');
		expect(tiktokApiError('x', 400, body('scope_permission_missed')).code).toBe('auth');
		expect(tiktokApiError('x', 429, body('rate_limit_exceeded')).code).toBe('rate_limited');
		expect(tiktokApiError('x', 403, body('reached_active_user_cap')).code).toBe('rate_limited');
		expect(tiktokApiError('x', 403, body('spam_risk_user_banned_from_posting')).code).toBe(
			'forbidden'
		);
		expect(tiktokApiError('x', 403, body('privacy_level_option_mismatch')).code).toBe('forbidden');
		expect(tiktokApiError('x', 400, body('invalid_param')).code).toBe('forbidden');
		expect(tiktokApiError('x', 500, body('internal_error')).code).toBe('upstream');
		expect(tiktokApiError('x', 502, 'Bad gateway').code).toBe('upstream');
	});
});
