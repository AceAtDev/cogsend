import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionUser } from '#lib/server/auth.js';
import type { AppDb } from '#lib/server/db/client.js';
import { notificationSettings } from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { decryptSecret } from '#lib/server/crypto.js';
import * as settingsRoute from '../src/routes/api/notifications/+server';
import * as recipientsRoute from '../src/routes/api/notifications/recipients/+server';
import * as recipientRoute from '../src/routes/api/notifications/recipients/[id]/+server';
import * as testRoute from '../src/routes/api/notifications/test/+server';
import { useFakeConnect } from './cloudflare-sockets';
import { fakeSmtp, subjectOf } from './fake-smtp';

type Handler = (event: never) => Promise<Response> | Response;

let db: AppDb;
let close: () => void;
let me: SessionUser;
let env = TEST_ENV;

beforeEach(async () => {
	({ db, close } = await createTestDb());
	const row = await createTestAdmin(db, { email: 'me@localhost', totpEnabled: true });
	me = {
		id: row.id,
		email: row.email,
		timezone: 'Europe/Berlin',
		totpEnabled: true,
		mfaVerified: true,
		role: 'admin'
	};
	env = TEST_ENV;
});
afterEach(() => {
	useFakeConnect(null);
	close();
});

async function call(
	handler: Handler,
	opts: { method?: string; body?: unknown; params?: Record<string, string>; bearer?: boolean } = {}
) {
	const url = new URL('https://cogsend.example/api/notifications');
	const request = new Request(url, {
		method: opts.method ?? 'POST',
		headers: { 'content-type': 'application/json' },
		body: opts.body === undefined || opts.method === 'GET' ? undefined : JSON.stringify(opts.body)
	});
	const res = await handler({
		request,
		url,
		params: opts.params ?? {},
		locals: {
			db,
			env,
			user: me,
			authMethod: opts.bearer ? 'bearer' : 'session',
			apiKeyScopes: opts.bearer ? ['read', 'write'] : null
		}
	} as never);
	return { status: res.status, body: await res.json() };
}

async function configure() {
	return call(settingsRoute.PATCH, {
		method: 'PATCH',
		body: {
			senderEmail: 'Notifier@Gmail.com',
			appPassword: 'abcd efgh ijkl mnop',
			digestTime: '07:30'
		}
	});
}

describe('notification settings', () => {
	it('stores the app password encrypted and never returns it', async () => {
		const saved = await configure();
		expect(saved.status).toBe(200);
		expect(saved.body.settings).toMatchObject({
			senderEmail: 'notifier@gmail.com',
			hasAppPassword: true,
			smtpPort: 465,
			digestTime: '07:30',
			provider: 'gmail'
		});
		expect(JSON.stringify(saved.body)).not.toContain('abcdefghijklmnop');
		const row = (
			await db.select().from(notificationSettings).where(eq(notificationSettings.userId, me.id))
		)[0];
		expect(await decryptSecret(row.senderSecretEnc!, env.APP_ENCRYPTION_KEY)).toBe(
			'abcdefghijklmnop'
		);
		const read = await call(settingsRoute.GET, { method: 'GET' });
		expect(read.body.settings.hasAppPassword).toBe(true);
		expect(JSON.stringify(read.body)).not.toMatch(/abcdefghijklmnop|v1:/);
	});

	it('drops the old app password when the address changes without a new one', async () => {
		await configure();
		const changed = await call(settingsRoute.PATCH, {
			method: 'PATCH',
			body: { senderEmail: 'other@gmail.com' }
		});
		expect(changed.body.settings.hasAppPassword).toBe(false);
	});

	it('validates what it is given', async () => {
		for (const body of [
			{ senderEmail: 'not an address' },
			{ senderEmail: 'a@b.com\r\nBcc: x@y.com' },
			{ appPassword: 'short' },
			{ smtpPort: 25 },
			{ digestTime: '25:00' },
			{ provider: 'smtp' },
			{ enabled: 'yes' }
		]) {
			const res = await call(settingsRoute.PATCH, { method: 'PATCH', body });
			expect(res.status, JSON.stringify(body)).toBe(400);
		}
	});

	it('offers Resend only when the instance has it', async () => {
		const refused = await call(settingsRoute.PATCH, {
			method: 'PATCH',
			body: { provider: 'resend' }
		});
		expect(refused.status).toBe(400);
		env = { ...TEST_ENV, RESEND_API_KEY: 're_x', NOTIFY_FROM: 'n@example.com' };
		const accepted = await call(settingsRoute.PATCH, {
			method: 'PATCH',
			body: { provider: 'resend' }
		});
		expect(accepted.body.settings).toMatchObject({ provider: 'resend', resendAvailable: true });
		me = { ...me, role: 'member' };
		const member = await call(settingsRoute.PATCH, {
			method: 'PATCH',
			body: { provider: 'resend' }
		});
		expect(member.status).toBe(400);
	});

	it('forgets the sender on DELETE', async () => {
		await configure();
		const res = await call(settingsRoute.DELETE, { method: 'DELETE' });
		expect(res.body.settings).toMatchObject({ senderEmail: null, hasAppPassword: false });
	});

	it('refuses an API key: the settings hold a mailbox password', async () => {
		for (const [handler, method] of [
			[settingsRoute.GET, 'GET'],
			[settingsRoute.PATCH, 'PATCH'],
			[recipientsRoute.POST, 'POST'],
			[testRoute.POST, 'POST']
		] as const) {
			const res = await call(handler, { method, bearer: true, body: { email: 'x@example.com' } });
			expect(res.status).toBe(401);
		}
	});
});

