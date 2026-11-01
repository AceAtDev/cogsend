import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { SubrequestBudget } from '#lib/server/budget.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	brands,
	connections,
	deliveryMetrics,
	drafts,
	notificationAlerts,
	notificationSettings,
	publishTargets,
	users
} from '#lib/server/db/schema.js';
import { createTestDb, createTestMedia, TEST_ENV, type TestDb } from '#lib/server/db/test.js';
import type { DigestSection, NotificationHooks } from '#lib/server/notify/events.js';
import { ALERT_WINDOW_MS, runNotifications, sendTestEmail } from '#lib/server/notify/run.js';
import { defaultHooks } from '#lib/server/notify/sources.js';
import { addRecipient, saveSettings } from '#lib/server/notify/store.js';
import { SendError } from '#lib/server/notify/transport.js';
import { runSchedulerTick } from '#lib/server/scheduler.js';
import type { NotificationKind } from '#lib/domain/notifications.js';
import { captureConsole } from './console-spy';
import { fakeSmtp, htmlPart, subjectOf, textPart } from './fake-smtp';

const APP_PASSWORD = 'abcd efgh ijkl mnop'.replace(/\s/g, '');
/** 08:00 in Berlin (CET, after the October change). */
const MORNING = new Date('2026-10-31T07:00:00Z');
const env = { ...TEST_ENV, APP_URL: 'https://cogsend.example' };

let t: TestDb;
let db: AppDb;

beforeEach(async () => {
	t = await createTestDb();
	db = t.db;
});
afterEach(() => t.close());

async function account(opts: {
	email: string;
	sender?: string;
	timezone?: string;
	role?: 'admin' | 'member';
	status?: 'active' | 'suspended';
	recipients?: { email: string; subscriptions: NotificationKind[] }[];
	at?: Date;
}) {
	const at = opts.at ?? new Date('2026-10-30T00:00:00Z');
	const id = newId();
	await db.insert(users).values({
		id,
		email: opts.email,
		passwordHash: 'x',
		timezone: opts.timezone ?? 'Europe/Berlin',
		role: opts.role ?? 'admin',
		status: opts.status ?? 'active',
		createdAt: at,
		updatedAt: at
	});
	await saveSettings(
		db,
		env,
		id,
		{ senderEmail: opts.sender ?? 'sender@gmail.com', appPassword: APP_PASSWORD },
		at
	);
	for (const r of opts.recipients ?? [
		{ email: 'team@example.com', subscriptions: ['digest', 'failures', 'connections', 'review'] }
	]) {
		await addRecipient(db, id, r.email, r.subscriptions, at);
	}
	const brandId = newId();
	await db.insert(brands).values({
		id: brandId,
		userId: id,
		name: 'Acme',
		slug: 'acme',
		color: '#000000',
		createdAt: at,
		updatedAt: at
	});
	const connectionId = newId();
	await db.insert(connections).values({
		id: connectionId,
		userId: id,
		platform: 'mastodon',
		handle: 'acme@mastodon.example',
		credentialsEncrypted: 'enc',
		status: 'active',
		brandId,
		createdAt: at,
		updatedAt: at
	});
	return { id, brandId, connectionId };
}

async function delivery(
	owner: { id: string; connectionId: string },
	opts: {
		status: string;
		body: string;
		updatedAt: Date;
		scheduledFor?: Date | null;
		error?: string;
		remoteUrl?: string;
	}
) {
	const draftId = newId();
	await db.insert(drafts).values({
		id: draftId,
		userId: owner.id,
		baseBody: opts.body,
		status: 'scheduled',
		createdAt: opts.updatedAt,
		updatedAt: opts.updatedAt
	});
	const targetId = newId();
	await db.insert(publishTargets).values({
		id: targetId,
		draftId,
		connectionId: owner.connectionId,
		status: opts.status,
		scheduledFor: opts.scheduledFor ?? null,
		errorMessage: opts.error ?? null,
		remotePostId: opts.status === 'published' ? 'remote-1' : null,
		remoteUrl: opts.remoteUrl ?? null,
		createdAt: opts.updatedAt,
		updatedAt: opts.updatedAt
	});
	return targetId;
}

