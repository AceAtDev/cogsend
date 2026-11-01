/**
 * What a notification recipient can subscribe to, and the rules for the
 * values Settings → Notifications sends. Shared by the panel and the server so
 * the two cannot disagree about what a valid address or digest time is.
 */

export const NOTIFICATION_KINDS = [
	'digest',
	'failures',
	'review',
	'connections',
	'paused'
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** The kinds sent as they happen (debounced). The digest is daily, and a
 *  paused brand only ever appears in it as a reminder. */
export const ALERT_KINDS = ['failures', 'review', 'connections'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, { label: string; hint: string }> = {
	digest: { label: 'Daily digest', hint: "Today's plan, yesterday's results, what needs you" },
	failures: { label: 'Failed posts', hint: 'As soon as a post fails to publish' },
	review: { label: 'Review waiting / overdue', hint: 'Agent posts whose time passed unapproved' },
	connections: { label: 'Account needs reconnecting', hint: 'An account expired or lost access' },
	paused: { label: 'Paused brand reminder', hint: 'In the digest, while a brand is paused' }
};

/** A new recipient gets everything; they can be narrowed afterwards. */
export const DEFAULT_SUBSCRIPTIONS: NotificationKind[] = [...NOTIFICATION_KINDS];

export const MAX_RECIPIENTS = 10;
export const DEFAULT_DIGEST_MINUTE = 8 * 60;

export const SMTP_PORTS = [465, 587] as const;
export type SmtpPort = (typeof SMTP_PORTS)[number];

export const SENDER_PROVIDERS = ['gmail', 'resend'] as const;
export type SenderProvider = (typeof SENDER_PROVIDERS)[number];

/**
 * Stricter than the login's identifier rule: these addresses go into SMTP
 * envelopes and mail headers, so anything that could end a header or a command
 * (CR, LF, angle brackets, commas, quotes) is refused, and the domain needs a dot.
 */
const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+\.[^\s@<>()[\],;:"\\]+$/;

export function normalizeAddress(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const email = raw.trim().toLowerCase();
	if (email.length > 254 || !ADDRESS.test(email)) return null;
	return email;
}

export function normalizeSubscriptions(raw: unknown): NotificationKind[] | null {
	if (!Array.isArray(raw)) return null;
	const out = new Set<NotificationKind>();
	for (const value of raw) {
		if (typeof value !== 'string') return null;
		if (!(NOTIFICATION_KINDS as readonly string[]).includes(value)) return null;
		out.add(value as NotificationKind);
	}
	// Stored in the canonical order so equal sets compare equal.
	return NOTIFICATION_KINDS.filter((k) => out.has(k));
}

export function parseSubscriptions(json: string | null | undefined): NotificationKind[] {
	try {
		return normalizeSubscriptions(JSON.parse(json ?? '[]')) ?? [];
	} catch {
		return [];
	}
}

/** `HH:MM` (24h) as minutes after local midnight, or null. */
export function parseDigestTime(raw: unknown): number | null {
	if (typeof raw !== 'string') return null;
	const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
	if (!m) return null;
	const hour = Number(m[1]);
	const minute = Number(m[2]);
	if (hour > 23 || minute > 59) return null;
	return hour * 60 + minute;
}

export function formatDigestTime(minutes: number): string {
	const safe = Number.isInteger(minutes) && minutes >= 0 && minutes < 1440 ? minutes : 0;
	return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

/**
 * Google shows an app password as four groups of four letters. People paste it
 * with the spaces, sometimes with a trailing newline, so whitespace goes; the
 * length check is loose so a format change on Google's side does not lock
 * anybody out.
 */
export function normalizeAppPassword(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const value = raw.replace(/\s+/g, '');
	if (value.length < 8 || value.length > 128) return null;
	return value;
}

export function parseSmtpPort(raw: unknown): SmtpPort | null {
	const n = typeof raw === 'string' ? Number(raw) : raw;
	return (SMTP_PORTS as readonly unknown[]).includes(n) ? (n as SmtpPort) : null;
}
