import { describe, expect, it } from 'vitest';
import { base64ToBytes } from '#lib/domain/bytes.js';
import {
	buildMessage,
	encodeHeaderValue,
	formatAddress,
	rfc5322Date
} from '#lib/server/notify/mime.js';
import {
	dotStuff,
	NO_SOCKETS,
	sendSmtp,
	SmtpError,
	type SmtpSendOptions
} from '#lib/server/notify/smtp.js';
import { gmailTransport, SendError } from '#lib/server/notify/transport.js';
import { fakeSmtp, type FakeSmtpOptions } from './fake-smtp';

const PASSWORD = 'abcdefghijklmnop';

function options(server: ReturnType<typeof fakeSmtp>, over: Partial<SmtpSendOptions> = {}) {
	return {
		connect: server.connect,
		host: 'smtp.gmail.com',
		port: 465,
		security: 'tls' as const,
		username: 'sender@gmail.com',
		password: PASSWORD,
		from: 'sender@gmail.com',
		to: ['a@example.com'],
		message: 'Subject: hi\r\n\r\nhello\r\n',
		clientName: 'cogsend.example',
		timeoutMs: 2000,
		...over
	};
}

async function failure(over: Partial<SmtpSendOptions> = {}, server: FakeSmtpOptions = {}) {
	const fake = fakeSmtp(server);
	const err = await sendSmtp(options(fake, over)).then(
		() => null,
		(e: unknown) => e
	);
	return { err: err as SmtpError, fake };
}

function decodeWords(header: string): string {
	const bytes = header
		.split('\r\n ')
		.flatMap((word) => [...base64ToBytes(word.slice('=?UTF-8?B?'.length, -2))]);
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

describe('SMTP client against a Gmail-like server', () => {
	it('delivers over implicit TLS on 465 with AUTH PLAIN', async () => {
		const fake = fakeSmtp();
		await sendSmtp(options(fake, { to: ['a@example.com', 'b@example.com'] }));
		expect(fake.connects).toEqual([
			{ hostname: 'smtp.gmail.com', port: 465, secureTransport: 'on' }
		]);
		const verbs = fake.commands.map((c) => c.split(' ')[0]);
		expect(verbs).toEqual(['EHLO', 'AUTH', 'MAIL', 'RCPT', 'RCPT', 'DATA', 'QUIT']);
		expect(fake.commands[0]).toBe('EHLO cogsend.example');
		const plain = atob(fake.commands[1].split(' ')[2]);
		expect(plain).toBe(`\0sender@gmail.com\0${PASSWORD}`);
		expect(fake.commands[2]).toBe('MAIL FROM:<sender@gmail.com>');
		expect(fake.recipients).toEqual(['a@example.com', 'b@example.com']);
		expect(fake.data).toBe('Subject: hi\r\n\r\nhello\r\n');
		expect(fake.closed).toBe(1);
	});

	it('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
		const fake = fakeSmtp({ auth: ['LOGIN'] });
		await sendSmtp(options(fake));
		const i = fake.commands.indexOf('AUTH LOGIN');
		expect(i).toBeGreaterThan(0);
		expect(atob(fake.commands[i + 1])).toBe('sender@gmail.com');
		expect(atob(fake.commands[i + 2])).toBe(PASSWORD);
		expect(fake.recipients).toEqual(['a@example.com']);
	});

	it('upgrades with STARTTLS on 587 before it authenticates', async () => {
		const fake = fakeSmtp({ offerStartTls: true });
		await sendSmtp(options(fake, { port: 587, security: 'starttls' }));
		expect(fake.connects[0].secureTransport).toBe('starttls');
		expect(fake.upgraded).toBe(true);
		expect(fake.commands.slice(0, 3)).toEqual([
			'EHLO cogsend.example',
			'STARTTLS',
			'EHLO cogsend.example'
		]);
		expect(fake.authInClear).toBe(false);
		expect(fake.recipients).toEqual(['a@example.com']);
	});

	it('refuses to send credentials when 587 does not offer STARTTLS', async () => {
		const { err, fake } = await failure({ port: 587, security: 'starttls' });
		expect(err).toBeInstanceOf(SmtpError);
		expect(err.kind).toBe('tls');
		expect(fake.commands.some((c) => c.startsWith('AUTH'))).toBe(false);
		expect(fake.authInClear).toBe(false);
	});

	it('dot-stuffs the message and ends it with CRLF.CRLF', async () => {
		const fake = fakeSmtp();
		await sendSmtp(
			options(fake, {
				message: 'Subject: x\n\n.hidden line\n..two dots\nlast line without newline'
			})
		);
		expect(fake.data).toBe(
			'Subject: x\r\n\r\n..hidden line\r\n...two dots\r\nlast line without newline\r\n'
		);
		// The lone '.' terminator was consumed by the server, not left in the data.
		expect(fake.data.split('\r\n')).not.toContain('.');
	});

	it('normalizes every line ending to CRLF', () => {
		expect(dotStuff('a\nb\rc\r\nd')).toBe('a\r\nb\r\nc\r\nd\r\n');
		expect(dotStuff('.\n')).toBe('..\r\n');
	});

	it('reports a rejected app password as an auth failure, keeping Gmail’s reason', async () => {
		const { err } = await failure({ password: 'wrong-password-123' });
		expect(err.kind).toBe('auth');
		expect(err.reply?.code).toBe(535);
		expect(err.message).toContain('5.7.8');
		expect(err.message).not.toContain('wrong-password-123');
	});

	it('stops at a refused recipient', async () => {
		const { err, fake } = await failure(
			{ to: ['ok@example.com', 'gone@example.com'] },
			{ rejectRcpt: ['gone@example.com'] }
		);
		expect(err.kind).toBe('rejected');
		expect(err.message).toContain('gone@example.com');
		expect(fake.commands.some((c) => c === 'DATA')).toBe(false);
	});

	it('tells a refused connection apart from a failed TLS handshake', async () => {
		expect((await failure({}, { connectError: 'proxy request failed' })).err.kind).toBe('connect');
		expect((await failure({}, { openError: 'Connection refused' })).err.kind).toBe('connect');
		expect(
			(await failure({}, { openError: 'TLS handshake failed: bad certificate' })).err.kind
		).toBe('tls');
	});

	it('times out on a server that never answers', async () => {
		const { err } = await failure({ timeoutMs: 50 }, { silent: true });
		expect(err.kind).toBe('timeout');
	});

	it('reports a server that hangs up mid-conversation', async () => {
		const { err } = await failure({}, { hangUpAfterGreeting: true });
		expect(err.kind).toBe('connect');
		expect(err.message).toMatch(/closed the connection/);
	});

	it('treats a refused end of DATA as a failure', async () => {
		const { err } = await failure({}, { dataReply: '552 5.3.4 Message too big' });
		expect(err).toBeInstanceOf(SmtpError);
		expect(err.message).toContain('552');
	});
});