/** A run with no digest due (evening in Berlin), so only alerts go out. */
const EVENING = new Date('2026-10-31T19:00:00Z');

describe('alerts', () => {
	it('emails a failure to the recipients subscribed to failures, and only to them', async () => {
		const alice = await account({
			email: 'alice@localhost',
			recipients: [
				{ email: 'ops@example.com', subscriptions: ['failures'] },
				{ email: 'boss@example.com', subscriptions: ['digest'] }
			]
		});
		await delivery(alice, {
			status: 'failed',
			body: 'Launch post',
			error: 'Token expired',
			updatedAt: new Date(EVENING.getTime() - 60_000)
		});
		const fake = fakeSmtp();
		const result = await runNotifications(db, env, { now: EVENING, connect: fake.connect });
		expect(result).toMatchObject({ alerts: 1, digests: 0, failed: 0 });
		expect(fake.delivered).toHaveLength(1);
		const mail = fake.delivered[0];
		expect(mail.user).toBe('sender@gmail.com');
		expect(mail.recipients).toEqual(['ops@example.com']);
		expect(subjectOf(mail.data)).toBe('CogSend: 1 post failed to publish');
		const text = textPart(mail.data);
		expect(text).toContain('Acme');
		expect(text).toContain('Mastodon acme@mastodon.example: “Launch post”');
		expect(text).toContain('https://cogsend.example/posts?tab=failed');
		expect(htmlPart(mail.data)).toContain('<a href="https://cogsend.example/posts?tab=failed"');
	});

	it('batches what happens inside the window into the next email', async () => {
		const alice = await account({ email: 'alice@localhost' });
		const fake = fakeSmtp();
		await delivery(alice, { status: 'failed', body: 'first', updatedAt: EVENING });
		const t1 = new Date(EVENING.getTime() + 60_000);
		expect((await runNotifications(db, env, { now: t1, connect: fake.connect })).alerts).toBe(1);

		await delivery(alice, { status: 'failed', body: 'second', updatedAt: t1 });
		await delivery(alice, {
			status: 'failed',
			body: 'third',
			updatedAt: new Date(t1.getTime() + 1000)
		});
		const t2 = new Date(t1.getTime() + 5 * 60_000);
		expect((await runNotifications(db, env, { now: t2, connect: fake.connect })).alerts).toBe(0);
		expect(fake.delivered).toHaveLength(1);

		const t3 = new Date(t1.getTime() + ALERT_WINDOW_MS);
		expect((await runNotifications(db, env, { now: t3, connect: fake.connect })).alerts).toBe(1);
		expect(fake.delivered).toHaveLength(2);
		const text = textPart(fake.delivered[1].data);
		expect(subjectOf(fake.delivered[1].data)).toBe('CogSend: 2 posts failed to publish');
		expect(text).toContain('“second”');
		expect(text).toContain('“third”');
		expect(text).not.toContain('“first”');
	});

	it('does not report what happened before the recipient subscribed', async () => {
		const alice = await account({ email: 'alice@localhost', at: EVENING });
		await delivery(alice, {
			status: 'failed',
			body: 'old news',
			updatedAt: new Date(EVENING.getTime() - 3_600_000)
		});
		const fake = fakeSmtp();
		const result = await runNotifications(db, env, {
			now: new Date(EVENING.getTime() + 60_000),
			connect: fake.connect
		});
		expect(result.alerts).toBe(0);
		expect(fake.delivered).toHaveLength(0);
	});

	it('keeps the events of a failed send and retries them after the window', async () => {
		const alice = await account({ email: 'alice@localhost' });
		await delivery(alice, { status: 'failed', body: 'retry me', updatedAt: EVENING });
		const refused = fakeSmtp({ openError: 'Connection refused' });
		const later = new Date(EVENING.getTime() + 60_000);
		const out = captureConsole('error');
		const result = await runNotifications(db, env, { now: later, connect: refused.connect });
		expect(out).toHaveBeenCalled();
		expect(result).toMatchObject({ alerts: 0, failed: 1 });
		const row = (
			await db.select().from(notificationSettings).where(eq(notificationSettings.userId, alice.id))
		)[0];
		expect(row.lastError).toMatch(/Could not connect to smtp\.gmail\.com:465/);

		const fake = fakeSmtp();
		// Inside the window: not hammered every tick.
		await runNotifications(db, env, {
			now: new Date(later.getTime() + 60_000),
			connect: fake.connect
		});
		expect(fake.delivered).toHaveLength(0);
		await runNotifications(db, env, {
			now: new Date(later.getTime() + ALERT_WINDOW_MS),
			connect: fake.connect
		});
		expect(fake.delivered).toHaveLength(1);
		expect(textPart(fake.delivered[0].data)).toContain('“retry me”');
		const cleared = (
			await db.select().from(notificationSettings).where(eq(notificationSettings.userId, alice.id))
		)[0];
		expect(cleared.lastError).toBeNull();
	});

	it('alerts on an account that needs reconnecting', async () => {
		const alice = await account({ email: 'alice@localhost' });
		await db
			.update(connections)
			.set({ status: 'expired', updatedAt: EVENING })
			.where(eq(connections.id, alice.connectionId));
		const fake = fakeSmtp();
		await runNotifications(db, env, {
			now: new Date(EVENING.getTime() + 1000),
			connect: fake.connect
		});
		expect(fake.delivered).toHaveLength(1);
		expect(subjectOf(fake.delivered[0].data)).toBe('CogSend: 1 account needs reconnecting');
		expect(textPart(fake.delivered[0].data)).toContain('https://cogsend.example/accounts');
	});

	it('alerts on a review that went overdue, once posts can wait for review', async () => {
		const alice = await account({ email: 'alice@localhost' });
		const fake = fakeSmtp();
		// Nothing writes a review status yet: the source finds nothing.
		await runNotifications(db, env, { now: EVENING, connect: fake.connect });
		expect(fake.delivered).toHaveLength(0);
		await delivery(alice, {
			status: 'awaiting_review',
			body: 'agent draft',
			updatedAt: EVENING,
			scheduledFor: new Date(EVENING.getTime() + 30_000)
		});
		await runNotifications(db, env, {
			now: new Date(EVENING.getTime() + 60_000),
			connect: fake.connect
		});
		expect(fake.delivered).toHaveLength(1);
		expect(subjectOf(fake.delivered[0].data)).toBe('CogSend: 1 post passed its time unapproved');
	});

	it('keeps each account’s alerts to its own sender and recipients', async () => {
		const alice = await account({
			email: 'alice@localhost',
			sender: 'alice.bot@gmail.com',
			recipients: [{ email: 'alice-team@example.com', subscriptions: ['failures'] }]
		});
		const bob = await account({
			email: 'bob@localhost',
			sender: 'bob.bot@gmail.com',
			role: 'member',
			recipients: [{ email: 'bob-team@example.com', subscriptions: ['failures'] }]
		});
		await delivery(alice, { status: 'failed', body: 'alice failure', updatedAt: EVENING });
		const fake = fakeSmtp({ acceptAny: true });
		await runNotifications(db, env, {
			now: new Date(EVENING.getTime() + 1000),
			connect: fake.connect
		});
		expect(fake.delivered).toHaveLength(1);
		expect(fake.delivered[0]).toMatchObject({
			user: 'alice.bot@gmail.com',
			recipients: ['alice-team@example.com']
		});

		await delivery(bob, { status: 'failed', body: 'bob failure', updatedAt: EVENING });
		await runNotifications(db, env, {
			now: new Date(EVENING.getTime() + 2000),
			connect: fake.connect
		});
		expect(fake.delivered).toHaveLength(2);
		expect(fake.delivered[1]).toMatchObject({
			user: 'bob.bot@gmail.com',
			recipients: ['bob-team@example.com']
		});
		expect(textPart(fake.delivered[1].data)).not.toContain('alice failure');
	});

	it('sends nothing for a suspended account or one that turned notifications off', async () => {
		const alice = await account({ email: 'alice@localhost', status: 'suspended' });
		const bob = await account({ email: 'bob@localhost' });
		await saveSettings(db, env, bob.id, { enabled: false });
		await delivery(alice, { status: 'failed', body: 'a', updatedAt: EVENING });
		await delivery(bob, { status: 'failed', body: 'b', updatedAt: EVENING });
		const fake = fakeSmtp({ acceptAny: true });
		await runNotifications(db, env, {
			now: new Date(EVENING.getTime() + 1000),
			connect: fake.connect
		});
		expect(fake.delivered).toHaveLength(0);
	});
});