describe('recipients', () => {
	it('adds, narrows and removes recipients', async () => {
		const added = await call(recipientsRoute.POST, {
			body: { email: 'Team@Example.com', subscriptions: ['failures', 'digest', 'failures'] }
		});
		expect(added.status).toBe(201);
		expect(added.body.recipient).toMatchObject({
			email: 'team@example.com',
			subscriptions: ['digest', 'failures']
		});
		const dup = await call(recipientsRoute.POST, { body: { email: 'team@example.com' } });
		expect(dup.status).toBe(409);
		const all = await call(recipientsRoute.POST, { body: { email: 'all@example.com' } });
		expect(all.body.recipient.subscriptions).toEqual([
			'digest',
			'failures',
			'published',
			'review',
			'connections',
			'paused'
		]);
		const id = added.body.recipient.id;
		const narrowed = await call(recipientRoute.PATCH, {
			method: 'PATCH',
			params: { id },
			body: { subscriptions: ['connections'] }
		});
		expect(narrowed.body.recipient.subscriptions).toEqual(['connections']);
		const bad = await call(recipientRoute.PATCH, {
			method: 'PATCH',
			params: { id },
			body: { subscriptions: ['everything'] }
		});
		expect(bad.status).toBe(400);
		expect((await call(recipientRoute.DELETE, { method: 'DELETE', params: { id } })).status).toBe(
			200
		);
		const list = await call(settingsRoute.GET, { method: 'GET' });
		expect(list.body.recipients.map((r: { email: string }) => r.email)).toEqual([
			'all@example.com'
		]);
	});

	it('caps the list', async () => {
		for (let i = 0; i < 10; i++) {
			expect(
				(await call(recipientsRoute.POST, { body: { email: `r${i}@example.com` } })).status
			).toBe(201);
		}
		expect((await call(recipientsRoute.POST, { body: { email: 'r10@example.com' } })).status).toBe(
			400
		);
	});
});

describe('send test email', () => {
	it('sends to the list through the configured Gmail account', async () => {
		await configure();
		await call(recipientsRoute.POST, { body: { email: 'team@example.com' } });
		const fake = fakeSmtp({ username: 'notifier@gmail.com' });
		useFakeConnect(fake.connect as never);
		const res = await call(testRoute.POST, { body: {} });
		expect(res.status).toBe(200);
		expect(res.body.sentTo).toEqual(['team@example.com']);
		expect(fake.delivered[0]).toMatchObject({
			user: 'notifier@gmail.com',
			from: 'notifier@gmail.com',
			recipients: ['team@example.com']
		});
		expect(subjectOf(fake.delivered[0].data)).toBe('CogSend: test email');
		const again = await call(testRoute.POST, { body: {} });
		expect(again.status).toBe(429);
	});

	it('says exactly what went wrong', async () => {
		await configure();
		const cases = [
			{ server: { username: 'notifier@gmail.com', password: 'something-else' }, kind: 'auth' },
			{ server: { openError: 'Connection refused' }, kind: 'connect' },
			{ server: { openError: 'TLS handshake failed' }, kind: 'tls' }
		];
		for (const c of cases) {
			await db
				.update(notificationSettings)
				.set({ lastTestAt: null })
				.where(eq(notificationSettings.userId, me.id));
			useFakeConnect(fakeSmtp(c.server).connect as never);
			const res = await call(testRoute.POST, { body: { to: 'notifier@gmail.com' } });
			expect(res.status).toBe(502);
			expect(res.body.kind).toBe(c.kind);
			const read = await call(settingsRoute.GET, { method: 'GET' });
			expect(read.body.settings.lastError).toBe(res.body.error);
		}
	});

	it('asks for a sender first, and mails only addresses the account trusts', async () => {
		const none = await call(testRoute.POST, { body: {} });
		expect(none.status).toBe(400);
		expect(none.body.kind).toBe('config');
		await configure();
		const stranger = await call(testRoute.POST, { body: { to: 'stranger@example.com' } });
		expect(stranger.status).toBe(400);
	});
});
