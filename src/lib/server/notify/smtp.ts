import { bytesToBase64, utf8Bytes } from '#lib/domain/bytes.js';

/**
 * A minimal SMTP submission client over a Workers TCP socket: EHLO, optional
 * STARTTLS, AUTH PLAIN or LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. Enough to
 * hand a message to Gmail (smtp.gmail.com, 465 implicit TLS or 587 STARTTLS)
 * and nothing more: no pipelining, no SMTPUTF8, no DSN.
 *
 * The socket is injected so tests drive the whole conversation against a fake
 * server; production passes `connect` from `cloudflare:sockets`.
 */

/** The part of a `cloudflare:sockets` Socket this client uses. */
export interface SmtpSocket {
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	readonly opened?: Promise<unknown>;
	close(): Promise<void> | void;
	startTls(): SmtpSocket;
}

export type SmtpConnect = (
	address: { hostname: string; port: number },
	options: { secureTransport: 'on' | 'starttls'; allowHalfOpen: boolean }
) => SmtpSocket | Promise<SmtpSocket>;

/**
 * Where it went wrong, which is what the user needs to fix it: `connect` is the
 * network (or Cloudflare refusing the port), `tls` the handshake, `auth` the
 * address or app password, `rejected` a sender or recipient the server would
 * not take, `timeout` a server that went quiet, `protocol` anything else.
 */
export type SmtpFailure = 'connect' | 'tls' | 'timeout' | 'auth' | 'rejected' | 'protocol';

export interface SmtpReply {
	code: number;
	lines: string[];
}

export class SmtpError extends Error {
	constructor(
		readonly kind: SmtpFailure,
		message: string,
		readonly reply?: SmtpReply
	) {
		super(message);
		this.name = 'SmtpError';
	}
}

export interface SmtpSendOptions {
	connect: SmtpConnect;
	host: string;
	port: number;
	/** `tls` = implicit TLS (465); `starttls` upgrades a plain connection (587). */
	security: 'tls' | 'starttls';
	username: string;
	password: string;
	/** Envelope sender. */
	from: string;
	/** Envelope recipients. */
	to: string[];
	/** The RFC 5322 message, any line endings. */
	message: string;
	/** The name given in EHLO. */
	clientName?: string;
	/** Per step, not overall: a slow DATA on a big message must still finish. */
	timeoutMs?: number;
}

const MAX_LINE = 64 * 1024;

/** What the socket module throws outside workerd (under `vite dev`). */
export const NO_SOCKETS =
	'TCP sockets are only available inside the Worker (npm run preview or a deployment), not under vite dev';
const TLS_HINT = /tls|ssl|certificate|handshake/i;

function replyText(reply: SmtpReply): string {
	return reply.lines.join(' ').trim();
}

class ReplyReader {
	private buffer = '';
	private readonly decoder = new TextDecoder();

	constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

	private async line(): Promise<string> {
		for (;;) {
			const end = this.buffer.indexOf('\n');
			if (end >= 0) {
				const line = this.buffer.slice(0, end).replace(/\r$/, '');
				this.buffer = this.buffer.slice(end + 1);
				return line;
			}
			if (this.buffer.length > MAX_LINE) {
				throw new SmtpError('protocol', 'The server sent a line longer than 64 KB');
			}
			const { value, done } = await this.reader.read();
			if (done) throw new SmtpError('connect', 'The server closed the connection');
			this.buffer += this.decoder.decode(value, { stream: true });
		}
	}

	/** One reply, multi-line (`250-…` … `250 …`) folded into its lines. */
	async reply(): Promise<SmtpReply> {
		const lines: string[] = [];
		for (;;) {
			const line = await this.line();
			const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
			if (!m) throw new SmtpError('protocol', `Unexpected reply from the server: ${line}`);
			lines.push(m[3]);
			if (m[2] !== '-') return { code: Number(m[1]), lines };
		}
	}

	release() {
		this.reader.releaseLock();
	}
}

/** Lines that begin with a dot get one more (RFC 5321 §4.5.2), CRLF throughout. */
export function dotStuff(message: string): string {
	const lines = message.replace(/\r\n|\r|\n/g, '\n').split('\n');
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	return lines.map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n') + '\r\n';
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new SmtpError(
						'timeout',
						`The server did not answer within ${Math.round(ms / 1000)}s (${what})`
					)
				),
			ms
		);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

class Conversation {
	private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
	private readonly reader: ReplyReader;

	constructor(
		readonly socket: SmtpSocket,
		private readonly timeoutMs: number
	) {
		this.writer = socket.writable.getWriter();
		this.reader = new ReplyReader(socket.readable.getReader());
	}

	read(what: string): Promise<SmtpReply> {
		return withTimeout(this.reader.reply(), this.timeoutMs, what);
	}

	async write(text: string, what: string): Promise<void> {
		await withTimeout(this.writer.write(utf8Bytes(text)), this.timeoutMs, what);
	}

	/** Send one command and require one of `expect`; `label` keeps secrets out of errors. */
	async command(line: string, expect: number[], label = line): Promise<SmtpReply> {
		await this.write(`${line}\r\n`, label);
		const reply = await this.read(label);
		if (!expect.includes(reply.code)) throw unexpected(label, reply);
		return reply;
	}

