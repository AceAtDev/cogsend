import type { SmtpConnect, SmtpSocket } from '#lib/server/notify/smtp.js';

/**
 * A scripted SMTP server behind a fake `cloudflare:sockets` socket. It speaks
 * enough of Gmail's dialect (multi-line EHLO, STARTTLS on 587, AUTH PLAIN and
 * LOGIN, 535/534 refusals) to drive the client through every branch, and keeps
 * a transcript of what the client sent.
 */
export interface FakeSmtpOptions {
	username?: string;
	password?: string;
	/** AUTH mechanisms offered once the connection is secure. */
	auth?: string[];
	/** Reply to a wrong password: Gmail's 535 by default. */
	authFailure?: string[];
	rejectRcpt?: string[];
	/** Never answer anything (timeouts). */
	silent?: boolean;
	/** Throw from connect() itself. */
	connectError?: string;
	/** Reject `opened` with this message. */
	openError?: string;
	/** Offer STARTTLS on the plain connection (587). */
	offerStartTls?: boolean;
	/** Close the connection right after the greeting. */
	hangUpAfterGreeting?: boolean;
	/** Reply to the end of DATA. */
	dataReply?: string;
	/** Accept any username and password (several accounts sending through one fake). */
	acceptAny?: boolean;
}

/** One delivered message: who authenticated, the envelope, the DATA. */
export interface FakeDelivery {
	user: string;
	from: string;
	recipients: string[];
	data: string;
}

