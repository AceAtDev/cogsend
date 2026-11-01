import { bytesToBase64, randomHex, utf8Bytes } from '#lib/domain/bytes.js';

/**
 * A minimal RFC 5322 / MIME writer for the notification emails: one
 * multipart/alternative message with a plain-text and an HTML part, both
 * base64 so a long line or a non-ASCII character can never break the 998-octet
 * line limit or need 8BITMIME from the server.
 */

export interface MailAddress {
	email: string;
	name?: string;
}

export interface OutgoingMail {
	from: MailAddress;
	to: MailAddress[];
	subject: string;
	text: string;
	html: string;
}

/** Anything that could end a header line is removed rather than escaped. */
function oneLine(value: string): string {
	return value.replace(/[\r\n\0]+/g, ' ').trim();
}

const PLAIN_HEADER = /^[\x20-\x7e]*$/;

/**
 * RFC 2047 encoded words. Each word stays within 75 characters, and a word
 * never splits a UTF-8 sequence: a mail client decodes each word on its own,
 * so a split character would come out as two replacement glyphs.
 */
export function encodeHeaderValue(value: string): string {
	const clean = oneLine(value);
	if (PLAIN_HEADER.test(clean) && !clean.includes('=?')) return clean;
	// 75 - "=?UTF-8?B?" - "?=" = 63 base64 characters, 45 bytes of payload at most.
	const maxBytes = 45;
	const words: string[] = [];
	let chunk: number[] = [];
	for (const char of clean) {
		const bytes = utf8Bytes(char);
		if (chunk.length + bytes.length > maxBytes) {
			words.push(`=?UTF-8?B?${bytesToBase64(Uint8Array.from(chunk))}?=`);
			chunk = [];
		}
		chunk.push(...bytes);
	}
	if (chunk.length) words.push(`=?UTF-8?B?${bytesToBase64(Uint8Array.from(chunk))}?=`);
	// Folded with CRLF + space: whitespace between encoded words is ignored.
	return words.join('\r\n ');
}

export function formatAddress(address: MailAddress): string {
	const email = oneLine(address.email);
	const name = address.name ? oneLine(address.name) : '';
	if (!name) return `<${email}>`;
	if (PLAIN_HEADER.test(name) && !name.includes('=?')) {
		// A quoted string takes any printable ASCII once quotes and backslashes are escaped.
		return `"${name.replace(/(["\\])/g, '\\$1')}" <${email}>`;
	}
	return `${encodeHeaderValue(name)} <${email}>`;
}

function base64Lines(text: string): string {
	const encoded = bytesToBase64(utf8Bytes(text));
	const lines: string[] = [];
	for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76));
	return lines.join('\r\n');
}

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n|\r|\n/g, '\r\n');
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 date-time, always in UTC: the zone is part of the value. */
export function rfc5322Date(at: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${DAYS[at.getUTCDay()]}, ${pad(at.getUTCDate())} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} +0000`;
}

/**
 * The whole message, CRLF line endings, ready for SMTP DATA (which does its own
 * dot-stuffing). With several recipients the `To:` header names the sender
 * itself and the recipients go in the envelope only, like Bcc: they are the
 * account's people, but not necessarily people who know each other.
 */
export function buildMessage(
	mail: OutgoingMail,
	opts: { now?: Date; boundary?: string; messageId?: string } = {}
): string {
	const now = opts.now ?? new Date();
	const boundary = opts.boundary ?? `cogsend-${randomHex(12)}`;
	const domain = mail.from.email.split('@')[1] || 'localhost';
	const messageId = opts.messageId ?? `<${randomHex(16)}@${oneLine(domain)}>`;
	const toHeader =
		mail.to.length === 1 ? formatAddress(mail.to[0]) : formatAddress({ email: mail.from.email });
	const headers = [
		`From: ${formatAddress(mail.from)}`,
		`To: ${toHeader}`,
		`Subject: ${encodeHeaderValue(mail.subject)}`,
		`Date: ${rfc5322Date(now)}`,
		`Message-ID: ${messageId}`,
		'MIME-Version: 1.0',
		// RFC 3834: tells autoresponders (vacation replies) not to answer.
		'Auto-Submitted: auto-generated',
		`Content-Type: multipart/alternative; boundary="${boundary}"`
	];
	const part = (type: string, body: string) =>
		[
			`--${boundary}`,
			`Content-Type: ${type}; charset=UTF-8`,
			'Content-Transfer-Encoding: base64',
			'',
			base64Lines(normalizeNewlines(body))
		].join('\r\n');
	return [
		...headers,
		'',
		part('text/plain', mail.text),
		part('text/html', mail.html),
		`--${boundary}--`,
		''
	].join('\r\n');
}
