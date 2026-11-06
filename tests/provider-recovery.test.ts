import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { xProvider } from '#lib/server/providers/x.js';
import { instagramProvider } from '#lib/server/providers/instagram.js';
import { threadsProvider } from '#lib/server/providers/threads.js';
import { linkedinProvider } from '#lib/server/providers/linkedin.js';
import { tiktokProvider } from '#lib/server/providers/tiktok.js';
import { mastodonProvider } from '#lib/server/providers/mastodon.js';
import type {
	ConnectionCredentials,
	FetchLike,
	PublishCheckpoint
} from '#lib/server/providers/types.js';
import { createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { encryptJson } from '#lib/server/crypto.js';
import { connections, drafts, publishTargets, users } from '#lib/server/db/schema.js';
import { publishTarget, isFailureRetryable } from '#lib/server/publish.js';
import { consumePublishJob, claimDueTargets } from '#lib/server/scheduler.js';

const refreshingProviders = [
	xProvider,
	instagramProvider,
	threadsProvider,
	linkedinProvider,
	tiktokProvider
];
for (const provider of refreshingProviders) {
	it(`${provider.id}: a rejected refresh still requires reconnect`, async () => {
		const creds = {
			accessToken: 'expired',
			refreshToken: 'valid-refresh',
			clientId: 'fake',
			clientSecret: 'fake',
			expiresAt: Date.now() - 1000
		};
		await expect(
			provider.refreshIfNeeded!(creds, async () => Response.json({}, { status: 401 }))
		).rejects.toMatchObject({ code: 'auth', retryable: false });
	});
	it(`${provider.id}: a successful refresh replaces the expired token`, async () => {
		const creds = {
			accessToken: 'expired',
			refreshToken: 'valid-refresh',
			clientId: 'fake',
			clientSecret: 'fake',
			expiresAt: Date.now() - 1000
		};
		const refreshed = await provider.refreshIfNeeded!(creds, async () =>
			Response.json({
				access_token: 'fresh',
				expires_in: 3600,
				refresh_token: 'rotated'
			})
		);
		expect(refreshed.accessToken).toBe('fresh');
		expect(refreshed.expiresAt).toBeGreaterThan(Date.now());
	});
	for (const status of [429, 503]) {
		it(`${provider.id}: refresh ${status} defers an expired token but retains a still-valid one`, async () => {
			const creds = {
				accessToken: 'expired',
				refreshToken: 'valid-refresh',
				clientId: 'fake',
				clientSecret: 'fake',
				expiresAt: Date.now() - 1000
			};
			const fetchImpl: FetchLike = async () => Response.json({}, { status });
			await expect(provider.refreshIfNeeded!(creds, fetchImpl)).rejects.toMatchObject({
				code: 'upstream',
				retryable: true
			});
			const valid = { ...creds, expiresAt: Date.now() + 1000 };
			expect(await provider.refreshIfNeeded!(valid, fetchImpl)).toEqual(valid);
		});
	}
	it(`${provider.id}: refresh network failure is retryable, not authentication failure`, async () => {
		const creds = {
			accessToken: 'expired',
			refreshToken: 'valid-refresh',
			clientId: 'fake',
			clientSecret: 'fake',
			expiresAt: Date.now() - 1000
		};
		const error = await provider.refreshIfNeeded!(creds, async () => {
			throw new TypeError('fetch failed');
		}).catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		expect(isFailureRetryable(error, (error as Error).message)).toBe(true);
	});
}

for (const [label, provider, creds] of [
	['X', xProvider, { accessToken: 'fake', xUserId: 'u1', xUsername: 'tester' }],
	['Mastodon', mastodonProvider, { accessToken: 'fake', instanceUrl: 'https://m.example' }],
	['Threads', threadsProvider, { accessToken: 'fake', threadsUserId: 'u1' }]
] as const) {
	it(`${label}: an idless parent stops automatic and manual thread continuation`, async () => {
		let checkpoint: PublishCheckpoint | undefined;
		let posts = 0;
		const fetchImpl: FetchLike = async (input, init) => {
			const url = String(input);
			if (init?.method === 'POST') {
				posts++;
				if (label === 'Threads' && !url.includes('threads_publish'))
					return Response.json({ id: 'container' });
				return Response.json({});
			}
			return Response.json({ status: 'FINISHED' });
		};
		const content = { text: 'first', thread: [{ text: 'first' }, { text: 'second' }] };
		const error = await provider
			.publish(content, creds, undefined, fetchImpl, {
				checkpoint: async (state) => {
					checkpoint = state;
				}
			})
			.catch((err: unknown) => err);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toMatch(/no id/);
		expect(isFailureRetryable(error, (error as Error).message)).toBe(false);
		expect(checkpoint?.segmentIds).toEqual(['']);
		const before = posts;
		await expect(
			provider.publish(content, creds, undefined, fetchImpl, { resume: checkpoint })
		).rejects.toThrow(/no id/);
		expect(posts).toBe(before);
	});

	it(`${label}: a known parent still resumes as a reply`, async () => {
		const bodies: (Record<string, unknown> | URLSearchParams)[] = [];
		const fetchImpl: FetchLike = async (input, init) => {
			if (init?.method === 'POST') {
				bodies.push(
					label === 'Threads'
						? new URLSearchParams(String(init.body))
						: JSON.parse(String(init.body))
				);
				if (label === 'Threads')
					return Response.json({
						id: String(input).includes('threads_publish') ? 'second' : 'container'
					});
				return Response.json({ data: { id: 'second' }, id: 'second' });
			}
			return Response.json({
				status: 'FINISHED',
				permalink: 'https://www.threads.net/@tester/post/abc'
			});
		};
		await provider.publish(
			{ text: 'first', thread: [{ text: 'first' }, { text: 'second' }] },
			creds,
			undefined,
			fetchImpl,
			{ resume: { segmentIds: ['parent'] } }
		);
		if (label === 'Threads')
			expect((bodies[0] as URLSearchParams).get('reply_to_id')).toBe('parent');
		else if (label === 'X')
			expect(bodies[0]).toHaveProperty('reply.in_reply_to_tweet_id', 'parent');
		else expect(bodies[0]).toHaveProperty('in_reply_to_id', 'parent');
	});

	it(`${label}: an idless completed single post is not sent again`, async () => {
		let calls = 0;
		const result = await provider.publish(
			{ text: 'done' },
			creds,
			undefined,
			async (_input, init) => {
				if (init?.method === 'POST') calls++;
				return Response.json({});
			},
			{ resume: { segmentIds: [''] } }
		);
		expect(calls).toBe(0);
		expect(result.remotePostId).toBeUndefined();
	});
}

async function fixture(
	creds: ConnectionCredentials,
	userStatus: 'active' | 'suspended' | 'pending' | 'unverified' = 'active'
) {
	const test = await createTestDb();
	const now = new Date();
	await test.db.insert(users).values({
		id: 'u',
		email: 'qa@example.test',
		passwordHash: 'fake',
		status: userStatus,
		createdAt: now,
		updatedAt: now
	});
	await test.db.insert(drafts).values({
		id: 'd',
		userId: 'u',
		baseBody: 'hello',
		status: 'scheduled',
		createdAt: now,
		updatedAt: now
	});
	await test.db.insert(connections).values({
		id: 'c',
		userId: 'u',
		platform: 'x',
		handle: 'tester',
		credentialsEncrypted: await encryptJson(creds, TEST_ENV.APP_ENCRYPTION_KEY),
		status: 'active',
		createdAt: now,
		updatedAt: now
	});
	await test.db.insert(publishTargets).values({
		id: 't',
		draftId: 'd',
		connectionId: 'c',
		status: 'scheduled',
		scheduledFor: new Date(now.getTime() - 1000),
		jobId: 'queued',
		createdAt: now,
		updatedAt: now
	});
	return test;
}

it('expired X token plus refresh outage reschedules without a post or expiring the connection', async () => {
	const test = await fixture({
		accessToken: 'expired',
		refreshToken: 'valid-refresh',
		clientId: 'fake-client',
		expiresAt: Date.now() - 1000,
		xUserId: 'u1'
	});
	try {
		const calls: string[] = [];
		const result = await publishTarget(test.db, TEST_ENV, createTestMedia(), 't', {
			fetchImpl: async (input) => {
				calls.push(String(input));
				return Response.json({}, { status: 503 });
			}
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain('oauth2/token');
		expect(result.status).toBe('scheduled');
		expect((await test.db.select().from(connections))[0].status).toBe('active');
		const [target] = await test.db.select().from(publishTargets);
		expect(target.attemptCount).toBe(1);
		expect(target.scheduledFor!.getTime()).toBeGreaterThan(Date.now());
	} finally {
		test.close();
	}
});

for (const status of ['suspended', 'pending', 'unverified'] as const) {
	it(`queued job waits without burning an attempt while owner is ${status}, then publishes on activation`, async () => {
		const test = await fixture({ accessToken: 'valid', xUserId: 'u1' }, status);
		try {
			expect(await claimDueTargets(test.db)).toEqual([]);
			let posts = 0;
			const fetchImpl: FetchLike = async () => {
				posts++;
				return Response.json({ data: { id: 'live-post' } });
			};
			const result = await consumePublishJob(test.db, TEST_ENV, createTestMedia(), 't', fetchImpl);
			expect(posts).toBe(0);
			expect(result.skipped).toBe(true);
			expect((await test.db.select().from(publishTargets))[0]).toMatchObject({
				status: 'scheduled',
				attemptCount: 0
			});
			await test.db.update(users).set({ status: 'active' }).where(eq(users.id, 'u'));
			expect(
				(await consumePublishJob(test.db, TEST_ENV, createTestMedia(), 't', fetchImpl)).status
			).toBe('published');
			expect(posts).toBe(1);
		} finally {
			test.close();
		}
	});
}

it('still-valid X access token can publish during refresh outage', async () => {
	const test = await fixture({
		accessToken: 'valid',
		refreshToken: 'refresh',
		clientId: 'fake',
		expiresAt: Date.now() + 1000,
		xUserId: 'u1'
	});
	try {
		const result = await publishTarget(test.db, TEST_ENV, createTestMedia(), 't', {
			fetchImpl: async (input) =>
				String(input).includes('oauth2/token')
					? Response.json({}, { status: 503 })
					: Response.json({ data: { id: 'live' } })
		});
		expect(result.status).toBe('published');
		expect((await test.db.select().from(connections))[0].status).toBe('active');
	} finally {
		test.close();
	}
});
