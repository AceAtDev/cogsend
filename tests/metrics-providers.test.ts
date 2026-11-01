import { describe, expect, it } from 'vitest';
import { blueskyMetrics } from '#lib/server/providers/bluesky.js';
import { mastodonMetrics } from '#lib/server/providers/mastodon.js';
import { tiktokMetrics, TIKTOK_SCOPES } from '#lib/server/providers/tiktok.js';
import { linkedinMetrics } from '#lib/server/providers/linkedin.js';
import { MetricsError, retryAfterFrom, type FetchLike } from '#lib/server/providers/types.js';
import { LINKEDIN_PERSONAL_MESSAGE } from '#lib/domain/metrics.js';

type Seen = { url: string; init?: RequestInit };

/** A fetch that answers from `reply` and remembers every request. */
function fake(reply: (url: string, init?: RequestInit) => Response) {
	const seen: Seen[] = [];
	const fetchImpl: FetchLike = async (input, init) => {
		const url = typeof input === 'string' ? input : input.toString();
		seen.push({ url, init });
		return reply(url, init);
	};
	return { fetchImpl, seen };
}

async function failure(promise: Promise<unknown>): Promise<MetricsError> {
	try {
		await promise;
	} catch (err) {
		expect(err).toBeInstanceOf(MetricsError);
		return err as MetricsError;
	}
	throw new Error('expected a MetricsError');
}

const uriA = 'at://did:plc:abc/app.bsky.feed.post/3kaaa';
const uriB = 'at://did:plc:abc/app.bsky.feed.post/3kbbb';

describe('Bluesky metrics', () => {
	it('reads likes, reposts, replies and quotes from the public AppView in one call', async () => {
		const { fetchImpl, seen } = fake(() =>
			Response.json({
				posts: [{ uri: uriA, likeCount: 12, repostCount: 3, replyCount: 2, quoteCount: 1 }]
			})
		);
		const out = await blueskyMetrics([uriA, uriB], fetchImpl);
		expect(seen).toHaveLength(1);
		const url = new URL(seen[0].url);
		expect(url.origin + url.pathname).toBe(
			'https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts'
		);
		expect(url.searchParams.getAll('uris')).toEqual([uriA, uriB]);
		expect(new Headers(seen[0].init?.headers).get('authorization')).toBeNull();
		expect(out.get(uriA)).toEqual({
			kind: 'ok',
			counts: { likes: 12, shares: 3, comments: 2, quotes: 1 }
		});
		// getPosts leaves out a post it cannot show: deleted.
		expect(out.get(uriB)).toEqual({ kind: 'not_found' });
	});

	it('backs off with the reset the AppView sends on 429', async () => {
		const reset = Math.floor(Date.now() / 1000) + 300;
		const { fetchImpl } = fake(
			() =>
				new Response('{"error":"RateLimitExceeded"}', {
					status: 429,
					headers: { 'ratelimit-reset': String(reset) }
				})
		);
		const err = await failure(blueskyMetrics([uriA], fetchImpl));
		expect(err.kind).toBe('rate_limited');
		expect(err.retryAfterMs).toBeGreaterThan(290_000);
		expect(err.retryAfterMs).toBeLessThanOrEqual(300_000);
	});

	it('treats a server error as temporary', async () => {
		const { fetchImpl } = fake(() => new Response('oops', { status: 502 }));
		expect((await failure(blueskyMetrics([uriA], fetchImpl))).kind).toBe('transient');
	});

	it('does not call out for a post without an AT-URI', async () => {
		const { fetchImpl, seen } = fake(() => Response.json({ posts: [] }));
		const out = await blueskyMetrics(['not-a-uri'], fetchImpl);
		expect(seen).toHaveLength(0);
		expect(out.get('not-a-uri')?.kind).toBe('unavailable');
	});
});

const mastodonCreds = { accessToken: 'tok', instanceUrl: 'https://mastodon.example' };