describe('Gmail transport errors', () => {
	async function sendWith(server: FakeSmtpOptions, password = PASSWORD) {
		const fake = fakeSmtp(server);
		const transport = gmailTransport({
			connect: fake.connect,
			address: 'sender@gmail.com',
			appPassword: password,
			port: server.offerStartTls ? 587 : 465,
			timeoutMs: 500
		});
		return transport
			.send({
				from: { email: 'sender@gmail.com', name: 'CogSend' },
				to: [{ email: 'a@example.com' }],
				subject: 'Test',
				text: 'hi',
				html: '<p>hi</p>'
			})
			.then(
				() => ({ err: null, fake }),
				(err: SendError) => ({ err, fake })
			);
	}

	it('says what to fix for each failure', async () => {
		const auth = await sendWith({}, 'nope-nope-nope');
		expect(auth.err).toBeInstanceOf(SendError);
		expect(auth.err?.kind).toBe('auth');
		expect(auth.err?.message).toMatch(/app password/);

		const appPassword = await sendWith(
			{
				authFailure: ['534-5.7.9 Application-specific password required.', '534 5.7.9 x1 - gsmtp']
			},
			'my-google-password'
		);
		expect(appPassword.err?.kind).toBe('auth');
		expect(appPassword.err?.message).toMatch(/not the Google account password/);

		const refused = await sendWith({ openError: 'Connection refused' });
		expect(refused.err?.kind).toBe('connect');
		expect(refused.err?.message).toMatch(/smtp\.gmail\.com:465.*try port 587/);

		const tls = await sendWith({ openError: 'TLS handshake failed' });
		expect(tls.err?.kind).toBe('tls');

		// Under vite dev there is no socket module at all: no port advice for that.
		const dev = await sendWith({ connectError: NO_SOCKETS });
		expect(dev.err?.message).toMatch(/^Cannot send from here: .*npm run preview/);
		expect(dev.err?.message).not.toMatch(/try port/);
	});

	it('sends a MIME message the server receives intact', async () => {
		const ok = await sendWith({});
		expect(ok.err).toBeNull();
		expect(ok.fake.data).toMatch(/^From: "CogSend" <sender@gmail\.com>\r\n/);
		expect(ok.fake.data).toContain('Content-Type: multipart/alternative;');
	});
});