describe('daily digest', () => {
	async function seedDay() {
		const alice = await account({
			email: 'alice@localhost',
			recipients: [
				{ email: 'boss@example.com', subscriptions: ['digest'] },
				{ email: 'ops@example.com', subscriptions: ['failures'] },
				{ email: 'pause-watcher@example.com', subscriptions: ['paused'] }
			]
		});
		// Today in Berlin: one at 09:30 under the brand, one at 23:30 local.
		await delivery(alice, {
			status: 'scheduled',
			body: 'Morning post',
			updatedAt: new Date('2026-10-30T10:00:00Z'),
			scheduledFor: new Date('2026-10-31T08:30:00Z')
		});
		await delivery(alice, {
			status: 'scheduled',
			body: 'Late post',
			updatedAt: new Date('2026-10-30T10:00:00Z'),
			scheduledFor: new Date('2026-10-31T22:30:00Z')
		});
		// Tomorrow in Berlin (00:30 local): not today.
		await delivery(alice, {
			status: 'scheduled',
			body: 'Tomorrow post',
			updatedAt: new Date('2026-10-30T10:00:00Z'),
			scheduledFor: new Date('2026-10-31T23:30:00Z')
		});
		// Yesterday in Berlin.
		await delivery(alice, {
			status: 'published',
			body: 'Went out fine',
			updatedAt: new Date('2026-10-30T12:00:00Z'),
			remoteUrl: 'https://mastodon.example/@acme/1'
		});
		await delivery(alice, {
			status: 'failed',
			body: 'Broke',
			error: 'Rate limited',
			updatedAt: new Date('2026-10-30T13:00:00Z')
		});
		return alice;
	}

	it('sends today’s plan, yesterday’s results and what needs action at the local time', async () => {
		await seedDay();
		const fake = fakeSmtp();
		const early = await runNotifications(db, env, {
			now: new Date(MORNING.getTime() - 60_000),
			connect: fake.connect
		});
		expect(early.digests).toBe(0);

		const result = await runNotifications(db, env, { now: MORNING, connect: fake.connect });
		expect(result.digests).toBe(1);
		const digest = fake.delivered.find((d) => d.recipients.includes('boss@example.com'));
		expect(digest).toBeDefined();
		// Only the digest subscriber; the reminder-only reader had nothing to be reminded of.
		expect(fake.delivered.flatMap((d) => d.recipients)).not.toContain('pause-watcher@example.com');
		expect(digest!.recipients).toEqual(['boss@example.com']);
		expect(subjectOf(digest!.data)).toBe('CogSend: your day, Saturday 31 October');
		const text = textPart(digest!.data);
		expect(text).toContain('PLANNED TODAY, SATURDAY 31 OCTOBER');
		expect(text).toContain('2 posts across 1 brand.');
		expect(text).toContain('09:30 · Mastodon acme@mastodon.example: “Morning post”');
		expect(text).toContain('23:30 · Mastodon acme@mastodon.example: “Late post”');
		expect(text).not.toContain('Tomorrow post');
		expect(text).toContain('YESTERDAY, FRIDAY 30 OCTOBER');
		expect(text).toContain('1 published, 1 failed.');
		expect(text).toContain('https://mastodon.example/@acme/1');
		expect(text).toContain('NEEDS YOUR ATTENTION');
		expect(text).toContain('1 post failed and needs a retry or a new time');
		// Nothing measured and nothing paused: those blocks are simply absent.
		expect(text).not.toMatch(/best posts|paused/i);

		const again = await runNotifications(db, env, {
			now: new Date(MORNING.getTime() + 10 * 60_000),
			connect: fake.connect
		});
		expect(again.digests).toBe(0);
	});

	it('waits for tomorrow when the time passed long ago', async () => {
		await seedDay();
		const fake = fakeSmtp();
		const result = await runNotifications(db, env, {
			now: new Date('2026-10-31T15:00:00Z'),
			connect: fake.connect
		});
		expect(result.digests).toBe(0);
		expect(fake.delivered.filter((d) => d.recipients.includes('boss@example.com'))).toHaveLength(0);
	});

	it('follows the account’s chosen time and zone', async () => {
		const alice = await seedDay();
		await saveSettings(db, env, alice.id, { digestMinute: 18 * 60 + 15 });
		await db.update(users).set({ timezone: 'America/New_York' }).where(eq(users.id, alice.id));
		const fake = fakeSmtp();
		const digests = () => fake.delivered.filter((d) => d.recipients.includes('boss@example.com'));
		// 18:15 in New York on 31 October (EDT, UTC-4) is 22:15 UTC.
		await runNotifications(db, env, {
			now: new Date('2026-10-31T22:14:00Z'),
			connect: fake.connect
		});
		expect(digests()).toHaveLength(0);
		await runNotifications(db, env, {
			now: new Date('2026-10-31T22:15:00Z'),
			connect: fake.connect
		});
		expect(digests()).toHaveLength(1);
		expect(textPart(digests()[0].data)).toContain('(America/New_York)');
	});

	it('takes extra sections from the hooks and leaves out one that fails', async () => {
		await seedDay();
		const extra: DigestSection = {
			id: 'extra',
			requires: 'digest',
			cost: 1,
			async build() {
				return {
					id: 'extra',
					heading: 'Campaign notes',
					groups: [{ lines: [{ text: 'Went out fine — 42 likes' }] }]
				};
			}
		};
		const broken: DigestSection = {
			id: 'broken',
			requires: 'digest',
			cost: 1,
			async build() {
				throw new Error('no such column: metrics.likes');
			}
		};
		const reminder: DigestSection = {
			id: 'extra-reminder',
			requires: 'paused',
			cost: 0,
			async build() {
				return {
					id: 'extra-reminder',
					heading: 'Seasonal pause',
					groups: [{ lines: [{ text: 'Acme' }] }]
				};
			}
		};
		const hooks: NotificationHooks = {
			alertSources: defaultHooks.alertSources,
			digestSections: [...defaultHooks.digestSections, extra, broken, reminder]
		};
		const fake = fakeSmtp();
		const out = captureConsole('error');
		await runNotifications(db, env, { now: MORNING, connect: fake.connect, hooks });
		expect(out).toHaveBeenCalled();
		const digest = fake.delivered.find((d) => d.recipients.includes('boss@example.com'))!;
		expect(textPart(digest.data)).toContain('CAMPAIGN NOTES');
		expect(textPart(digest.data)).toContain('42 likes');
		expect(textPart(digest.data)).not.toContain('SEASONAL PAUSE');
		const sent = fake.delivered.find((d) => d.recipients.includes('pause-watcher@example.com'))!;
		expect(subjectOf(sent.data)).toBe('CogSend: reminder');
		expect(textPart(sent.data)).toContain('SEASONAL PAUSE');
		expect(textPart(sent.data)).not.toContain('PLANNED TODAY');
	});

	it('lists the week’s best posts and the paused brands from their own data', async () => {
		const alice = await seedDay();
		const published = new Date('2026-10-28T10:00:00Z');
		const loud = await delivery(alice, {
			status: 'published',
			body: 'Loud post',
			updatedAt: published,
			remoteUrl: 'https://mastodon.example/@acme/2'
		});
		const quiet = await delivery(alice, {
			status: 'published',
			body: 'Quiet post',
			updatedAt: published
		});
		for (const [targetId, likes] of [
			[loud, 40],
			[quiet, 2]
		] as const) {
			await db.insert(deliveryMetrics).values({
				targetId,
				userId: alice.id,
				platform: 'mastodon',
				publishedAt: published,
				state: 'ok',
				stage: 2,
				likes,
				comments: 3,
				shares: 1,
				collectedAt: new Date('2026-10-29T10:00:00Z'),
				updatedAt: new Date('2026-10-29T10:00:00Z')
			});
		}
		await db
			.update(brands)
			.set({ pausedAt: new Date('2026-10-29T09:00:00Z') })
			.where(eq(brands.id, alice.brandId));

		const fake = fakeSmtp();
		await runNotifications(db, env, { now: MORNING, connect: fake.connect });
		const digest = textPart(
			fake.delivered.find((d) => d.recipients.includes('boss@example.com'))!.data
		);
		expect(digest).toContain('BEST POSTS THIS WEEK');
		expect(digest.indexOf('Loud post')).toBeLessThan(digest.indexOf('Quiet post'));
		expect(digest).toContain('40 ');
		expect(digest).toContain('https://mastodon.example/@acme/2');
		// The pause is a reminder subscription, not part of the plain digest.
		expect(digest).not.toContain('PAUSED BRANDS');

		const reminder = textPart(
			fake.delivered.find((d) => d.recipients.includes('pause-watcher@example.com'))!.data
		);
		expect(reminder).toContain('PAUSED BRANDS');
		expect(reminder).toContain('Acme, paused since 2026-10-29');
		expect(reminder).not.toContain('BEST POSTS');
	});
});