describe('Mastodon metrics', () => {
	it('reads favourites, boosts, replies and quotes with the account token', async () => {
		const { fetchImpl, seen } = fake(() =>
			Response.json({
				id: '111',
				favourites_count: 9,
				reblogs_count: 4,
				replies_count: 1,
				quotes_count: 2
			})
		);
		const out = await mastodonMetrics(['111'], mastodonCreds, fetchImpl);
		expect(seen[0].url).toBe('https://mastodon.example/api/v1/statuses/111');
		expect(new Headers(seen[0].init?.headers).get('authorization')).toBe('Bearer tok');
		expect(out.get('111')).toEqual({
			kind: 'ok',
			counts: { likes: 9, shares: 4, comments: 1, quotes: 2 }
		});
	});

	it('leaves quotes empty on a server older than 4.5', async () => {
		const { fetchImpl } = fake(() =>
			Response.json({ favourites_count: 1, reblogs_count: 0, replies_count: 0 })
		);
		const out = await mastodonMetrics(['5'], mastodonCreds, fetchImpl);
		expect(out.get('5')).toEqual({
			kind: 'ok',
			counts: { likes: 1, shares: 0, comments: 0, quotes: null }
		});
	});

	it('reports a deleted status as not found and keeps reading the others', async () => {
		const { fetchImpl } = fake((url) =>
			url.endsWith('/gone')
				? Response.json({ error: 'Record not found' }, { status: 404 })
				: Response.json({ favourites_count: 2, reblogs_count: 0, replies_count: 0 })
		);
		const out = await mastodonMetrics(['gone', 'here'], mastodonCreds, fetchImpl);
		expect(out.get('gone')).toEqual({ kind: 'not_found' });
		expect(out.get('here')?.kind).toBe('ok');
	});

	it('asks for a reconnect when the token is refused', async () => {
		const { fetchImpl } = fake(() =>
			Response.json({ error: 'The access token is invalid' }, { status: 401 })
		);
		expect((await failure(mastodonMetrics(['1'], mastodonCreds, fetchImpl))).kind).toBe(
			'reconnect'
		);
	});

	it('backs off until X-RateLimit-Reset on 429', async () => {
		const reset = new Date(Date.now() + 120_000).toISOString();
		const { fetchImpl } = fake(
			() => new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': reset } })
		);
		const err = await failure(mastodonMetrics(['1'], mastodonCreds, fetchImpl));
		expect(err.kind).toBe('rate_limited');
		expect(err.retryAfterMs).toBeGreaterThan(100_000);
	});

	it('refuses a private instance address unless the instance itself is local', async () => {
		const { fetchImpl, seen } = fake(() => Response.json({}));
		await expect(
			mastodonMetrics(['1'], { accessToken: 't', instanceUrl: 'http://127.0.0.1' }, fetchImpl)
		).rejects.toThrow();
		expect(seen).toHaveLength(0);
	});
});

const tiktokCreds = {
	accessToken: 'tt',
	scopes: [...TIKTOK_SCOPES]
};
const videoA = '7300000000000000001';
const videoB = '7300000000000000002';

describe('TikTok metrics', () => {
	it('asks for video.list when connecting', () => {
		expect(TIKTOK_SCOPES).toContain('video.list');
	});

	it('queries views, likes, comments and shares for up to 20 videos at once', async () => {
		const { fetchImpl, seen } = fake(() =>
			Response.json({
				data: {
					videos: [
						{ id: videoA, view_count: 1500, like_count: 80, comment_count: 7, share_count: 3 }
					]
				},
				error: { code: 'ok', message: '', log_id: 'x' }
			})
		);
		const out = await tiktokMetrics([videoA, videoB], tiktokCreds, fetchImpl);
		const url = new URL(seen[0].url);
		expect(url.origin + url.pathname).toBe('https://open.tiktokapis.com/v2/video/query/');
		expect(url.searchParams.get('fields')).toBe(
			'id,view_count,like_count,comment_count,share_count'
		);
		expect(seen[0].init?.method).toBe('POST');
		expect(JSON.parse(String(seen[0].init?.body))).toEqual({
			filters: { video_ids: [videoA, videoB] }
		});
		expect(out.get(videoA)).toEqual({
			kind: 'ok',
			counts: { views: 1500, likes: 80, comments: 7, shares: 3 }
		});
		expect(out.get(videoB)).toEqual({ kind: 'not_found' });
	});

	it('does not call TikTok for a connection made without video.list', async () => {
		const { fetchImpl, seen } = fake(() => Response.json({}));
		const err = await failure(
			tiktokMetrics(
				[videoA],
				{ accessToken: 'tt', scopes: ['user.info.basic', 'video.publish'] },
				fetchImpl
			)
		);
		expect(err.kind).toBe('reconnect');
		expect(err.message).toMatch(/video\.list/);
		expect(seen).toHaveLength(0);
	});

	it('turns scope_not_authorized into "reconnect to enable metrics"', async () => {
		const { fetchImpl } = fake(() =>
			Response.json(
				{
					error: {
						code: 'scope_not_authorized',
						message: 'The user did not authorize the scope required for completing this request.'
					}
				},
				{ status: 401 }
			)
		);
		const err = await failure(tiktokMetrics([videoA], tiktokCreds, fetchImpl));
		expect(err.kind).toBe('reconnect');
		expect(err.message).toMatch(/enable metrics/);
	});

	it('asks for a reconnect when the token is invalid', async () => {
		const { fetchImpl } = fake(() =>
			Response.json({ error: { code: 'access_token_invalid', message: 'x' } }, { status: 401 })
		);
		expect((await failure(tiktokMetrics([videoA], tiktokCreds, fetchImpl))).kind).toBe('reconnect');
	});

	it('backs off on rate_limit_exceeded', async () => {
		const { fetchImpl } = fake(() =>
			Response.json({ error: { code: 'rate_limit_exceeded', message: '' } }, { status: 429 })
		);
		expect((await failure(tiktokMetrics([videoA], tiktokCreds, fetchImpl))).kind).toBe(
			'rate_limited'
		);
	});

	it('cannot look up a post TikTok gave only a publish id for', async () => {
		const { fetchImpl, seen } = fake(() => Response.json({}));
		const out = await tiktokMetrics(['v_pub_file~v2-1.123'], tiktokCreds, fetchImpl);
		expect(seen).toHaveLength(0);
		expect(out.get('v_pub_file~v2-1.123')?.kind).toBe('unavailable');
	});
});