describe('MIME', () => {
	it('leaves a plain ASCII subject alone and encodes anything else as UTF-8 words', () => {
		expect(encodeHeaderValue('3 posts failed')).toBe('3 posts failed');
		const subject = 'Café 🎉 — résumé of your day, with a fairly long tail to force folding ✓';
		const encoded = encodeHeaderValue(subject);
		for (const word of encoded.split('\r\n ')) {
			expect(word.length).toBeLessThanOrEqual(75);
			expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
			// Each word decodes on its own: no character is split across two.
			const bytes = base64ToBytes(word.slice(10, -2));
			expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBeTruthy();
		}
		expect(decodeWords(encoded)).toBe(subject);
	});

	it('cannot be made to start a new header', () => {
		expect(encodeHeaderValue('hi\r\nBcc: victim@example.com')).toBe('hi Bcc: victim@example.com');
		expect(formatAddress({ email: 'a@example.com', name: 'Evil\r\nBcc: x' })).toBe(
			'"Evil Bcc: x" <a@example.com>'
		);
		expect(formatAddress({ email: 'a@example.com', name: 'Zoë' })).toMatch(
			/^=\?UTF-8\?B\?.+\?= <a@example\.com>$/
		);
	});

	it('builds a multipart/alternative message with CRLF lines and both parts', () => {
		const text = 'Line one\nLine two with ünïcode and a very long line '.repeat(10);
		const html = '<p>Hello <b>world</b></p>';
		const raw = buildMessage(
			{
				from: { email: 'sender@gmail.com', name: 'CogSend' },
				to: [{ email: 'a@example.com' }],
				subject: 'Your day',
				text,
				html
			},
			{ now: new Date('2026-10-31T08:00:00Z'), boundary: 'BOUNDARY', messageId: '<id@gmail.com>' }
		);
		expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
		for (const line of raw.split('\r\n')) expect(line.length).toBeLessThanOrEqual(998);
		const [head, ...rest] = raw.split('\r\n\r\n');
		expect(head).toContain('From: "CogSend" <sender@gmail.com>');
		expect(head).toContain('To: <a@example.com>');
		expect(head).toContain('Date: Sat, 31 Oct 2026 08:00:00 +0000');
		expect(head).toContain('Message-ID: <id@gmail.com>');
		expect(head).toContain('Content-Type: multipart/alternative; boundary="BOUNDARY"');
		const body = rest.join('\r\n\r\n');
		const parts = body.split('--BOUNDARY').slice(1, 3);
		const decode = (part: string) =>
			new TextDecoder().decode(base64ToBytes(part.split('\r\n\r\n')[1].replace(/\r\n/g, '')));
		expect(decode(parts[0])).toBe(text.replace(/\n/g, '\r\n'));
		expect(decode(parts[1])).toBe(html);
		expect(body.trimEnd().endsWith('--BOUNDARY--')).toBe(true);
	});

	it('keeps several recipients out of each other’s To header', () => {
		const raw = buildMessage({
			from: { email: 'sender@gmail.com' },
			to: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
			subject: 's',
			text: 't',
			html: 'h'
		});
		expect(raw).toContain('To: <sender@gmail.com>');
		expect(raw).not.toContain('a@example.com');
	});

	it('writes RFC 5322 dates', () => {
		expect(rfc5322Date(new Date('2026-01-05T03:04:05Z'))).toBe('Mon, 05 Jan 2026 03:04:05 +0000');
	});
});
