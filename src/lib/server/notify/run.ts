import { and, eq, gt, inArray, isNull, lt, lte, ne, or } from 'drizzle-orm';
import {
	parseSubscriptions,
	type AlertKind,
	type NotificationKind
} from '#lib/domain/notifications.js';
import { operatorZone } from '#lib/domain/zoned-time.js';
import type { SubrequestBudget } from '../budget';
import { batchQueries, newId, parseJson, type AppDb } from '../db/client';
import {
	notificationAlerts,
	notificationRecipients,
	notificationSettings,
	users
} from '../db/schema';
import type { AppEnv } from '../env';
import type { AlertEvent, DigestContext, MailBlock, MailGroup, NotificationHooks } from './events';
import { renderBlocks } from './render';
import type { SmtpConnect } from './smtp';
import { defaultHooks } from './sources';
import {
	readSettings,
	resendAvailable,
	resolveSender,
	type NotificationSettingsRow,
	type SenderDeps
} from './store';
import { workersConnect } from './socket';
import { signEmailMediaUrl } from '../public-media';
import { dayWindow, localMinute } from './time';
import { SendError, type MailTransport } from './transport';
import type { MailAddress } from './mime';

/** At most one alert email per kind per account in this window; what happens
 *  in between goes out together in the next one. */
export const ALERT_WINDOW_MS = 15 * 60_000;
/** A digest whose time passed more than this long ago waits for tomorrow, so
 *  setting 08:00 in the evening does not send one at once. */
export const DIGEST_GRACE_MINUTES = 180;
/** Rows one alert source reads per tick, across accounts. */
const ALERT_COLLECT_LIMIT = 100;
const ALERT_LINES_PER_EMAIL = 25;
/** Each composite cursor uses several parameters; keep the query below D1's 100. */
const ACCOUNTS_PER_QUERY = 15;
/** Claim, send, status, cursor. */
const ALERT_EMAIL_COST = 4;
/**
 * Left untouched for whatever runs after the notifications in the same tick.
 * The tick calls this after publishing, so it only ever spends what the posts
 * did not need; this keeps a margin rather than running the budget to zero.
 */
const NOTIFY_RESERVE = 2;

export interface NotifyDeps {
	now?: Date;
	/** This request's subrequest count; without one, nothing is held back. */
	budget?: SubrequestBudget | null;
	connect?: SmtpConnect;
	fetchImpl?: typeof fetch;
	hooks?: NotificationHooks;
}

export interface NotifyRunResult {
	alerts: number;
	digests: number;
	failed: number;
	/** Set when the pass stopped early: `budget` means the next tick resumes. */
	stopped?: 'budget';
}

type Account = NotificationSettingsRow & {
	role: 'admin' | 'member';
	timezone: string;
	recipients: { email: string; subscriptions: NotificationKind[] }[];
	alerts: Map<string, { cursorAt: Date; cursorId?: string; lastSentAt: Date | null }>;
};

function senderReady(row: NotificationSettingsRow & { role: 'admin' | 'member' }, env: AppEnv) {
	if (row.provider === 'resend') return resendAvailable(env, row.role);
	return Boolean(row.senderEmail && row.senderSecretEnc);
}

function windowOpen(lastSentAt: Date | null, now: Date): boolean {
	if (!lastSentAt) return true;
	const age = now.getTime() - lastSentAt.getTime();
	// A timestamp from the future (a skewed clock) must not hold alerts off.
	return age >= ALERT_WINDOW_MS || age < 0;
}

function subscribers(account: Account, kind: NotificationKind): string[] {
	return account.recipients.filter((r) => r.subscriptions.includes(kind)).map((r) => r.email);
}

function groupEvents(events: AlertEvent[]): MailGroup[] {
	const groups = new Map<string, MailGroup>();
	for (const event of events) {
		const label = event.group ?? '';
		const group = groups.get(label) ?? { label: event.group, lines: [] };
		group.lines.push(event.line);
		groups.set(label, group);
	}
	return [...groups.values()];
}

function appUrlOf(env: AppEnv): string {
	return (env.APP_URL || '').replace(/\/+$/, '');
}