describe('subrequest budget', () => {
	it('costs one statement on an instance where nobody set notifications up', async () => {
		t.reset();
		const before = t.count();
		await runNotifications(db, env, { now: EVENING, connect: fakeSmtp().connect });
		expect(t.count() - before).toBe(1);
	});

	it('stops when the tick has no calls to spare, and resumes on the next one', async () => {
		const alice = await account({ email: 'alice@localhost' });
		await delivery(alice, { status: 'failed', body: 'later', updatedAt: EVENING });
		const fake = fakeSmtp();
		const tight = new SubrequestBudget(50);
		tight.count(46);
		const now = new Date(EVENING.getTime() + 1000);
		const result = await runNotifications(db, env, { now, connect: fake.connect, budget: tight });
		expect(result.stopped).toBe('budget');
		expect(fake.delivered).toHaveLength(0);
		const state = await db
			.select()
			.from(notificationAlerts)
			.where(and(eq(notificationAlerts.userId, alice.id), eq(notificationAlerts.kind, 'failures')));
		expect(state[0].lastSentAt).toBeNull();

		await runNotifications(db, env, {
			now,
			connect: fake.connect,
			budget: new SubrequestBudget(50)
		});
		expect(fake.delivered).toHaveLength(1);
	});

	it('runs inside the scheduler tick after publishing', async () => {
		const alice = await account({ email: 'alice@localhost' });
		await delivery(alice, { status: 'failed', body: 'from the tick', updatedAt: new Date() });
		await db
			.update(notificationAlerts)
			.set({ cursorAt: new Date(Date.now() - 3_600_000) })
			.where(eq(notificationAlerts.userId, alice.id));
		const fake = fakeSmtp();
		const result = await runSchedulerTick(db, env, {
			store: createTestMedia(),
			connect: fake.connect,
			budget: new SubrequestBudget(50)
		});
		expect(result.notifications.alerts).toBe(1);
		expect(textPart(fake.delivered[0].data)).toContain('from the tick');
	});
});

