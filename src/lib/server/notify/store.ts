import { and, asc, eq } from 'drizzle-orm';
import {
	ALERT_KINDS,
	DEFAULT_DIGEST_MINUTE,
	formatDigestTime,
	parseSubscriptions,
	type NotificationKind,
	type SenderProvider
} from '#lib/domain/notifications.js';
import { decryptSecret, encryptSecret } from '../crypto';
import { first, newId, type AppDb } from '../db/client';
import { notificationAlerts, notificationRecipients, notificationSettings } from '../db/schema';
import type { AppEnv } from '../env';
import type { MailAddress } from './mime';
import type { SmtpConnect } from './smtp';
import { gmailTransport, resendTransport, SendError, type MailTransport } from './transport';

export type NotificationSettingsRow = typeof notificationSettings.$inferSelect;
export type RecipientRow = typeof notificationRecipients.$inferSelect;

export interface Recipient {
	id: string;
	email: string;
	subscriptions: NotificationKind[];
}

export function toRecipient(row: RecipientRow): Recipient {
	return { id: row.id, email: row.email, subscriptions: parseSubscriptions(row.subscriptions) };
}

/**
 * Resend sends from the operator's own account and domain, so only an admin
 * may point their notifications at it: on an instance with members, anybody
 * else could otherwise send mail in the operator's name to any address.
 */
export function resendAvailable(env: AppEnv, role: 'admin' | 'member'): boolean {
	return role === 'admin' && Boolean(env.RESEND_API_KEY && env.NOTIFY_FROM);
}

export async function readSettings(db: AppDb, userId: string) {
	return first(
		db.select().from(notificationSettings).where(eq(notificationSettings.userId, userId))
	);
}

export async function listRecipients(db: AppDb, userId: string): Promise<Recipient[]> {
	const rows = await db
		.select()
		.from(notificationRecipients)
		.where(eq(notificationRecipients.userId, userId))
		.orderBy(asc(notificationRecipients.createdAt), asc(notificationRecipients.email));
	return rows.map(toRecipient);
}

/** What Settings shows. The app password never leaves the server, only whether one is stored. */
export function publicSettings(
	row: NotificationSettingsRow | undefined,
	env: AppEnv,
	role: 'admin' | 'member'
) {
	return {
		enabled: row?.enabled ?? true,
		provider: (row?.provider ?? 'gmail') as SenderProvider,
		senderEmail: row?.senderEmail ?? null,
		hasAppPassword: Boolean(row?.senderSecretEnc),
		smtpPort: row?.smtpPort ?? 465,
		digestTime: formatDigestTime(row?.digestMinute ?? DEFAULT_DIGEST_MINUTE),
		lastTestAt: row?.lastTestAt ?? null,
		lastSentAt: row?.lastSentAt ?? null,
		lastError: row?.lastError ?? null,
		lastErrorAt: row?.lastErrorAt ?? null,
		resendAvailable: resendAvailable(env, role),
		resendFrom: resendAvailable(env, role) ? (env.NOTIFY_FROM ?? null) : null
	};
}

export interface SettingsPatch {
	enabled?: boolean;
	provider?: SenderProvider;
	senderEmail?: string | null;
	appPassword?: string;
	smtpPort?: number;
	digestMinute?: number;
}

export async function saveSettings(
	db: AppDb,
	env: AppEnv,
	userId: string,
	patch: SettingsPatch,
	now = new Date()
): Promise<NotificationSettingsRow> {
	const existing = await readSettings(db, userId);
	const values: Partial<NotificationSettingsRow> = { updatedAt: now };
	if (patch.enabled !== undefined) values.enabled = patch.enabled;
	if (patch.provider !== undefined) values.provider = patch.provider;
	if (patch.smtpPort !== undefined) values.smtpPort = patch.smtpPort;
	if (patch.digestMinute !== undefined) values.digestMinute = patch.digestMinute;
	if (patch.senderEmail !== undefined) {
		values.senderEmail = patch.senderEmail;
		// An app password belongs to one Google account: a new address without a
		// new password must not keep sending with the old account's.
		if (patch.senderEmail !== existing?.senderEmail && patch.appPassword === undefined) {
			values.senderSecretEnc = null;
		}
	}
	if (patch.appPassword !== undefined) {
		values.senderSecretEnc = await encryptSecret(patch.appPassword, env.APP_ENCRYPTION_KEY);
	}
	if (patch.senderEmail !== undefined || patch.appPassword !== undefined || patch.provider) {
		// A stale error would describe a sender that is no longer configured.
		values.lastError = null;
		values.lastErrorAt = null;
	}
	if (existing) {
		await db
			.update(notificationSettings)
			.set(values)
			.where(eq(notificationSettings.userId, userId));
	} else {
		await db
			.insert(notificationSettings)
			.values({ ...values, userId, createdAt: now, updatedAt: now })
			.onConflictDoUpdate({ target: notificationSettings.userId, set: values });
	}
	return (await readSettings(db, userId))!;
}