class Runner {
	readonly result: NotifyRunResult = { alerts: 0, digests: 0, failed: 0 };
	private readonly senders = new Map<
		string,
		Promise<{ transport: MailTransport; from: MailAddress }>
	>();

	constructor(
		private readonly db: AppDb,
		private readonly env: AppEnv,
		private readonly now: Date,
		private readonly budget: SubrequestBudget | null,
		private readonly deps: SenderDeps
	) {}

	afford(statements: number): boolean {
		if (!this.budget || this.budget.remaining >= statements + NOTIFY_RESERVE) return true;
		this.result.stopped = 'budget';
		return false;
	}

	private sender(account: Account) {
		let pending = this.senders.get(account.userId);
		if (!pending) {
			pending = resolveSender(this.env, account, account.role, this.deps);
			this.senders.set(account.userId, pending);
		}
		return pending;
	}

	/** Send one email and record the outcome on the account. Never throws. */
	async deliver(
		account: Account,
		to: string[],
		subject: string,
		blocks: MailBlock[],
		intro: string,
		compact = false
	) {
		const appName = this.env.APP_NAME;
		const rendered = renderBlocks({
			intro,
			blocks,
			footer: `Sent by ${appName} to the addresses on this account's notification list.`,
			appUrl: appUrlOf(this.env),
			compact
		});
		try {
			const sender = await this.sender(account);
			// A TCP connection or a Resend request: one subrequest either way.
			this.budget?.count(1);
			await sender.transport.send({
				from: sender.from,
				to: to.map((email) => ({ email })),
				subject: `${appName}: ${subject}`,
				...rendered
			});
			await this.db
				.update(notificationSettings)
				.set({ lastSentAt: this.now, lastError: null, lastErrorAt: null })
				.where(eq(notificationSettings.userId, account.userId));
			return true;
		} catch (err) {
			const message =
				err instanceof SendError
					? err.message
					: `Sending failed: ${err instanceof Error ? err.message : String(err)}`;
			console.error('[notify] send failed', account.userId, message);
			this.result.failed += 1;
			await this.db
				.update(notificationSettings)
				.set({ lastError: message.slice(0, 500), lastErrorAt: this.now })
				.where(eq(notificationSettings.userId, account.userId))
				.catch(() => undefined);
			return false;
		}
	}
}

async function loadAccounts(db: AppDb, env: AppEnv): Promise<Account[]> {
	const rows = await db
		.select({ settings: notificationSettings, role: users.role, timezone: users.timezone })
		.from(notificationSettings)
		// A suspended or waiting account sends nothing, like it publishes nothing.
		.innerJoin(users, and(eq(users.id, notificationSettings.userId), eq(users.status, 'active')))
		.where(eq(notificationSettings.enabled, true));
	return rows
		.map((r) => ({
			...r.settings,
			role: r.role,
			timezone: r.timezone,
			recipients: [],
			alerts: new Map()
		}))
		.filter((a) => senderReady(a, env));
}

async function attachRecipients(db: AppDb, accounts: Account[]) {
	const enabled = db
		.select({ id: notificationSettings.userId })
		.from(notificationSettings)
		.where(eq(notificationSettings.enabled, true));
	const [recipients, alerts] = (await batchQueries(db, [
		db.select().from(notificationRecipients).where(inArray(notificationRecipients.userId, enabled)),
		db.select().from(notificationAlerts).where(inArray(notificationAlerts.userId, enabled))
	])) as [
		(typeof notificationRecipients.$inferSelect)[],
		(typeof notificationAlerts.$inferSelect)[]
	];
	const byId = new Map(accounts.map((a) => [a.userId, a]));
	for (const r of recipients) {
		byId
			.get(r.userId)
			?.recipients.push({ email: r.email, subscriptions: parseSubscriptions(r.subscriptions) });
	}
	for (const s of alerts) {
		byId.get(s.userId)?.alerts.set(s.kind, {
			cursorAt: s.cursorAt,
			cursorId: s.cursorId,
			lastSentAt: s.lastSentAt
		});
	}
}

