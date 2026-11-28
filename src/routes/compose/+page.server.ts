import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { PageServerLoad } from './$types';
import { addDays, dayKeyOf, rangeBounds, safeTimeZone } from '#lib/domain/calendar.js';
import { overviewDays } from '#lib/domain/compose-overview.js';
import { draftExcerpt } from '#lib/domain/excerpt.js';
import { parseProfileSettings } from '#lib/domain/profile-settings.js';
import { loadCalendar } from '#lib/server/calendar.js';
import type { AppDb } from '#lib/server/db/client.js';
import { batchQueries } from '#lib/server/db/client.js';
import { connections, publishTargets, users } from '#lib/server/db/schema.js';
import { loadOwnedDraft } from '#lib/server/draft-record.js';
import { requireUser } from '#lib/server/require.js';
import { serializeConnection } from '#lib/server/serialize.js';

type ConnectionRow = {
	id: string;
	platform: string;
	displayName: string | null;
	handle: string | null;
	avatarUrl: string | null;
	instanceUrl: string | null;
	status: string;
	metaJson: string;
	createdAt: Date;
};

type SettingsRow = { settingsJson: string | null; displayName: string | null };

const OVERVIEW_DAYS = 7;
const OVERVIEW_DRAFTS = 4;

/** What is coming up, beside the editor: the next week, failures and recent drafts. */
async function loadOverview(db: AppDb, userId: string, zone: string | null | undefined) {
	const timeZone = safeTimeZone(zone);
	const now = new Date();
	const today = dayKeyOf(now.getTime(), timeZone);
	const bounds = rangeBounds({ start: today, end: addDays(today, OVERVIEW_DAYS) }, timeZone);
	const [loaded, failedRows] = await Promise.all([
		loadCalendar(db, userId, {
			...bounds,
			filter: { brands: [], channels: [], cancelled: false },
			now
		}),
		db
			.select({ n: sql<number>`count(distinct ${publishTargets.draftId})` })
			.from(publishTargets)
			.where(
				and(
					inArray(
						publishTargets.connectionId,
						db
							.select({ id: connections.id })
							.from(connections)
							.where(eq(connections.userId, userId))
					),
					eq(publishTargets.status, 'failed')
				)
			)
	]);
	return {
		timeZone,
		today,
		days: overviewDays(loaded.items, loaded.channels, timeZone, today, OVERVIEW_DAYS),
		failed: Number(failedRows[0]?.n ?? 0),
		drafts: loaded.unscheduled.slice(0, OVERVIEW_DRAFTS).map((d) => ({
			id: d.id,
			label: d.title || draftExcerpt(d.body, 60) || 'Empty draft',
			updatedAt: d.updatedAt
		})),
		draftCount: loaded.unscheduled.length,
		moreDrafts: loaded.unscheduledHasMore
	};
}

// Server-render the account list (and an open draft) with the document so the
// editor paints them on first paint instead of waiting for a client round trip.
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const draftId = url.searchParams.get('id');
	// Settle the two reads separately: a failed draft must not cost the account
	// list, and a failed account list must not cost the draft. The editor's
	// client fallback covers whatever is missing, with its own error and retry.
	const [listed, draft] = await Promise.all([
		(
			batchQueries(locals.db, [
				locals.db
					.select({
						id: connections.id,
						platform: connections.platform,
						displayName: connections.displayName,
						handle: connections.handle,
						avatarUrl: connections.avatarUrl,
						instanceUrl: connections.instanceUrl,
						status: connections.status,
						metaJson: connections.metaJson,
						createdAt: connections.createdAt
					})
					.from(connections)
					// Archive tombstones are not selectable destinations.
					.where(and(eq(connections.userId, user.id), ne(connections.status, 'disconnected')))
					.orderBy(desc(connections.createdAt)),
				locals.db
					.select({ settingsJson: users.settingsJson, displayName: users.displayName })
					.from(users)
					.where(eq(users.id, user.id))
			]) as Promise<[ConnectionRow[], SettingsRow[]]>
		).catch((err): [ConnectionRow[], SettingsRow[]] => {
			console.error('[compose] account list failed', err);
			return [[], []];
		}),
		draftId
			? loadOwnedDraft(locals.db, draftId, user.id).catch((err) => {
					console.error('[compose] draft failed', err);
					return null;
				})
			: Promise.resolve(null)
	]);
	const [rows, userRows] = listed;
	return {
		connections: rows.map(serializeConnection),
		settings: parseProfileSettings(userRows[0]?.settingsJson ?? null),
		displayName: userRows[0]?.displayName ?? user.displayName ?? null,
		draft,
		// Streamed: the editor paints first and the rail fills in after it.
		overview: loadOverview(locals.db, user.id, user.timezone).catch((err) => {
			console.error('[compose] overview failed', err);
			return null;
		}),
		canMakeJpegCopies: Boolean((locals.bindings as { IMAGES?: unknown } | undefined)?.IMAGES)
	};
};