export async function forgetSender(db: AppDb, userId: string, now = new Date()) {
	await db
		.update(notificationSettings)
		.set({
			senderEmail: null,
			senderSecretEnc: null,
			lastError: null,
			lastErrorAt: null,
			updatedAt: now
		})
		.where(eq(notificationSettings.userId, userId));
}

/**
 * Start each alert kind's cursor at `now` for an account that does not have
 * one: a new subscriber hears about what happens from here on, not about every
 * failure in the account's history.
 */
export async function ensureAlertCursors(db: AppDb, userId: string, now = new Date()) {
	await db
		.insert(notificationAlerts)
		.values(ALERT_KINDS.map((kind) => ({ userId, kind, cursorAt: now, lastSentAt: null })))
		.onConflictDoNothing();
}

export async function addRecipient(
	db: AppDb,
	userId: string,
	email: string,
	subscriptions: NotificationKind[],
	now = new Date()
): Promise<Recipient | null> {
	const id = newId();
	const inserted = await db
		.insert(notificationRecipients)
		.values({
			id,
			userId,
			email,
			subscriptions: JSON.stringify(subscriptions),
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing()
		.returning();
	if (!inserted.length) return null;
	await ensureAlertCursors(db, userId, now);
	return toRecipient(inserted[0]);
}

export async function updateRecipient(
	db: AppDb,
	userId: string,
	id: string,
	subscriptions: NotificationKind[],
	now = new Date()
): Promise<Recipient | null> {
	const rows = await db
		.update(notificationRecipients)
		.set({ subscriptions: JSON.stringify(subscriptions), updatedAt: now })
		.where(and(eq(notificationRecipients.id, id), eq(notificationRecipients.userId, userId)))
		.returning();
	return rows.length ? toRecipient(rows[0]) : null;
}

export async function removeRecipient(db: AppDb, userId: string, id: string): Promise<boolean> {
	const rows = await db
		.delete(notificationRecipients)
		.where(and(eq(notificationRecipients.id, id), eq(notificationRecipients.userId, userId)))
		.returning({ id: notificationRecipients.id });
	return rows.length > 0;
}

export interface SenderDeps {
	connect: SmtpConnect;
	fetchImpl?: typeof fetch;
}

/** The transport and From address an account's settings describe, or a SendError('config'). */
export async function resolveSender(
	env: AppEnv,
	row: NotificationSettingsRow | undefined,
	role: 'admin' | 'member',
	deps: SenderDeps
): Promise<{ transport: MailTransport; from: MailAddress }> {
	const provider = row?.provider ?? 'gmail';
	if (provider === 'resend') {
		if (!resendAvailable(env, role) || !env.RESEND_API_KEY || !env.NOTIFY_FROM) {
			throw new SendError(
				'config',
				'Resend is not available: it needs RESEND_API_KEY and NOTIFY_FROM, and an admin account.'
			);
		}
		return {
			transport: resendTransport({ apiKey: env.RESEND_API_KEY, fetchImpl: deps.fetchImpl }),
			from: { email: env.NOTIFY_FROM }
		};
	}
	if (!row?.senderEmail || !row.senderSecretEnc) {
		throw new SendError('config', 'Add the Gmail address and its app password first.');
	}
	let appPassword: string;
	try {
		appPassword = await decryptSecret(row.senderSecretEnc, env.APP_ENCRYPTION_KEY);
	} catch {
		throw new SendError(
			'config',
			'The stored app password cannot be read (APP_ENCRYPTION_KEY changed?). Enter it again.'
		);
	}
	let clientName = 'localhost';
	try {
		if (env.APP_URL) clientName = new URL(env.APP_URL).hostname || clientName;
	} catch {
		// EHLO only needs a name; Gmail does not check it.
	}
	return {
		transport: gmailTransport({
			connect: deps.connect,
			address: row.senderEmail,
			appPassword,
			port: row.smtpPort,
			clientName
		}),
		from: { email: row.senderEmail, name: env.APP_NAME }
	};
}