async function runAlerts(
	runner: Runner,
	db: AppDb,
	env: AppEnv,
	accounts: Account[],
	now: Date,
	hooks: NotificationHooks
) {
	for (const source of hooks.alertSources) {
		const kind: AlertKind = source.kind;
		const due = accounts.filter(
			(a) => subscribers(a, kind).length && windowOpen(a.alerts.get(kind)?.lastSentAt ?? null, now)
		);
		if (!due.length) continue;
		// No cursor yet (subscribed before this kind existed): start it now and
		// report from the next tick on.
		const fresh = due.filter((a) => !a.alerts.has(kind));
		if (fresh.length) {
			if (!runner.afford(1)) return;
			await db
				.insert(notificationAlerts)
				.values(fresh.map((a) => ({ userId: a.userId, kind, cursorAt: now, lastSentAt: null })))
				.onConflictDoNothing();
		}
		const pending = due.filter((a) => a.alerts.has(kind));
		for (let offset = 0; offset < pending.length; offset += ACCOUNTS_PER_QUERY) {
			const asked = pending.slice(offset, offset + ACCOUNTS_PER_QUERY);
			if (!runner.afford(1 + ALERT_EMAIL_COST)) return;
			let events: AlertEvent[];
			try {
				events = await source.collect(db, {
					users: asked.map((a) => ({
						userId: a.userId,
						since: a.alerts.get(kind)!.cursorAt,
						sinceId: a.alerts.get(kind)!.cursorId
					})),
					now,
					appUrl: appUrlOf(env),
					limit: ALERT_COLLECT_LIMIT,
					mediaUrl: async (key) =>
						appUrlOf(env) && env.APP_ENCRYPTION_KEY
							? signEmailMediaUrl(env.APP_ENCRYPTION_KEY, appUrlOf(env), key, now.getTime())
							: null
				});
			} catch (err) {
				// A source whose table or column is not there yet (a feature still
				// rolling out) must not stop the other kinds.
				console.error('[notify] alert source failed', kind, err);
				continue;
			}
			for (const account of asked) {
				const mine = events
					.filter((e) => e.userId === account.userId)
					.sort(
						(x, y) =>
							x.at.getTime() - y.at.getTime() ||
							((x.id ?? '') < (y.id ?? '') ? -1 : (x.id ?? '') > (y.id ?? '') ? 1 : 0)
					);
				if (!mine.length) continue;
				if (!runner.afford(ALERT_EMAIL_COST)) return;
				// Claimed before sending, so two overlapping ticks cannot both email.
				const claimed = await db
					.update(notificationAlerts)
					.set({ lastSentAt: now })
					.where(
						and(
							eq(notificationAlerts.userId, account.userId),
							eq(notificationAlerts.kind, kind),
							or(
								isNull(notificationAlerts.lastSentAt),
								lte(notificationAlerts.lastSentAt, new Date(now.getTime() - ALERT_WINDOW_MS)),
								gt(notificationAlerts.lastSentAt, now)
							)
						)
					)
					.returning({ userId: notificationAlerts.userId });
				if (!claimed.length) continue;
				const shown = mine.slice(0, ALERT_LINES_PER_EMAIL);
				const more = mine.length - shown.length;
				const sent = await runner.deliver(
					account,
					subscribers(account, kind),
					source.subjectFor?.(mine) ?? source.subject(mine.length),
					[
						{
							id: kind,
							heading: source.heading,
							summary:
								[
									source.summarize?.(mine),
									more > 0 ? `The first ${shown.length}; the rest follow in the next email.` : ''
								]
									.filter(Boolean)
									.join(' ') || undefined,
							groups: groupEvents(shown)
						}
					],
					'This just happened on your account:'
				);
				if (!sent) {
					// The claim stays, so a refused connection is retried once a window
					// has passed instead of every tick; the cursor stays too, so the
					// retry still carries these events.
					continue;
				}
				runner.result.alerts += 1;
				const cursor = shown[shown.length - 1].at;
				const cursorId = shown[shown.length - 1].id ?? '';
				await db
					.update(notificationAlerts)
					.set({ cursorAt: cursor, cursorId })
					.where(
						and(
							eq(notificationAlerts.userId, account.userId),
							eq(notificationAlerts.kind, kind),
							or(
								lt(notificationAlerts.cursorAt, cursor),
								and(
									eq(notificationAlerts.cursorAt, cursor),
									lt(notificationAlerts.cursorId, cursorId)
								)
							)
						)
					);
				account.alerts.set(kind, { cursorAt: cursor, cursorId, lastSentAt: now });
			}
		}
	}
}