export interface FakeSmtp {
	connect: SmtpConnect;
	/** Every line the client sent, AUTH payloads included, in order. */
	commands: string[];
	/** The raw DATA section as it came over the wire (dot-stuffed, CRLF). */
	data: string;
	recipients: string[];
	connects: { hostname: string; port: number; secureTransport: string }[];
	upgraded: boolean;
	closed: number;
	/** Whether a password ever crossed before TLS. */
	authInClear: boolean;
	/** Messages the server accepted, one per finished DATA. */
	delivered: FakeDelivery[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function fakeSmtp(opts: FakeSmtpOptions = {}): FakeSmtp {
	const username = opts.username ?? 'sender@gmail.com';
	const password = opts.password ?? 'abcdefghijklmnop';
	const state: FakeSmtp = {
		connect: null as unknown as SmtpConnect,
		commands: [],
		data: '',
		recipients: [],
		connects: [],
		upgraded: false,
		closed: 0,
		authInClear: false,
		delivered: []
	};
	let current: FakeDelivery = { user: '', from: '', recipients: [], data: '' };
	let secure = false;
	let mode: 'command' | 'data' | 'login-user' | 'login-pass' = 'command';
	let loginUser = '';

	function ehloLines(): string[] {
		const caps = ['smtp.gmail.com at your service, [203.0.113.7]', 'SIZE 35882577', '8BITMIME'];
		if (!secure && opts.offerStartTls) caps.push('STARTTLS');
		if (secure) caps.push(`AUTH ${(opts.auth ?? ['LOGIN', 'PLAIN', 'XOAUTH2']).join(' ')}`);
		caps.push('ENHANCEDSTATUSCODES', 'PIPELINING', 'SMTPUTF8');
		return caps.map((c, i) => `250${i === caps.length - 1 ? ' ' : '-'}${c}`);
	}

	function authFailed(): string[] {
		return (
			opts.authFailure ?? [
				'535-5.7.8 Username and Password not accepted. For more information, go to',
				'535 5.7.8  https://support.google.com/mail/?p=BadCredentials x1-20020a05'
			]
		);
	}

	function check(user: string, pass: string): string[] {
		if (!secure) state.authInClear = true;
		current.user = user;
		if (opts.acceptAny) return ['235 2.7.0 Accepted'];
		return user === username && pass === password ? ['235 2.7.0 Accepted'] : authFailed();
	}

	function handle(line: string): string[] {
		if (mode === 'data') {
			if (line === '.') {
				mode = 'command';
				state.delivered.push({ ...current, recipients: [...current.recipients] });
				current = { user: current.user, from: '', recipients: [], data: '' };
				return [opts.dataReply ?? '250 2.0.0 OK  1793498089 x1-20020a05.1 - gsmtp'];
			}
			state.data += `${line}\r\n`;
			current.data += `${line}\r\n`;
			return [];
		}
		state.commands.push(line);
		if (mode === 'login-user') {
			loginUser = atob(line);
			mode = 'login-pass';
			return ['334 UGFzc3dvcmQ6'];
		}
		if (mode === 'login-pass') {
			mode = 'command';
			return check(loginUser, atob(line));
		}
		const verb = line.split(/[\s:]/)[0].toUpperCase();
		switch (verb) {
			case 'EHLO':
				return ehloLines();
			case 'STARTTLS':
				return ['220 2.0.0 Ready to start TLS'];
			case 'AUTH': {
				const [, mech, payload] = line.split(' ');
				if (mech === 'PLAIN') {
					const [, user, pass] = atob(payload).split('\0');
					return check(user, pass);
				}
				if (mech === 'LOGIN') {
					mode = 'login-user';
					return ['334 VXNlcm5hbWU6'];
				}
				return ['504 5.7.4 Unrecognized authentication type'];
			}
			case 'MAIL':
				current.from = /<([^>]*)>/.exec(line)?.[1] ?? '';
				return ['250 2.1.0 OK'];
			case 'RCPT': {
				const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
				if (opts.rejectRcpt?.includes(address)) {
					return [
						'550-5.1.1 The email account that you tried to reach does not exist.',
						'550 5.1.1 x1 - gsmtp'
					];
				}
				state.recipients.push(address);
				current.recipients.push(address);
				return ['250 2.1.5 OK'];
			}
			case 'DATA':
				mode = 'data';
				return ['354 Go ahead'];
			case 'QUIT':
				return ['221 2.0.0 closing connection'];
			default:
				return ['502 5.5.1 Unrecognized command'];
		}
	}

	function socket(): SmtpSocket {
		let push: (text: string) => void = () => {};
		let end: () => void = () => {};
		const readable = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (text) => {
					try {
						controller.enqueue(encoder.encode(text));
					} catch {
						// the server hung up; the client finds out on its next read
					}
				};
				end = () => {
					try {
						controller.close();
					} catch {
						// already closed
					}
				};
			}
		});
		let buffer = '';
		const writable = new WritableStream<Uint8Array>({
			write(chunk) {
				buffer += decoder.decode(chunk);
				let idx: number;
				while ((idx = buffer.indexOf('\r\n')) >= 0) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 2);
					if (opts.silent) continue;
					const reply = handle(line);
					if (reply.length) push(reply.join('\r\n') + '\r\n');
				}
			}
		});
		return {
			readable,
			writable,
			opened: opts.openError ? Promise.reject(new Error(opts.openError)) : Promise.resolve({}),
			close() {
				state.closed += 1;
				end();
			},
			startTls() {
				secure = true;
				state.upgraded = true;
				return socket();
			},
			// Exposed for the greeting below.
			...{ _push: (t: string) => push(t), _end: () => end() }
		} as SmtpSocket & { _push: (t: string) => void; _end: () => void };
	}

	state.connect = (address, options) => {
		state.connects.push({ ...address, secureTransport: options.secureTransport });
		if (opts.connectError) throw new Error(opts.connectError);
		secure = options.secureTransport === 'on';
		mode = 'command';
		current = { user: '', from: '', recipients: [], data: '' };
		const s = socket() as SmtpSocket & { _push: (t: string) => void; _end: () => void };
		if (!opts.silent && !opts.openError) {
			s._push('220 smtp.gmail.com ESMTP x1-20020a05 - gsmtp\r\n');
			if (opts.hangUpAfterGreeting) s._end();
		}
		return s;
	};
	return state;
}

/** The text/plain part of a delivered message, decoded. */
export function textPart(data: string): string {
	return mimePart(data, 'text/plain');
}

export function htmlPart(data: string): string {
	return mimePart(data, 'text/html');
}

function mimePart(data: string, type: string): string {
	const boundary = /boundary="([^"]+)"/.exec(data)?.[1];
	if (!boundary) return '';
	const part = data.split(`--${boundary}`).find((p) => p.includes(`Content-Type: ${type}`));
	if (!part) return '';
	const b64 = part.split('\r\n\r\n')[1]?.replace(/\r\n/g, '') ?? '';
	const bin = atob(b64);
	return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** The decoded Subject header of a delivered message. */
export function subjectOf(data: string): string {
	const m = /^Subject: (.*(?:\r\n .*)*)/m.exec(data);
	if (!m) return '';
	const value = m[1];
	if (!value.startsWith('=?UTF-8?B?')) return value;
	const bytes = value
		.split('\r\n ')
		.flatMap((w) => [...Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0))]);
	return new TextDecoder().decode(Uint8Array.from(bytes));
}
