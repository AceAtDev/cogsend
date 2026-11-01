import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { batchQueries } from '#lib/server/db/client.js';
import {
	connections,
	drafts,
	notificationRecipients,
	notificationSettings,
	publishTargets
} from '#lib/server/db/schema.js';
import { requireUser } from '#lib/server/require.js';
import { isFullyVerified } from '#lib/server/auth.js';
import { instanceFacts, publicHomepageEnabled } from '#lib/server/legal.js';
import { schedulerHealth } from '#lib/server/scheduler.js';

export const load: PageServerLoad = async ({ locals }) => {
	// The hook lets a signed-out visitor this far only with PUBLIC_HOMEPAGE on.
	if (!isFullyVerified(locals.user) && publicHomepageEnabled(locals.env)) {
		return { publicHome: await instanceFacts(locals) };
	}
	const user = requireUser(locals.user);
	const ownedConnections = () =>
		locals.db
			.select({ id: connections.id })
			.from(connections)
			.where(eq(connections.userId, user.id));
	const [counts, health] = await Promise.all([
		batchQueries(locals.db, [
			locals.db
				.select({ n: sql<number>`count(*)` })
				.from(drafts)
				.where(and(eq(drafts.userId, user.id), eq(drafts.status, 'draft'))),
			locals.db
				.select({ n: sql<number>`count(*)` })
				.from(publishTargets)
				.where(
					and(
						inArray(publishTargets.connectionId, ownedConnections()),
						inArray(publishTargets.status, ['scheduled', 'pending', 'publishing'])
					)
				),
			locals.db
				// Distinct drafts: the Failed tab renders one card per post, while a
				// post can have several failed destinations.
				.select({ n: sql<number>`count(distinct ${publishTargets.draftId})` })
				.from(publishTargets)
				.where(
					and(
						inArray(publishTargets.connectionId, ownedConnections()),
						inArray(publishTargets.status, ['failed'])
					)
				),
			locals.db
				.select({ n: sql<number>`count(*)` })
				.from(connections)
				.where(and(eq(connections.userId, user.id), eq(connections.status, 'expired'))),
			locals.db
				.select({ n: sql<number>`count(*)` })
				.from(connections)
				.where(
					and(
						eq(connections.userId, user.id),
						eq(connections.status, 'active'),
						sql`json_extract(${connections.metaJson}, '$.reconnectBy') IS NOT NULL`
					)
				),
			locals.db
				.select({
					enabled: notificationSettings.enabled,
					provider: notificationSettings.provider,
					senderEmail: notificationSettings.senderEmail,
					senderSecretEnc: notificationSettings.senderSecretEnc,
					lastError: notificationSettings.lastError,
					lastErrorAt: notificationSettings.lastErrorAt,
					lastSentAt: notificationSettings.lastSentAt
				})
				.from(notificationSettings)
				.where(eq(notificationSettings.userId, user.id)),
			locals.db
				.select({ n: sql<number>`count(*)` })
				.from(notificationRecipients)
				.where(eq(notificationRecipients.userId, user.id))
		]),
		schedulerHealth(locals.db)
	]);
	const [
		draftRows,
		scheduledRows,
		failedRows,
		expiredRows,
		expiringRows,
		notifyRows,
		recipientRows
	] = counts as [
		{ n: number }[],
		{ n: number }[],
		{ n: number }[],
		{ n: number }[],
		{ n: number }[],
		{
			enabled: boolean;
			provider: string;
			senderEmail: string | null;
			senderSecretEnc: string | null;
			lastError: string | null;
			lastErrorAt: Date | null;
			lastSentAt: Date | null;
		}[],
		{ n: number }[]
	];
	const notify = notifyRows[0];
	// Alerts are how CogSend reaches you when something breaks, so the home
	// page says so when they could not reach you: none set up, or failing.
	const notifySender = Boolean(
		notify?.enabled &&
		(notify.provider === 'resend'
			? Boolean(locals.env.RESEND_API_KEY && locals.env.NOTIFY_FROM)
			: Boolean(notify.senderEmail && notify.senderSecretEnc))
	);
	const notifyStatus: 'ok' | 'off' | 'failing' =
		!notifySender || Number(recipientRows[0]?.n ?? 0) === 0
			? 'off'
			: notify?.lastErrorAt &&
				  (!notify.lastSentAt || notify.lastErrorAt.getTime() > notify.lastSentAt.getTime())
				? 'failing'
				: 'ok';
	return {
		publicHome: null,
		user: locals.user,
		displayName: user.displayName ?? null,
		scheduledCount: scheduledRows[0]?.n ?? 0,
		draftCount: draftRows[0]?.n ?? 0,
		failedCount: failedRows[0]?.n ?? 0,
		schedulerOk: health.ok,
		schedulerNeverTicked: health.lastTickAt === null,
		schedulerError: health.error ?? null,
		stuckPublishing: health.stuckPublishing,
		overdue: health.overdue,
		expiredAccounts: Number(expiredRows[0]?.n ?? 0),
		expiringAccounts: Number(expiringRows[0]?.n ?? 0),
		notifyStatus,
		notifyError: notify?.lastError ?? null
	};
};