async function runDigests(
	runner: Runner,
	db: AppDb,
	env: AppEnv,
	accounts: Account[],
	now: Date,
	hooks: NotificationHooks
) {
	for (const account of accounts) {
		const timeZone = operatorZone(account.timezone);
		const today = dayWindow(now, timeZone);
		if (account.lastDigestOn === today.date) continue;
		const minute = localMinute(now, timeZone);
		if (minute < account.digestMinute || minute >= account.digestMinute + DIGEST_GRACE_MINUTES) {
			continue;
		}
		const readers = account.recipients.filter((r) =>
			hooks.digestSections.some((s) => r.subscriptions.includes(s.requires))
		);
		if (!readers.length) continue;
		const sections = hooks.digestSections.filter((s) =>
			readers.some((r) => r.subscriptions.includes(s.requires))
		);
		const sectionCost = sections.reduce((sum, s) => sum + s.cost, 0);
		// Claim, sections, one version (send/status/progress), and lease release.
		if (!runner.afford(1 + sectionCost + 4)) return;
		const claimToken = newId();
		const claimed = await db
			.update(notificationSettings)
			.set({ digestClaimToken: claimToken, digestClaimedAt: now })
			.where(
				and(
					eq(notificationSettings.userId, account.userId),
					or(
						isNull(notificationSettings.lastDigestOn),
						ne(notificationSettings.lastDigestOn, today.date)
					),
					or(
						isNull(notificationSettings.digestClaimedAt),
						lt(notificationSettings.digestClaimedAt, new Date(now.getTime() - ALERT_WINDOW_MS))
					)
				)
			)
			.returning();
		if (!claimed.length) continue;
		const saved = claimed[0];
		const previous = parseJson<unknown>(saved.digestSentTo, []);
		const sentTo = new Set<string>(
			saved.digestProgressOn === today.date && Array.isArray(previous)
				? previous.filter((email): email is string => typeof email === 'string')
				: []
		);
		const ownsClaim = and(
			eq(notificationSettings.userId, account.userId),
			eq(notificationSettings.digestClaimToken, claimToken)
		);
		let complete = false;
		try {
			const ctx: DigestContext = {
				db,
				userId: account.userId,
				timeZone,
				now,
				appUrl: appUrlOf(env),
				today,
				yesterday: dayWindow(now, timeZone, -1),
				mediaUrl: async (key) =>
					env.APP_ENCRYPTION_KEY && appUrlOf(env)
						? signEmailMediaUrl(env.APP_ENCRYPTION_KEY, appUrlOf(env), key, now.getTime())
						: null
			};
			const built: { requires: NotificationKind; block: MailBlock }[] = [];
			let buildFailed = false;
			for (const section of sections) {
				try {
					const block = await section.build(ctx);
					if (block) built.push({ requires: section.requires, block });
				} catch (err) {
					console.error('[notify] digest section failed', section.id, err);
					buildFailed = true;
				}
			}
			// Never record an incomplete version as sent. The finally releases
			// the lease, so a transient section failure can retry next tick.
			if (buildFailed) continue;
			// Recipients with the same subscriptions get the same email, so most
			// accounts send one message to everybody.
			const versions = new Map<string, { to: string[]; blocks: MailBlock[]; full: boolean }>();
			for (const reader of readers) {
				if (sentTo.has(reader.email)) continue;
				const blocks = built
					.filter((b) => reader.subscriptions.includes(b.requires))
					.map((b) => b.block);
				const full = reader.subscriptions.includes('digest');
				// A reminder-only reader hears nothing on a day with nothing to remind.
				if (!full && !blocks.length) continue;
				const key = `${full}:${blocks.map((b) => b.id).join(',')}`;
				const version = versions.get(key) ?? { to: [], blocks, full };
				version.to.push(reader.email);
				versions.set(key, version);
			}
			let sentAny = false;
			let allSent = true;
			for (const version of versions.values()) {
				if (!runner.afford(4)) {
					allSent = false;
					break;
				}
				const ok = await runner.deliver(
					account,
					version.to,
					version.full ? `your day, ${today.label}` : 'reminder',
					version.blocks,
					version.full ? `${today.label} (${timeZone})` : `A reminder for ${today.label}:`,
					version.full
				);
				sentAny ||= ok;
				if (ok) {
					for (const email of version.to) sentTo.add(email);
					await db
						.update(notificationSettings)
						.set({ digestProgressOn: today.date, digestSentTo: JSON.stringify([...sentTo]) })
						.where(ownsClaim);
				} else {
					allSent = false;
				}
			}
			complete = allSent;
			if (sentAny) runner.result.digests += 1;
		} finally {
			await db
				.update(notificationSettings)
				.set({
					digestClaimToken: null,
					digestClaimedAt: null,
					...(complete ? { lastDigestOn: today.date } : {})
				})
				.where(ownsClaim);
		}
	}
}