	release() {
		this.reader.release();
		this.writer.releaseLock();
	}
}

function unexpected(step: string, reply: SmtpReply): SmtpError {
	const verb = step.split(/[\s:]/)[0].toUpperCase();
	const text = `${reply.code} ${replyText(reply)}`;
	if (verb === 'AUTH' || reply.code === 535 || reply.code === 534) {
		return new SmtpError('auth', `Authentication failed: ${text}`, reply);
	}
	if ((verb === 'MAIL' || verb === 'RCPT') && reply.code >= 500) {
		return new SmtpError('rejected', `${step} was refused: ${text}`, reply);
	}
	return new SmtpError('protocol', `${step} failed: ${text}`, reply);
}

/** EHLO keywords, upper-cased, with their parameters (`AUTH` → `PLAIN LOGIN …`). */
function capabilities(reply: SmtpReply): Map<string, string> {
	const caps = new Map<string, string>();
	for (const line of reply.lines.slice(1)) {
		const [keyword, ...rest] = line.trim().split(/\s+/);
		if (keyword) caps.set(keyword.toUpperCase(), rest.join(' ').toUpperCase());
	}
	return caps;
}

function classifyOpenError(err: unknown, security: 'tls' | 'starttls'): SmtpError {
	if (err instanceof SmtpError) return err;
	const detail = err instanceof Error ? err.message : String(err);
	if (security === 'tls' && TLS_HINT.test(detail)) {
		return new SmtpError('tls', `TLS handshake failed: ${detail}`);
	}
	return new SmtpError('connect', `Could not connect: ${detail}`);
}

function base64(text: string): string {
	return bytesToBase64(utf8Bytes(text));
}

async function authenticate(
	session: Conversation,
	caps: Map<string, string>,
	username: string,
	password: string
) {
	const mechanisms = (caps.get('AUTH') ?? '').split(/\s+/);
	if (mechanisms.includes('PLAIN')) {
		await session.command(
			`AUTH PLAIN ${base64(`\0${username}\0${password}`)}`,
			[235],
			'AUTH PLAIN'
		);
		return;
	}
	if (mechanisms.includes('LOGIN')) {
		await session.command('AUTH LOGIN', [334]);
		await session.command(base64(username), [334], 'AUTH LOGIN username');
		await session.command(base64(password), [235], 'AUTH LOGIN password');
		return;
	}
	throw new SmtpError('protocol', 'The server offers neither AUTH PLAIN nor AUTH LOGIN');
}

export async function sendSmtp(opts: SmtpSendOptions): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? 15_000;
	const clientName = opts.clientName ?? 'localhost';
	let socket: SmtpSocket;
	try {
		socket = await opts.connect(
			{ hostname: opts.host, port: opts.port },
			{ secureTransport: opts.security === 'tls' ? 'on' : 'starttls', allowHalfOpen: false }
		);
	} catch (err) {
		throw classifyOpenError(err, opts.security);
	}
	let current = socket;
	try {
		try {
			if (socket.opened) await withTimeout(socket.opened, timeoutMs, 'connect');
		} catch (err) {
			throw classifyOpenError(err, opts.security);
		}
		let session = new Conversation(socket, timeoutMs);
		let greeting: SmtpReply;
		try {
			greeting = await session.read('greeting');
		} catch (err) {
			// With implicit TLS the handshake runs on the first read, so a failure
			// here is often TLS rather than the network.
			throw classifyOpenError(err, opts.security);
		}
		if (greeting.code !== 220) throw unexpected('greeting', greeting);
		let caps = capabilities(await session.command(`EHLO ${clientName}`, [250]));
		if (opts.security === 'starttls') {
			// Never authenticate in the clear: no STARTTLS means no send.
			if (!caps.has('STARTTLS')) {
				throw new SmtpError('tls', 'The server does not offer STARTTLS on this port');
			}
			await session.command('STARTTLS', [220]);
			session.release();
			try {
				current = socket.startTls();
				session = new Conversation(current, timeoutMs);
				caps = capabilities(await session.command(`EHLO ${clientName}`, [250]));
			} catch (err) {
				if (err instanceof SmtpError && err.kind !== 'connect') throw err;
				const detail = err instanceof Error ? err.message : String(err);
				throw new SmtpError('tls', `TLS upgrade failed: ${detail}`);
			}
		}
		await authenticate(session, caps, opts.username, opts.password);
		await session.command(`MAIL FROM:<${opts.from}>`, [250]);
		for (const rcpt of opts.to) {
			await session.command(`RCPT TO:<${rcpt}>`, [250, 251]);
		}
		await session.command('DATA', [354]);
		await session.write(`${dotStuff(opts.message)}.\r\n`, 'DATA');
		const accepted = await session.read('end of DATA');
		if (accepted.code !== 250) throw unexpected('DATA', accepted);
		// The message is accepted; a QUIT that goes wrong changes nothing.
		await session.command('QUIT', [221]).catch(() => undefined);
	} finally {
		try {
			await current.close();
		} catch {
			// already closed by the server
		}
	}
}
