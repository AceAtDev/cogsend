import type { AlertKind, NotificationKind } from '#lib/domain/notifications.js';
import type { AppDb } from '../db/client';

/**
 * The extension points of the notification emails. Everything an email says
 * comes from one of two kinds of producer, and a new feature plugs in by adding
 * one to `defaultHooks` (sources.ts) rather than by touching the scheduler:
 *
 * - An `AlertSource` reports events as they happen (a failed post, an expired
 *   account, a review gone overdue). The tick asks each source once for every
 *   account that is due an alert of that kind, then batches what it returns
 *   into at most one email per kind per account per ALERT_WINDOW_MS.
 * - A `DigestSection` contributes one block to the daily digest (today's plan,
 *   yesterday's results, top posts…). Returning null leaves the block out, which
 *   is how a feature that does not exist yet degrades: its section is a stub
 *   that returns null until the feature lands.
 *
 * Both are plain data producers: rendering, recipients, debouncing, the
 * subrequest budget and delivery are the runner's job (run.ts).
 */

/** One line of an email. */
export interface MailLine {
	text: string;
	/** A second, smaller line: an error message, a time, a count. */
	detail?: string;
	href?: string;
	tone?: 'error' | 'muted';
}

export interface MailGroup {
	/** A brand name, an account; omitted for an ungrouped list. */
	label?: string;
	lines: MailLine[];
}

/** One titled part of an email. */
export interface MailBlock {
	id: string;
	heading: string;
	/** One sentence under the heading ("3 published, 1 failed"). */
	summary?: string;
	groups: MailGroup[];
	/** Shown when there is nothing else, so an empty section still says so. */
	empty?: string;
}

/** Something that happened to one account, to be emailed promptly. */
export interface AlertEvent {
	userId: string;
	/** Orders events and moves the account's cursor past them once sent. */
	at: Date;
	line: MailLine;
	/** Groups lines in the email, like a brand name. */
	group?: string;
}

export interface AlertQuery {
	/** Accounts due an alert of this kind, each with the instant it was last told up to. */
	users: { userId: string; since: Date }[];
	now: Date;
	/** `APP_URL` without a trailing slash, or '' when not known yet. */
	appUrl: string;
	/** Across all users; leftovers are reported in the next batch. */
	limit: number;
}

export interface AlertSource {
	kind: AlertKind;
	heading: string;
	subject(count: number): string;
	/**
	 * Events after each user's `since`, oldest first, for all the given users in
	 * one statement: the tick pays one subrequest per source, not per account.
	 */
	collect(db: AppDb, query: AlertQuery): Promise<AlertEvent[]>;
}

export interface DayWindow {
	start: Date;
	end: Date;
	/** YYYY-MM-DD in the account's zone. */
	date: string;
	/** "Saturday 31 October". */
	label: string;
}

export interface DigestContext {
	db: AppDb;
	userId: string;
	timeZone: string;
	now: Date;
	appUrl: string;
	today: DayWindow;
	yesterday: DayWindow;
}

export interface DigestSection {
	id: string;
	/**
	 * The subscription a recipient needs to get this block. Most blocks need
	 * `digest`; the paused-brand reminder needs `paused`, so somebody who only
	 * wants that reminder gets a short email with just it.
	 */
	requires: NotificationKind;
	/** D1 statements `build` may run, checked against the tick's budget first. */
	cost: number;
	build(ctx: DigestContext): Promise<MailBlock | null>;
}

export interface NotificationHooks {
	alertSources: AlertSource[];
	digestSections: DigestSection[];
}