/**
 * The notification pass of a scheduler tick: alerts first (they are the
 * urgent ones), then any digest whose local time has come. Every step checks
 * the subrequest budget, and whatever does not fit waits for the next tick,
 * still due. An instance where nobody set notifications up spends one
 * statement here.
 */
export async function runNotifications(
	db: AppDb,
	env: AppEnv,
	deps: NotifyDeps = {}
): Promise<NotifyRunResult> {
	const now = deps.now ?? new Date();
	const budget = deps.budget ?? null;
	const hooks = deps.hooks ?? defaultHooks;
	const runner = new Runner(db, env, now, budget, {
		connect: deps.connect ?? workersConnect,
		fetchImpl: deps.fetchImpl
	});
	if (!runner.afford(1)) return runner.result;
	const accounts = await loadAccounts(db, env);
	if (!accounts.length) return runner.result;
	if (!runner.afford(2)) return runner.result;
	await attachRecipients(db, accounts);
	await runAlerts(runner, db, env, accounts, now, hooks);
	if (runner.result.stopped) return runner.result;
	await runDigests(runner, db, env, accounts, now, hooks);
	return runner.result;
}

/** Settings' "Send test email" refuses a second one this soon. */
export const TEST_EMAIL_COOLDOWN_MS = 20_000;

/**
 * Send one test email now, through the account's configured sender, and
 * record the outcome. Throws the SendError so the route can show exactly what
 * went wrong (refused connection, TLS, rejected app password).
 */
export async function sendTestEmail(
	db: AppDb,
	env: AppEnv,
	account: { userId: string; role: 'admin' | 'member' },
	to: string[],
	deps: { connect?: SmtpConnect; fetchImpl?: typeof fetch; now?: Date } = {}
): Promise<void> {
	const now = deps.now ?? new Date();
	const row = await readSettings(db, account.userId);
	try {
		const sender = await resolveSender(env, row, account.role, {
			connect: deps.connect ?? workersConnect,
			fetchImpl: deps.fetchImpl
		});
		const rendered = renderBlocks({
			intro: `This is a test email from ${env.APP_NAME}. If you can read it, notifications will reach this address.`,
			blocks: [],
			footer: `Sent from Settings → Notifications.`,
			appUrl: appUrlOf(env)
		});
		await sender.transport.send({
			from: sender.from,
			to: to.map((email) => ({ email })),
			subject: `${env.APP_NAME}: test email`,
			...rendered
		});
	} catch (err) {
		const message =
			err instanceof SendError
				? err.message
				: `Sending failed: ${err instanceof Error ? err.message : String(err)}`;
		await db
			.update(notificationSettings)
			.set({ lastTestAt: now, lastError: message.slice(0, 500), lastErrorAt: now })
			.where(eq(notificationSettings.userId, account.userId));
		throw err instanceof SendError ? err : new SendError('protocol', message);
	}
	await db
		.update(notificationSettings)
		.set({ lastTestAt: now, lastSentAt: now, lastError: null, lastErrorAt: null })
		.where(eq(notificationSettings.userId, account.userId));
}