const orgMeta = { organizationUrn: 'urn:li:organization:2414183' };
const linkedinCreds = { accessToken: 'li' };

describe('LinkedIn metrics', () => {
	it('says personal profiles have no post statistics, without calling LinkedIn', async () => {
		const { fetchImpl, seen } = fake(() => Response.json({}));
		const err = await failure(
			linkedinMetrics(
				['urn:li:share:1'],
				linkedinCreds,
				{ personUrn: 'urn:li:person:x' },
				fetchImpl
			)
		);
		expect(err.kind).toBe('unsupported');
		expect(err.message).toBe(LINKEDIN_PERSONAL_MESSAGE);
		expect(seen).toHaveLength(0);
	});

	it('reads share statistics of a company page, zero for a post LinkedIn leaves out', async () => {
		const { fetchImpl, seen } = fake(() =>
			Response.json({
				paging: { count: 10, start: 0 },
				elements: [
					{
						organizationalEntity: orgMeta.organizationUrn,
						share: 'urn:li:share:7132564752928563200',
						totalShareStatistics: {
							impressionCount: 900,
							uniqueImpressionsCount: 700,
							clickCount: 20,
							likeCount: 15,
							commentCount: 4,
							shareCount: 2,
							engagement: 0.045
						}
					}
				]
			})
		);
		const out = await linkedinMetrics(
			['urn:li:share:7132564752928563200', 'urn:li:share:7132402731377438720'],
			linkedinCreds,
			orgMeta,
			fetchImpl
		);
		expect(seen).toHaveLength(1);
		expect(seen[0].url).toBe(
			'https://api.linkedin.com/rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=urn%3Ali%3Aorganization%3A2414183&shares=List(urn%3Ali%3Ashare%3A7132564752928563200,urn%3Ali%3Ashare%3A7132402731377438720)'
		);
		const headers = new Headers(seen[0].init?.headers);
		expect(headers.get('linkedin-version')).toMatch(/^\d{6}$/);
		expect(headers.get('x-restli-protocol-version')).toBe('2.0.0');
		expect(out.get('urn:li:share:7132564752928563200')).toEqual({
			kind: 'ok',
			counts: { impressions: 900, likes: 15, comments: 4, shares: 2, clicks: 20 }
		});
		expect(out.get('urn:li:share:7132402731377438720')).toEqual({
			kind: 'ok',
			counts: { impressions: 0, likes: 0, comments: 0, shares: 0, clicks: 0 }
		});
	});

	it('asks for UGC posts with the ugcPosts parameter', async () => {
		const { fetchImpl, seen } = fake(() =>
			Response.json({
				elements: [{ ugcPost: 'urn:li:ugcPost:1000000', totalShareStatistics: { likeCount: -1 } }]
			})
		);
		const out = await linkedinMetrics(
			['urn:li:ugcPost:1000000'],
			linkedinCreds,
			orgMeta,
			fetchImpl
		);
		expect(seen[0].url).toContain('&ugcPosts[0]=urn%3Ali%3AugcPost%3A1000000');
		expect(out.get('urn:li:ugcPost:1000000')).toMatchObject({ kind: 'ok', counts: { likes: 0 } });
	});

	it('asks for a reconnect when LinkedIn refuses the permission or the token', async () => {
		for (const status of [401, 403]) {
			const { fetchImpl } = fake(() => Response.json({ status }, { status }));
			expect(
				(await failure(linkedinMetrics(['urn:li:share:1'], linkedinCreds, orgMeta, fetchImpl))).kind
			).toBe('reconnect');
		}
	});

	it('backs off on 429', async () => {
		const { fetchImpl } = fake(() => new Response('', { status: 429 }));
		expect(
			(await failure(linkedinMetrics(['urn:li:share:1'], linkedinCreds, orgMeta, fetchImpl))).kind
		).toBe('rate_limited');
	});
});

describe('retryAfterFrom', () => {
	it('reads seconds, HTTP dates and epoch resets', () => {
		const now = Date.UTC(2026, 9, 31, 12);
		expect(retryAfterFrom(new Headers({ 'retry-after': '30' }), now)).toBe(30_000);
		expect(
			retryAfterFrom(new Headers({ 'retry-after': new Date(now + 60_000).toUTCString() }), now)
		).toBe(60_000);
		expect(retryAfterFrom(new Headers({ 'ratelimit-reset': String(now / 1000 + 90) }), now)).toBe(
			90_000
		);
		expect(retryAfterFrom(new Headers(), now)).toBeUndefined();
	});
});