describe('senders', () => {
	it('sends through the instance’s Resend for an admin who chose it', async () => {
		const alice = await account({ email: 'alice@localhost' });
		const resendEnv = { ...env, RESEND_API_KEY: 're_test', NOTIFY_FROM: 'CogSend <n@example.com>' };
		await saveSettings(db, resendEnv, alice.id, { provider: 'resend' });
		await delivery(alice, { status: 'failed', body: 'via resend', updatedAt: EVENING });
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
			return new Response('{}', { status: 200 });
		}) as typeof fetch;
		const fake = fakeSmtp();
		await runNotifications(db, resendEnv, {
			now: new Date(EVENING.getTime() + 1000),
			connect: fake.connect,
			fetchImpl
		});
		expect(fake.delivered).toHaveLength(0);
		expect(calls).toHaveLength(1);
		expect(calls[0].body).toMatchObject({
			from: 'CogSend <n@example.com>',
			to: ['team@example.com'],
			subject: 'CogSend: 1 post failed to publish'
		});
	});

	it('never lets a member send through the operator’s Resend', async () => {
		const bob = await account({ email: 'bob@localhost', role: 'member' });
		const resendEnv = { ...env, RESEND_API_KEY: 're_test', NOTIFY_FROM: 'n@example.com' };
		await saveSettings(db, resendEnv, bob.id, { provider: 'resend' });
		await delivery(bob, { status: 'failed', body: 'x', updatedAt: EVENING });
		let called = 0;
		const fetchImpl = (async () => {
			called += 1;
			return new Response('{}');
		}) as unknown as typeof fetch;
		await runNotifications(db, resendEnv, {
			now: new Date(EVENING.getTime() + 1000),
			connect: fakeSmtp().connect,
			fetchImpl
		});
		expect(called).toBe(0);
	});

	it('sends a test email and records a precise failure', async () => {
		const alice = await account({ email: 'alice@localhost' });
		const fake = fakeSmtp();
		await sendTestEmail(db, env, { userId: alice.id, role: 'admin' }, ['me@example.com'], {
			connect: fake.connect
		});
		expect(fake.delivered[0].recipients).toEqual(['me@example.com']);
		expect(subjectOf(fake.delivered[0].data)).toBe('CogSend: test email');

		await saveSettings(db, env, alice.id, { appPassword: 'wrongwrongwrong1' });
		const err = await sendTestEmail(
			db,
			env,
			{ userId: alice.id, role: 'admin' },
			['me@example.com'],
			{ connect: fakeSmtp().connect }
		).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(SendError);
		expect((err as SendError).kind).toBe('auth');
		const row = (
			await db.select().from(notificationSettings).where(eq(notificationSettings.userId, alice.id))
		)[0];
		expect(row.lastError).toMatch(/did not accept the address and app password/);
		expect(row.lastError).not.toContain('wrongwrongwrong1');
	});

	it('stores the app password encrypted', async () => {
		const alice = await account({ email: 'alice@localhost' });
		const row = (
			await db.select().from(notificationSettings).where(eq(notificationSettings.userId, alice.id))
		)[0];
		expect(row.senderSecretEnc).toMatch(/^v1:/);
		expect(row.senderSecretEnc).not.toContain(APP_PASSWORD);
	});
});
