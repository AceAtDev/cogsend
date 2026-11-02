import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { eq } from 'drizzle-orm';
import { createClient, type Client } from '@libsql/client';
import {
	EMPTY_TIKTOK_CHOICE,
	parseTiktokChoice,
	readTiktokChoices,
	tiktokAccountProblem,
	tiktokChoiceProblem,
	tiktokDisclosureNotice,
	tiktokDurationProblem,
	tiktokNeedsBrandedConsent,
	tiktokPostInfo,
	tiktokPrivacyAllowed,
	tiktokPrivacyOptions,
	type TiktokPostChoice
} from '#lib/domain/tiktok.js';
import {
	tiktokVerificationBody,
	tiktokVerificationTokens
} from '#lib/domain/tiktok-verification.js';
import { createTestMedia, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { createD1Db, newId, type AppDb } from '#lib/server/db/client.js';
import { ensureSchema } from '#lib/server/db/init-sql.js';
import { connections, users } from '#lib/server/db/schema.js';
import { encryptJson } from '#lib/server/crypto.js';
import { tiktokProvider } from '#lib/server/providers/tiktok.js';
import {
	ProviderError,
	type FetchLike,
	type MediaAttachment
} from '#lib/server/providers/types.js';
import { verifiedMediaUrlFor } from '#lib/server/publish.js';
import {
	describeTiktokChoice,
	planTiktokChoices,
	tiktokConsentLine,
	tiktokInboxNote
} from '#lib/server/api/agent-tiktok.js';
import type { Channel } from '#lib/domain/channel-keys.js';
import { handle, isPublicPath, tiktokVerificationResponse } from '../src/hooks.server';
import { useWorkerEnv } from './cloudflare-workers';
import { GET as creatorInfoGET } from '../src/routes/api/connections/[id]/creator-info/+server';
import { load as homeLoad } from '../src/routes/+page.server';
import TermsPage from '../src/routes/legal/terms/+page.svelte';
import PrivacyPage from '../src/routes/legal/privacy/+page.svelte';
import PublicHome from '#lib/components/PublicHome.svelte';

const choice = (patch: Partial<TiktokPostChoice> = {}): TiktokPostChoice => ({
	...EMPTY_TIKTOK_CHOICE,
	...patch
});

/**
 * The rules TikTok's Content Sharing Guidelines put on the post screen
 * (https://developers.tiktok.com/doc/content-sharing-guidelines), as the
 * composer and the server both apply them.
 */
describe('TikTok post choices', () => {
	it('starts with no privacy and every switch off', () => {
		const parsed = parseTiktokChoice({});
		expect(parsed).toEqual({ ok: true, choice: EMPTY_TIKTOK_CHOICE });
		expect(EMPTY_TIKTOK_CHOICE.privacy).toBeNull();
		expect(tiktokChoiceProblem(EMPTY_TIKTOK_CHOICE)).toBe('Choose who can see this TikTok post');
		expect(tiktokChoiceProblem(undefined)).toBe('Choose who can see this TikTok post');
	});

	it('refuses unknown fields and values, and drops brand choices with disclosure off', () => {
		expect(parseTiktokChoice({ privacy: 'EVERYONE' }).ok).toBe(false);
		expect(parseTiktokChoice({ allowDuet: 'yes' }).ok).toBe(false);
		expect(parseTiktokChoice({ autoAddMusic: true }).ok).toBe(false);
		expect(parseTiktokChoice([]).ok).toBe(false);
		const parsed = parseTiktokChoice({ privacy: 'SELF_ONLY', brandedContent: true });
		expect(parsed.ok && parsed.choice.brandedContent).toBe(false);
		expect(readTiktokChoices({ a: { privacy: 'SELF_ONLY' }, b: { privacy: 'nope' } })).toEqual({
			a: choice({ privacy: 'SELF_ONLY' })
		});
	});

	it('offers exactly the privacy levels creator_info returned, and none before it', () => {
		expect(tiktokPrivacyOptions(null)).toEqual([]);
		expect(
			tiktokPrivacyOptions({
				privacyOptions: ['SELF_ONLY', 'FOLLOWER_OF_CREATOR', 'MUTUAL_FOLLOW_FRIENDS', 'BOGUS']
			})
		).toEqual(['MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
		expect(
			tiktokChoiceProblem(choice({ privacy: 'PUBLIC_TO_EVERYONE' }), {
				privacyOptions: ['FOLLOWER_OF_CREATOR', 'SELF_ONLY']
			})
		).toMatch(/does not offer “Everyone”/);
	});

	it('needs a brand choice once disclosure is on, and labels the post as TikTok words it', () => {
		const on = choice({ privacy: 'PUBLIC_TO_EVERYONE', disclose: true });
		expect(tiktokChoiceProblem(on)).toBe(
			'You need to indicate if your content promotes yourself, a third party, or both.'
		);
		expect(tiktokDisclosureNotice(choice({ privacy: 'SELF_ONLY' }))).toBeNull();
		expect(tiktokDisclosureNotice({ ...on, yourBrand: true })).toBe(
			"Your video will be labeled as 'Promotional content'"
		);
		expect(tiktokDisclosureNotice({ ...on, brandedContent: true })).toBe(
			"Your video will be labeled as 'Paid partnership'"
		);
		expect(tiktokDisclosureNotice({ ...on, yourBrand: true, brandedContent: true })).toBe(
			"Your video will be labeled as 'Paid partnership'"
		);
		expect(tiktokNeedsBrandedConsent({ ...on, yourBrand: true })).toBe(false);
		expect(tiktokNeedsBrandedConsent({ ...on, brandedContent: true })).toBe(true);
	});

	it('never lets branded content be private', () => {
		const branded = choice({ disclose: true, brandedContent: true });
		expect(tiktokPrivacyAllowed('SELF_ONLY', branded)).toBe(false);
		expect(tiktokPrivacyAllowed('MUTUAL_FOLLOW_FRIENDS', branded)).toBe(true);
		expect(tiktokPrivacyAllowed('SELF_ONLY', choice({ disclose: true, yourBrand: true }))).toBe(
			true
		);
		expect(tiktokChoiceProblem({ ...branded, privacy: 'SELF_ONLY' })).toBe(
			'Branded content visibility cannot be set to private.'
		);
	});

	it('checks the video against max_video_post_duration_sec', () => {
		expect(tiktokDurationProblem(60, 60_400)).toBeNull();
		expect(tiktokDurationProblem(60, 61_000)).toBe(
			'TikTok lets this account post videos up to 1:00, and this one is 1:01'
		);
		expect(tiktokDurationProblem(undefined, 61_000)).toBeNull();
		expect(
			tiktokChoiceProblem(choice({ privacy: 'SELF_ONLY' }), { maxVideoSec: 60 }, 90_000)
		).toMatch(/up to 1:00/);
	});

	it('stops the composer until creator_info is read and the creator may post', () => {
		const ready = {
			status: 'ready' as const,
			creator: {
				nickname: 'Acme',
				username: 'acme',
				avatarUrl: null,
				privacyOptions: ['SELF_ONLY'],
				commentDisabled: false,
				duetDisabled: false,
				stitchDisabled: false
			}
		};
		expect(tiktokAccountProblem(undefined, undefined, null)).toMatch(/Reading/);
		expect(tiktokAccountProblem({ status: 'loading' }, undefined, null)).toMatch(/Reading/);
		expect(
			tiktokAccountProblem(
				{ status: 'cannot_post', reason: 'This TikTok account has reached its daily post limit' },
				choice({ privacy: 'SELF_ONLY' }),
				null
			)
		).toBe('This TikTok account has reached its daily post limit. Try again later.');
		expect(tiktokAccountProblem(ready, undefined, null)).toBe(
			'Choose who can see this TikTok post'
		);
		expect(tiktokAccountProblem(ready, choice({ privacy: 'SELF_ONLY' }), null)).toBeNull();
	});

	it('lets a draft go out with no other choice, since the creator makes them in TikTok', () => {
		const parsed = parseTiktokChoice({
			draft: true,
			privacy: 'PUBLIC_TO_EVERYONE',
			disclose: true
		});
		expect(parsed).toEqual({ ok: true, choice: choice({ draft: true }) });
		const draft = choice({ draft: true });
		expect(tiktokChoiceProblem(draft)).toBeNull();
		expect(tiktokChoiceProblem(draft, { maxVideoSec: 60 }, 90_000)).toMatch(/up to 1:00/);
		expect(tiktokAccountProblem({ status: 'loading' }, draft, null)).toBeNull();
		expect(tiktokNeedsBrandedConsent(draft)).toBe(false);
	});

	it('takes a bare draft from an agent and leaves it out of the consent line', () => {
		const channel = {
			key: 'acme.tiktok',
			platform: 'tiktok',
			connectionId: 'c1'
		} as unknown as Channel;
		const plan = planTiktokChoices({
			field: 'tiktok',
			input: { draft: true },
			channels: [channel],
			dir: { brands: [], channels: [channel] },
			stored: {},
			rulesOf: () => ({ privacyOptions: ['SELF_ONLY'] })
		});
		expect(plan.problems).toEqual([]);
		expect(plan.choices).toEqual({ c1: choice({ draft: true }) });
		expect(describeTiktokChoice(plan.choices.c1)).toMatch(/inbox/);
		expect(tiktokConsentLine([plan.choices.c1])).toBeNull();
		expect(tiktokConsentLine([plan.choices.c1, choice({ privacy: 'SELF_ONLY' })])).toMatch(
			/Music Usage/
		);
	});

	it('tells an agent missing a choice that a draft is the way to a public post', () => {
		const channel = {
			key: 'acme.tiktok',
			platform: 'tiktok',
			connectionId: 'c1'
		} as unknown as Channel;
		const plan = planTiktokChoices({
			field: 'tiktok',
			input: undefined,
			channels: [channel],
			dir: { brands: [], channels: [channel] },
			stored: {},
			rulesOf: () => ({ privacyOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'] })
		});
		expect(plan.problems[0]).toMatch(/Only me/);
		expect(plan.problems[0]).toMatch(/"draft": true/);
		expect(tiktokInboxNote('v_inbox_file~v2.7703616327763642388')).toMatch(/not posted yet/);
		expect(tiktokInboxNote('v_pub_file~v2.1')).toBeNull();
		expect(tiktokInboxNote(null)).toBeNull();
	});

	it('maps the choice to post_info, keeping off what the creator turned off', () => {
		expect(
			tiktokPostInfo(
				{
					...choice({ privacy: 'FOLLOWER_OF_CREATOR', allowComment: true, allowDuet: true }),
					privacy: 'FOLLOWER_OF_CREATOR',
					disclose: true,
					yourBrand: true,
					brandedContent: true
				},
				{ duetDisabled: true },
				'caption'
			)
		).toEqual({
			privacy_level: 'FOLLOWER_OF_CREATOR',
			disable_comment: false,
			disable_duet: true,
			disable_stitch: true,
			brand_content_toggle: true,
			brand_organic_toggle: true,
			title: 'caption'
		});
	});
});

const CREATOR = {
	creator_avatar_url: 'https://p16.tiktokcdn.test/a.jpg',
	creator_username: 'acme',
	creator_nickname: 'Acme Studio',
	privacy_level_options: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY'],
	comment_disabled: true,
	duet_disabled: false,
	stitch_disabled: false,
	max_video_post_duration_sec: 600
};
const OK = { code: 'ok', message: '' };

function network(init?: () => Response) {
	const calls: string[] = [];
	const inits: Array<Record<string, unknown>> = [];
	const fetchImpl: FetchLike = async (input, req) => {
		const url = String(input);
		calls.push(url);
		if (url.endsWith('/creator_info/query/')) return Response.json({ data: CREATOR, error: OK });
		if (url.endsWith('/video/init/')) {
			inits.push(JSON.parse(String(req?.body)) as Record<string, unknown>);
			if (init && inits.length === 1) return init();
			return Response.json({
				data: { publish_id: `p${inits.length}`, upload_url: 'https://upload.test/u' },
				error: OK
			});
		}
		if (url.startsWith('https://upload.test/')) return new Response(null, { status: 201 });
		if (url.endsWith('/status/fetch/'))
			return Response.json({ data: { status: 'PUBLISH_COMPLETE' }, error: OK });
		return new Response('unmocked', { status: 404 });
	};
	return { calls, inits, fetchImpl };
}

async function storedVideo() {
	const store = createTestMedia();
	await store.put('v.mp4', new Uint8Array(100), 'video/mp4');
	const video: MediaAttachment = {
		storageKey: 'v.mp4',
		mime: 'video/mp4',
		size: 100,
		video: { durationMs: 10_000, videoCodec: 'avc', fps: 30, faststart: true }
	};
	return { store, video };
}

describe('TikTok provider and the per-post choice', () => {
	const creds = { accessToken: 'act', tiktokUsername: 'acme' };

	it('refuses to publish without a privacy choice, before calling TikTok', async () => {
		const { store, video } = await storedVideo();
		const n = network();
		const err = await tiktokProvider
			.publish({ text: 'x', media: [video] }, creds, undefined, n.fetchImpl, {
				mediaReader: store as never
			})
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ProviderError);
		expect((err as ProviderError).code).toBe('forbidden');
		expect((err as ProviderError).message).toMatch(/Choose who can see this TikTok post/);
		expect(n.calls).toEqual([]);
	});

	it('sends the creator’s choice, disclosure included, in post_info', async () => {
		const { store, video } = await storedVideo();
		const n = network();
		const tiktok = choice({
			privacy: 'MUTUAL_FOLLOW_FRIENDS',
			allowComment: true,
			allowDuet: true,
			disclose: true,
			brandedContent: true
		});
		await tiktokProvider.publish(
			{ text: 'hello', media: [video], options: { tiktok } },
			creds,
			undefined,
			n.fetchImpl,
			{ mediaReader: store as never }
		);
		expect(n.inits[0].post_info).toEqual({
			privacy_level: 'MUTUAL_FOLLOW_FRIENDS',
			// Ticked, but the creator turned comments off in TikTok.
			disable_comment: true,
			disable_duet: false,
			disable_stitch: true,
			brand_content_toggle: true,
			brand_organic_toggle: false,
			title: 'hello'
		});
	});

	it('pulls the video from a verified address, and uploads it when TikTok has not verified it', async () => {
		const { store, video } = await storedVideo();
		const tiktok = choice({ privacy: 'SELF_ONLY' });
		const pulled = network();
		await tiktokProvider.publish(
			{ text: '', media: [video], options: { tiktok } },
			creds,
			undefined,
			pulled.fetchImpl,
			{ verifiedMediaUrlFor: () => 'https://cogsend.example.com/api/media/public/v.mp4?sig=1' }
		);
		expect(pulled.inits[0].source_info).toEqual({
			source: 'PULL_FROM_URL',
			video_url: 'https://cogsend.example.com/api/media/public/v.mp4?sig=1'
		});
		expect(pulled.calls.some((c) => c.startsWith('https://upload.test/'))).toBe(false);

		const refused = network(() =>
			Response.json(
				{ error: { code: 'url_ownership_unverified', message: 'verify' } },
				{ status: 403 }
			)
		);
		await tiktokProvider.publish(
			{ text: '', media: [video], options: { tiktok } },
			creds,
			undefined,
			refused.fetchImpl,
			{
				mediaReader: store as never,
				verifiedMediaUrlFor: () => 'https://cogsend.example.com/v.mp4'
			}
		);
		expect(refused.inits.map((i) => (i.source_info as { source: string }).source)).toEqual([
			'PULL_FROM_URL',
			'FILE_UPLOAD'
		]);
	});

	it('pulls only when TikTok verified the instance’s own https address', () => {
		expect(verifiedMediaUrlFor(TEST_ENV, 'v.mp4')).toBeNull();
		const env = {
			...TEST_ENV,
			APP_URL: 'https://cogsend.example.com',
			TIKTOK_SITE_VERIFICATION: 'abcdEFGH1234'
		};
		expect(verifiedMediaUrlFor({ ...env, TIKTOK_SITE_VERIFICATION: '' }, 'v.mp4')).toBeNull();
		return expect(verifiedMediaUrlFor(env, 'v.mp4')).resolves.toMatch(
			/^https:\/\/cogsend\.example\.com\/api\/media\/public\/v\.mp4\?exp=/
		);
	});
});

describe('TikTok URL verification file', () => {
	it('accepts the token, the file name or the file contents', () => {
		expect(
			tiktokVerificationTokens(
				'abcdEFGH1234, tiktokZZZZyyyy9999.txt\ntiktok-developers-site-verification=QQQQrrrr5555 bad!'
			)
		).toEqual(['abcdEFGH1234', 'ZZZZyyyy9999', 'QQQQrrrr5555']);
		expect(tiktokVerificationTokens(undefined)).toEqual([]);
	});

	it('serves exactly the signature for a configured token, and 404 otherwise', async () => {
		const env = { TIKTOK_SITE_VERIFICATION: 'abcdEFGH1234' };
		expect(tiktokVerificationBody(env.TIKTOK_SITE_VERIFICATION, 'tiktokabcdEFGH1234.txt')).toBe(
			'tiktok-developers-site-verification=abcdEFGH1234'
		);
		const hit = tiktokVerificationResponse(env, 'tiktokabcdEFGH1234.txt');
		expect(hit.status).toBe(200);
		expect(hit.headers.get('content-type')).toMatch(/^text\/plain/);
		expect(await hit.text()).toBe('tiktok-developers-site-verification=abcdEFGH1234');
		expect(tiktokVerificationResponse(env, 'tiktokotherTOKEN99.txt').status).toBe(404);
		expect(tiktokVerificationResponse({}, 'tiktokabcdEFGH1234.txt').status).toBe(404);
	});
});

const facts = {
	appName: 'Acme Publishing',
	appUrl: 'https://cogsend.example.com',
	host: 'cogsend.example.com',
	contactEmail: 'hello@acme.test',
	signup: null as 'waitlist' | 'open' | null
};

describe('public pages', () => {
	it('opens the legal pages without an account, and nothing else new', () => {
		expect(isPublicPath('/legal/terms')).toBe(true);
		expect(isPublicPath('/legal/privacy')).toBe(true);
		expect(isPublicPath('/')).toBe(false);
		expect(isPublicPath('/legal/other')).toBe(false);
		expect(isPublicPath('/compose')).toBe(false);
	});

	it('renders the terms and privacy policy with the instance’s name and contact', () => {
		const terms = render(TermsPage, { props: { data: { facts } } as never }).body;
		expect(terms).toContain('Terms of Service');
		expect(terms).toContain('Acme Publishing');
		expect(terms).toContain('mailto:hello@acme.test');
		expect(terms).toContain('https://www.tiktok.com/legal/page/global/music-usage-confirmation/en');
		const privacy = render(PrivacyPage, { props: { data: { facts } } as never }).body;
		expect(privacy).toContain('Privacy Policy');
		expect(privacy).toContain('encrypted');
		expect(privacy).toMatch(/Disconnecting deletes its\s+tokens at once/);
		expect(privacy).toContain('Nothing is sold');
		const noContact = render(PrivacyPage, {
			props: { data: { facts: { ...facts, contactEmail: null } } } as never
		}).body;
		expect(noContact).toContain('the operator of Acme Publishing');
	});

	it('shows the homepage with visible terms, privacy and sign-in links', () => {
		const body = render(PublicHome, { props: { facts } }).body;
		expect(body).toContain('Acme Publishing');
		expect(body).toContain('href="/legal/terms"');
		expect(body).toContain('href="/legal/privacy"');
		expect(body).toContain('href="/login"');
		expect(body).toContain('TikTok');
		expect(body).not.toContain('href="/signup"');
		expect(body).toContain('Operator sign in');
	});

	it('says sign-up exists, on the homepage and in the terms, when it does', () => {
		for (const mode of ['waitlist', 'open'] as const) {
			const withSignup = { ...facts, signup: mode };
			const home = render(PublicHome, { props: { facts: withSignup } }).body;
			expect(home).toContain('href="/signup"');
			expect(home).toContain(mode === 'open' ? 'Anyone can sign up' : 'join the waitlist');
			const terms = render(TermsPage, { props: { data: { facts: withSignup } } as never }).body;
			expect(terms).not.toContain('There is no public sign-up');
			expect(terms).toContain('sign up for an account of their own');
			const privacy = render(PrivacyPage, { props: { data: { facts: withSignup } } as never }).body;
			expect(privacy).toContain('each person who signs up');
		}
		const terms = render(TermsPage, { props: { data: { facts } } as never }).body;
		expect(terms).toContain('There is no public sign-up');
	});
});

/** D1-shaped shim over in-memory SQLite: the hook builds its own drizzle handle. */
function d1Shim(client: Client): D1Database {
	const rows = async (sql: string, args: unknown[] = []) =>
		(await client.execute({ sql, args: args as never })) as unknown as { rows: unknown[] };
	return {
		exec: (sql: string) => client.executeMultiple(sql) as unknown as Promise<unknown>,
		prepare: (sql: string) => {
			const stmt = (bindArgs: unknown[] = []) => ({
				run: () => client.execute({ sql, args: bindArgs as never }) as Promise<unknown>,
				all: async () => ({ results: (await rows(sql, bindArgs)).rows, success: true, meta: {} }),
				raw: async () =>
					(await rows(sql, bindArgs)).rows.map((row) =>
						Object.values(row as Record<string, unknown>)
					),
				first: async () => (await rows(sql, bindArgs)).rows[0] ?? null,
				bind: (...args: unknown[]) => stmt(args)
			});
			return stmt();
		}
	} as unknown as D1Database;
}

describe('the public homepage through the hook', () => {
	let client: Client;
	let binding: D1Database;

	beforeAll(async () => {
		client = createClient({ url: ':memory:' });
		binding = d1Shim(client);
		await ensureSchema(binding);
		createD1Db(binding);
	});
	afterAll(() => client.close());

	async function visit(path: string, extra: Record<string, string> = {}) {
		let routed = false;
		const url = new URL(`https://cogsend.example.com${path}`);
		useWorkerEnv({
			DB: binding,
			APP_URL: 'https://cogsend.example.com',
			APP_ENCRYPTION_KEY: 'feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface',
			MEDIA: {},
			...extra
		});
		const response = await handle({
			event: {
				url,
				request: new Request(url),
				cookies: {
					get: () => undefined,
					set: () => {},
					delete: () => {},
					getAll: () => [],
					serialize: () => ''
				},
				locals: {},
				fetch: async () => new Response('ok'),
				params: {},
				route: { id: path },
				setHeaders: {}
			},
			resolve: async () => {
				routed = true;
				return new Response('routed', { status: 200 });
			}
		} as never);
		return { routed, status: response.status, location: response.headers.get('location') };
	}

	it('sends signed-out visitors to sign in unless the operator turned the homepage on', async () => {
		expect(await visit('/')).toMatchObject({ routed: false, status: 303, location: '/login' });
		expect(await visit('/', { PUBLIC_HOMEPAGE: '0' })).toMatchObject({ routed: false });
		expect(await visit('/', { PUBLIC_HOMEPAGE: '1' })).toMatchObject({ routed: true });
	});

	it('keeps every other page and API behind sign-in with the homepage on', async () => {
		const on = { PUBLIC_HOMEPAGE: '1' };
		expect(await visit('/compose', on)).toMatchObject({ routed: false, location: '/login' });
		expect(await visit('/accounts', on)).toMatchObject({ routed: false, location: '/login' });
		expect(await visit('/api/drafts', on)).toMatchObject({ routed: false, status: 401 });
		expect(await visit('/legal/privacy', on)).toMatchObject({ routed: true });
		expect(await visit('/legal/terms')).toMatchObject({ routed: true });
	});

	it('serves the verification file before sign-in', async () => {
		const hit = await visit('/tiktokabcdEFGH1234.txt', {
			TIKTOK_SITE_VERIFICATION: 'abcdEFGH1234'
		});
		expect(hit).toMatchObject({ routed: false, status: 200 });
		expect((await visit('/tiktokabcdEFGH1234.txt')).status).toBe(404);
	});
});

describe('the root page load', () => {
	it('returns the public homepage only for a signed-out visitor with it turned on', async () => {
		const locals = (env: object, user: unknown = null) =>
			({ user, env: { ...TEST_ENV, ...env }, db: {} }) as never;
		const home = (await homeLoad({
			locals: locals({ PUBLIC_HOMEPAGE: '1', LEGAL_CONTACT_EMAIL: 'hi@acme.test' })
		} as never)) as { publicHome: { contactEmail: string | null } };
		expect(home.publicHome.contactEmail).toBe('hi@acme.test');
		const off = await Promise.resolve()
			.then(() => homeLoad({ locals: locals({}) } as never))
			.catch((e: { status?: number }) => e.status);
		expect(off).toBe(401);
	});
});

describe('GET /api/connections/:id/creator-info', () => {
	let db: AppDb;
	let close: () => void;
	let userId: string;

	beforeAll(async () => {
		({ db, close } = await createTestDb());
		userId = newId();
		const now = new Date();
		await db.insert(users).values({
			id: userId,
			email: 'ci@localhost',
			passwordHash: 'x',
			timezone: 'UTC',
			createdAt: now,
			updatedAt: now
		});
	});
	afterAll(() => close());
	afterEach(() => vi.unstubAllGlobals());

	async function account(platform = 'tiktok') {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId,
			platform,
			handle: '@acme',
			credentialsEncrypted: await encryptJson(
				{ accessToken: 'act', expiresAt: Date.now() + 20 * 3600_000 },
				TEST_ENV.APP_ENCRYPTION_KEY
			),
			metaJson: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	const get = async (id: string, authMethod: 'session' | 'bearer' = 'session') => {
		const res = (await creatorInfoGET({
			params: { id },
			locals: {
				db,
				env: TEST_ENV,
				authMethod,
				user: {
					id: userId,
					email: 'ci@localhost',
					timezone: 'UTC',
					totpEnabled: true,
					mfaVerified: true
				}
			}
		} as never)) as Response;
		return { status: res.status, cache: res.headers.get('cache-control'), body: await res.json() };
	};

	it('reads creator_info fresh, says who the post goes to, and keeps the options', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ data: CREATOR, error: OK }))
		);
		const id = await account();
		const res = await get(id);
		expect(res.status).toBe(200);
		expect(res.cache).toContain('no-store');
		expect(res.body).toEqual({
			canPost: true,
			creator: {
				nickname: 'Acme Studio',
				username: 'acme',
				avatarUrl: 'https://p16.tiktokcdn.test/a.jpg',
				privacyOptions: CREATOR.privacy_level_options,
				commentDisabled: true,
				duetDisabled: false,
				stitchDisabled: false,
				maxVideoSec: 600
			}
		});
		const [row] = await db.select().from(connections).where(eqId(id));
		expect(JSON.parse(row.metaJson)).toMatchObject({
			tiktokPrivacyOptions: CREATOR.privacy_level_options,
			tiktokMaxVideoSec: 600
		});
	});

	it('answers canPost: false when TikTok is not letting the creator post now', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				Response.json({ data: {}, error: { code: 'spam_risk_too_many_posts', message: 'cap' } })
			)
		);
		const res = await get(await account());
		expect(res.status).toBe(200);
		expect(res.body).toEqual({
			creator: null,
			canPost: false,
			reason: 'This TikTok account has reached its daily post limit'
		});
	});

	it('is session-only, and TikTok-only', async () => {
		expect((await get(await account(), 'bearer')).status).toBe(401);
		expect((await get(await account('mastodon'))).status).toBe(400);
		expect((await get('missing')).status).toBe(404);
	});
});

const eqId = (id: string) => eq(connections.id, id);
