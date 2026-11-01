/**
 * Collecting performance metrics of published deliveries.
 *
 * The scheduler tick calls collectDueMetrics after everything that publishes,
 * so it only ever spends subrequests the posts did not need: on Workers Free a
 * tick has 50 in all, and every D1 statement and platform call is one. A read
 * is grouped per account (Bluesky takes 25 posts per call, TikTok 20), its
 * results are written in a few multi-row statements at the end, and a platform
 * that answers 429 is left alone for the time it asked for, across ticks.
 */
import {
	and,
	asc,
	desc,
	eq,
	inArray,
	isNotNull,
	lte,
	notInArray,
	sql,
	type SQL
} from 'drizzle-orm';
import { isLocalAppUrl } from '#lib/domain/app-url.js';
import {
	MANUAL_REFRESH_MIN_MS,
	metricsSupport,
	metricStateText,
	nextAfterFailure,
	planAfterRead,
	retryDelayMs,
	SNAPSHOT_OFFSETS_MS,
	SNAPSHOT_WINDOW_MS,
	type MetricCounts,
	type MetricState,
	type SnapshotKind
} from '#lib/domain/metrics.js';
import { isZernioConnection } from '#lib/domain/zernio.js';
import { chunkIds, first, newId, parseJson, type AppDb } from './db/client';
import {
	connections,
	deliveryMetrics,
	deliveryMetricSnapshots,
	drafts,
	publishTargets
} from './db/schema';
import { countingFetch, type SubrequestBudget } from './budget';
import { decryptJson, encryptJson } from './crypto';
import type { AppEnv } from './env';
import { readAppSetting, writeAppSetting } from './app-settings';
import { providerFor } from './providers';
import { providerFetch } from './providers/timed-fetch';
import {
	MetricsError,
	type ConnectionCredentials,
	type ConnectionMeta,
	type FetchLike,
	type MetricsOutcome
} from './providers/types';
import { refreshWithStoredRetry } from './publish';

/** Platforms CogSend reads metrics from; the rest are shown "not collected yet". */
export const COLLECTED_PLATFORMS = ['bluesky', 'mastodon', 'tiktok', 'linkedin'] as const;
/** Platforms whose metrics read needs the account's token (and so a refresh first). */
const TOKEN_REFRESH_PLATFORMS = new Set(['tiktok', 'linkedin']);

/** Deliveries looked at per tick at most. */
export const METRICS_PER_TICK = 25;
/** Newly published deliveries enrolled per tick. */
export const METRICS_DISCOVER_LIMIT = 50;
/** Calls left untouched for whatever runs after metrics (none today; a margin). */
const METRICS_RESERVE_CALLS = 2;
/** Below this many calls left the tick does not start on metrics at all. */
export const METRICS_MIN_CALLS = 8;
export const METRICS_BACKOFF_SETTING = 'metrics_backoff';

const SNAPSHOT_COLUMNS = 12;
const METRIC_ROW_COLUMNS = 18;
// D1 refuses a statement with more than 100 bound parameters.
const SNAPSHOTS_PER_STATEMENT = Math.floor(100 / SNAPSHOT_COLUMNS);
const METRIC_ROWS_PER_STATEMENT = Math.floor(100 / METRIC_ROW_COLUMNS);

type MetricRowInsert = typeof deliveryMetrics.$inferInsert;
type SnapshotInsert = typeof deliveryMetricSnapshots.$inferInsert;

/** What the tick (or a refresh) read, to be written in a few statements. */
class PendingWrites {
	rows: MetricRowInsert[] = [];
	snapshots: SnapshotInsert[] = [];

	/** Statements a flush would take with `extra` more deliveries read. */
	cost(extra = 0): number {
		const rows = this.rows.length + extra;
		const snaps = this.snapshots.length + extra;
		return Math.ceil(rows / METRIC_ROWS_PER_STATEMENT) + Math.ceil(snaps / SNAPSHOTS_PER_STATEMENT);
	}
}

/**
 * Per-platform pause after a 429, keyed by what the limit applies to: the
 * public Bluesky AppView limits by IP (so every account shares it), a Mastodon
 * server limits on its own, and TikTok and LinkedIn limit per app.
 */
export type Backoff = Record<string, number>;

export function rateKeyOf(platform: string, instanceUrl: string | null | undefined): string {
	if (platform === 'mastodon') return `mastodon:${(instanceUrl ?? '').toLowerCase()}`;
	return platform;
}

async function readBackoff(db: AppDb, now: number): Promise<Backoff> {
	const raw = parseJson<Backoff>(await readAppSetting(db, METRICS_BACKOFF_SETTING), {});
	const live: Backoff = {};
	for (const [key, until] of Object.entries(raw)) {
		if (typeof until === 'number' && until > now) live[key] = until;
	}
	return live;
}

/** Where the last enrolment scan reached, in `app_settings` (epoch ms). */
export const METRICS_ENROLL_SETTING = 'metrics_enrolled_at';
/** Rows that turned published shortly before the mark are scanned again. */
const ENROLL_OVERLAP_MS = 60 * 60_000;
/** The mark is moved at most this often: one write, not one per tick. */
const ENROLL_MARK_EVERY_MS = 10 * 60_000;

/**
 * Enrol deliveries published in the snapshot window that have no metrics row
 * yet. One statement whatever the count, so it costs the tick one call.
 * `updated_at` is when the row turned published: a published delivery is
 * locked, and nothing writes to it afterwards.
 *
 * This runs every tick, so it scans only from a stored mark (minus an
 * overlap), not the whole nine-day window: a whole-window scan reads every
 * recent delivery 1,440 times a day, and at a few dozen posts a day that
 * alone would use up D1's daily free read allowance.
 */
export async function enrollPublished(db: AppDb, now = Date.now()) {
	const floor = now - SNAPSHOT_WINDOW_MS;
	const mark = Number(await readAppSetting(db, METRICS_ENROLL_SETTING));
	// A mark from the future (a skewed clock, a restored database) is ignored.
	const markOk = Number.isFinite(mark) && mark > 0 && mark <= now;
	const since = markOk ? Math.max(floor, mark - ENROLL_OVERLAP_MS) : floor;
	const platforms = sql.join(
		COLLECTED_PLATFORMS.map((p) => sql`${p}`),
		sql`, `
	);
	const res = (await db.run(sql`INSERT OR IGNORE INTO delivery_metrics
		(target_id, user_id, platform, published_at, stage, next_due_at, state, failures, updated_at)
		SELECT pt.id, d.user_id, c.platform, pt.updated_at, 0, pt.updated_at + ${SNAPSHOT_OFFSETS_MS[0]}, 'pending', 0, ${now}
		FROM publish_targets pt
		INNER JOIN drafts d ON d.id = pt.draft_id
		INNER JOIN connections c ON c.id = pt.connection_id
		WHERE pt.status = 'published'
			AND pt.remote_post_id IS NOT NULL
			AND pt.updated_at >= ${since}
			AND c.platform IN (${platforms})
			AND NOT EXISTS (SELECT 1 FROM delivery_metrics m WHERE m.target_id = pt.id)
		LIMIT ${METRICS_DISCOVER_LIMIT}`)) as { meta?: { changes?: number }; rowsAffected?: number };
	const enrolled = Number(res?.meta?.changes ?? res?.rowsAffected ?? 0);
	// A full batch may have left rows behind: keep the mark so the next tick
	// scans the same range again.
	if (enrolled >= METRICS_DISCOVER_LIMIT) return;
	if (!markOk || now - mark >= ENROLL_MARK_EVERY_MS) {
		await writeAppSetting(db, METRICS_ENROLL_SETTING, String(now));
	}
}

type WorkRow = {
	targetId: string;
	userId: string;
	platform: string;
	publishedAt: Date;
	stage: number;
	failures: number;
	remotePostId: string | null;
	connectionId: string;
	connStatus: string;
	credentialsEncrypted: string;
	metaJson: string;
	instanceUrl: string | null;
};

const workColumns = {
	targetId: deliveryMetrics.targetId,
	userId: deliveryMetrics.userId,
	platform: deliveryMetrics.platform,
	publishedAt: deliveryMetrics.publishedAt,
	stage: deliveryMetrics.stage,
	failures: deliveryMetrics.failures,
	remotePostId: publishTargets.remotePostId,
	connectionId: connections.id,
	connStatus: connections.status,
	credentialsEncrypted: connections.credentialsEncrypted,
	metaJson: connections.metaJson,
	instanceUrl: connections.instanceUrl
};

async function dueRows(
	db: AppDb,
	now: number,
	backoff: Backoff,
	limit: number
): Promise<WorkRow[]> {
	const filters: Array<SQL | undefined> = [
		isNotNull(deliveryMetrics.nextDueAt),
		lte(deliveryMetrics.nextDueAt, new Date(now))
	];
	const pausedPlatforms = Object.keys(backoff).filter((k) => !k.startsWith('mastodon:'));
	const pausedHosts = Object.keys(backoff)
		.filter((k) => k.startsWith('mastodon:'))
		.map((k) => k.slice('mastodon:'.length));
	// Left out in the query rather than skipped afterwards: rows that wait would
	// otherwise fill every tick's LIMIT and starve the platforms that answer.
	if (pausedPlatforms.length) filters.push(notInArray(deliveryMetrics.platform, pausedPlatforms));
	if (pausedHosts.length)
		filters.push(
			sql`not (${connections.platform} = 'mastodon' and lower(coalesce(${connections.instanceUrl}, '')) in (${sql.join(
				pausedHosts.map((h) => sql`${h}`),
				sql`, `
			)}))`
		);
	return db
		.select(workColumns)
		.from(deliveryMetrics)
		.innerJoin(publishTargets, eq(publishTargets.id, deliveryMetrics.targetId))
		.innerJoin(connections, eq(connections.id, publishTargets.connectionId))
		.where(and(...filters))
		.orderBy(asc(deliveryMetrics.nextDueAt))
		.limit(limit);
}

function baseRow(row: WorkRow, now: number): MetricRowInsert {
	return {
		targetId: row.targetId,
		userId: row.userId,
		platform: row.platform,
		publishedAt: row.publishedAt,
		stage: row.stage,
		nextDueAt: null,
		state: 'pending',
		stateDetail: null,
		failures: row.failures,
		likes: null,
		comments: null,
		shares: null,
		quotes: null,
		views: null,
		impressions: null,
		clicks: null,
		collectedAt: null,
		updatedAt: new Date(now)
	};
}

function recordSuccess(writes: PendingWrites, row: WorkRow, counts: MetricCounts, now: number) {
	const plan = planAfterRead(row.publishedAt.getTime(), row.stage, now);
	const values = {
		likes: counts.likes ?? null,
		comments: counts.comments ?? null,
		shares: counts.shares ?? null,
		quotes: counts.quotes ?? null,
		views: counts.views ?? null,
		impressions: counts.impressions ?? null,
		clicks: counts.clicks ?? null
	};
	writes.rows.push({
		...baseRow(row, now),
		...values,
		stage: plan.stage,
		nextDueAt: plan.nextDueAt === null ? null : new Date(plan.nextDueAt),
		state: 'ok',
		failures: 0,
		collectedAt: new Date(now)
	});
	writes.snapshots.push({
		id: newId(),
		targetId: row.targetId,
		userId: row.userId,
		kind: plan.kind satisfies SnapshotKind,
		collectedAt: new Date(now),
		...values
	});
}

function recordFailure(
	writes: PendingWrites,
	row: WorkRow,
	state: MetricState,
	detail: string | null,
	now: number,
	retryAfterMs?: number
) {
	const failures = state === 'error' || state === 'rate_limited' ? row.failures + 1 : row.failures;
	const next = nextAfterFailure({
		state,
		publishedAt: row.publishedAt.getTime(),
		failures: row.failures,
		now,
		retryAfterMs
	});
	writes.rows.push({
		...baseRow(row, now),
		state,
		stateDetail: detail ? detail.slice(0, 300) : null,
		failures,
		nextDueAt: next === null ? null : new Date(next)
	});
}

/** Counts are kept across a failed read: an older number beats none. */
const keep = (column: string) =>
	sql.raw(`coalesce(excluded.${column}, delivery_metrics.${column})`);

export async function flushWrites(db: AppDb, writes: PendingWrites) {
	for (let i = 0; i < writes.snapshots.length; i += SNAPSHOTS_PER_STATEMENT) {
		await db
			.insert(deliveryMetricSnapshots)
			.values(writes.snapshots.slice(i, i + SNAPSHOTS_PER_STATEMENT));
	}
	for (let i = 0; i < writes.rows.length; i += METRIC_ROWS_PER_STATEMENT) {
		await db
			.insert(deliveryMetrics)
			.values(writes.rows.slice(i, i + METRIC_ROWS_PER_STATEMENT))
			.onConflictDoUpdate({
				target: deliveryMetrics.targetId,
				set: {
					stage: sql.raw('excluded.stage'),
					nextDueAt: sql.raw('excluded.next_due_at'),
					state: sql.raw('excluded.state'),
					stateDetail: sql.raw('excluded.state_detail'),
					failures: sql.raw('excluded.failures'),
					likes: keep('likes'),
					comments: keep('comments'),
					shares: keep('shares'),
					quotes: keep('quotes'),
					views: keep('views'),
					impressions: keep('impressions'),
					clicks: keep('clicks'),
					collectedAt: keep('collected_at'),
					updatedAt: sql.raw('excluded.updated_at')
				}
			});
	}
	writes.rows = [];
	writes.snapshots = [];
}

function stateOfError(err: unknown): { state: MetricState; detail: string; retryAfterMs?: number } {
	if (err instanceof MetricsError) {
		const state: MetricState =
			err.kind === 'reconnect'
				? 'reconnect'
				: err.kind === 'rate_limited'
					? 'rate_limited'
					: err.kind === 'unsupported'
						? 'unsupported'
						: 'error';
		return { state, detail: err.message, retryAfterMs: err.retryAfterMs };
	}
	const message = err instanceof Error ? err.message : String(err);
	const status = (err as { status?: unknown })?.status;
	const code = (err as { code?: unknown })?.code;
	// A refresh refused by the platform: the sign-in itself is gone.
	if (status === 401 || code === 'auth') return { state: 'reconnect', detail: message };
	return { state: 'error', detail: message };
}

/** Calls one account's read takes before its results are written. */
function readCalls(platform: string, n: number, batch: number, refresh: boolean): number {
	const reads = platform === 'mastodon' ? n : Math.ceil(n / Math.max(1, batch));
	// A refresh is a token call and the write that stores the new token.
	return reads + (refresh ? 2 : 0);
}

type CollectOptions = {
	fetchImpl?: FetchLike;
	budget?: SubrequestBudget | null;
	now?: number;
};

/**
 * Read one account's deliveries. Returns the rate key to pause when the
 * platform answered 429, so the rest of the tick leaves it alone.
 */
async function collectGroup(
	db: AppDb,
	env: AppEnv,
	rows: WorkRow[],
	writes: PendingWrites,
	fetchImpl: FetchLike,
	now: number
): Promise<{ pause?: { key: string; until: number } }> {
	const conn = rows[0];
	const meta = parseJson<ConnectionMeta>(conn.metaJson, {});
	if (conn.connStatus === 'disconnected') {
		for (const row of rows)
			recordFailure(writes, row, 'unsupported', 'The account was disconnected.', now);
		return {};
	}
	const support = metricsSupport({
		platform: conn.platform,
		zernio: isZernioConnection(conn.metaJson),
		linkedinOrganization: Boolean(meta.organizationUrn)
	});
	if (!support.supported) {
		for (const row of rows) recordFailure(writes, row, support.state, support.reason, now);
		return {};
	}
	const provider = providerFor(conn);
	if (!provider.fetchMetrics) {
		for (const row of rows) recordFailure(writes, row, 'unsupported', null, now);
		return {};
	}
	try {
		let creds = await decryptJson<ConnectionCredentials>(
			conn.credentialsEncrypted,
			env.APP_ENCRYPTION_KEY
		);
		if (TOKEN_REFRESH_PLATFORMS.has(conn.platform) && provider.refreshIfNeeded) {
			const refreshed = await refreshWithStoredRetry(
				db,
				env,
				conn.connectionId,
				conn.credentialsEncrypted,
				creds,
				(c) => provider.refreshIfNeeded!(c, fetchImpl)
			);
			if (JSON.stringify(refreshed) !== JSON.stringify(creds)) {
				// Only over what was read: a publish that refreshed meanwhile wins.
				await db
					.update(connections)
					.set({
						credentialsEncrypted: await encryptJson(refreshed, env.APP_ENCRYPTION_KEY),
						updatedAt: new Date(now)
					})
					.where(
						and(
							eq(connections.id, conn.connectionId),
							eq(connections.credentialsEncrypted, conn.credentialsEncrypted)
						)
					);
			}
			creds = refreshed;
		}
		const batch = provider.metricsBatchSize ?? 1;
		const readable = rows.filter((r) => r.remotePostId);
		for (const row of rows) {
			if (!row.remotePostId)
				recordFailure(writes, row, 'unavailable', 'The platform returned no post id.', now);
		}
		for (let i = 0; i < readable.length; i += batch) {
			const slice = readable.slice(i, i + batch);
			const results: Map<string, MetricsOutcome> = await provider.fetchMetrics(
				slice.map((r) => r.remotePostId!),
				creds,
				meta,
				fetchImpl,
				{ instanceUrl: conn.instanceUrl, allowLocalHosts: isLocalAppUrl(env.APP_URL) }
			);
			for (const row of slice) {
				const outcome = results.get(row.remotePostId!);
				if (!outcome)
					recordFailure(writes, row, 'error', 'The platform did not answer for this post.', now);
				else if (outcome.kind === 'ok') recordSuccess(writes, row, outcome.counts, now);
				else if (outcome.kind === 'not_found') recordFailure(writes, row, 'not_found', null, now);
				else recordFailure(writes, row, 'unavailable', outcome.reason, now);
			}
		}
		return {};
	} catch (err) {
		const { state, detail, retryAfterMs } = stateOfError(err);
		const done = new Set(writes.rows.map((r) => r.targetId));
		for (const row of rows) {
			if (!done.has(row.targetId)) recordFailure(writes, row, state, detail, now, retryAfterMs);
		}
		if (state === 'rate_limited') {
			const wait = retryDelayMs(Math.max(...rows.map((r) => r.failures)), retryAfterMs);
			return { pause: { key: rateKeyOf(conn.platform, conn.instanceUrl), until: now + wait } };
		}
		return {};
	}
}

export interface MetricsTickResult {
	read: number;
	deferred: number;
	paused: string[];
}

/**
 * The tick's metrics pass: enrol what was published, then read what is due,
 * account by account, while the budget covers the next account's reads and
 * every write the pass still owes. Errors stay inside: metrics never break the
 * tick that publishes.
 */
export async function collectDueMetrics(
	db: AppDb,
	env: AppEnv,
	opts: CollectOptions = {}
): Promise<MetricsTickResult> {
	const now = opts.now ?? Date.now();
	const budget = opts.budget ?? null;
	const result: MetricsTickResult = { read: 0, deferred: 0, paused: [] };
	if (budget && budget.remaining < METRICS_MIN_CALLS) return result;
	await enrollPublished(db, now);
	const backoff = await readBackoff(db, now);
	const startKeys = JSON.stringify(backoff);
	const rows = await dueRows(db, now, backoff, METRICS_PER_TICK);
	if (!rows.length) return result;
	const base = opts.fetchImpl ?? providerFetch;
	const fetchImpl = budget ? countingFetch(base, budget) : base;
	const groups = new Map<string, WorkRow[]>();
	for (const row of rows) {
		const list = groups.get(row.connectionId) ?? [];
		list.push(row);
		groups.set(row.connectionId, list);
	}
	const writes = new PendingWrites();
	for (const group of groups.values()) {
		const key = rateKeyOf(group[0].platform, group[0].instanceUrl);
		if (backoff[key]) {
			result.deferred += group.length;
			continue;
		}
		let take = group;
		if (budget) {
			const provider = providerFor({ platform: group[0].platform, metaJson: group[0].metaJson });
			const batch = provider.metricsBatchSize ?? 1;
			const refresh = TOKEN_REFRESH_PLATFORMS.has(group[0].platform);
			const fits = (n: number) =>
				readCalls(group[0].platform, n, batch, refresh) +
					writes.cost(n) +
					1 +
					METRICS_RESERVE_CALLS <=
				budget.remaining;
			let n = group.length;
			while (n > 0 && !fits(n)) n--;
			if (n === 0) {
				result.deferred += rows.length - result.read;
				break;
			}
			take = group.slice(0, n);
			result.deferred += group.length - n;
		}
		const { pause } = await collectGroup(db, env, take, writes, fetchImpl, now);
		result.read += take.length;
		if (pause) {
			backoff[pause.key] = pause.until;
			result.paused.push(pause.key);
		}
	}
	await flushWrites(db, writes);
	if (JSON.stringify(backoff) !== startKeys)
		await writeAppSetting(db, METRICS_BACKOFF_SETTING, JSON.stringify(backoff));
	return result;
}

export class MetricsRefreshError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

/**
 * Read one delivery now, for the refresh button and the API. Refused while the
 * last read is under five minutes old or the platform asked to slow down; the
 * stored metrics come back either way.
 */
export async function refreshDeliveryMetrics(
	db: AppDb,
	env: AppEnv,
	userId: string,
	targetId: string,
	opts: CollectOptions = {}
): Promise<{ refreshed: boolean; reason?: string; metrics: DeliveryMetricsView }> {
	const now = opts.now ?? Date.now();
	const target = await first(
		db
			.select({
				id: publishTargets.id,
				status: publishTargets.status,
				remotePostId: publishTargets.remotePostId,
				updatedAt: publishTargets.updatedAt,
				platform: connections.platform,
				// Every result column needs its own name: D1 collapses duplicates
				// (publish_targets.status, connections.status, both updated_at).
				connStatus: sql<string>`${connections.status}`.as('conn_status'),
				credentialsEncrypted: connections.credentialsEncrypted,
				metaJson: connections.metaJson,
				instanceUrl: connections.instanceUrl,
				connectionId: connections.id,
				metricsPublishedAt: deliveryMetrics.publishedAt,
				stage: deliveryMetrics.stage,
				failures: deliveryMetrics.failures,
				collectedAt: deliveryMetrics.collectedAt
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
			.innerJoin(connections, eq(connections.id, publishTargets.connectionId))
			.leftJoin(deliveryMetrics, eq(deliveryMetrics.targetId, publishTargets.id))
			.where(and(eq(publishTargets.id, targetId), eq(drafts.userId, userId)))
	);
	if (!target) throw new MetricsRefreshError('Delivery not found', 404);
	if (target.status !== 'published')
		throw new MetricsRefreshError('Only a published delivery has metrics', 409);
	const view = () => loadDeliveryMetrics(db, userId, targetId);
	const last = target.collectedAt?.getTime() ?? null;
	if (last !== null && now - last < MANUAL_REFRESH_MIN_MS && now >= last)
		return { refreshed: false, reason: 'Read less than five minutes ago.', metrics: await view() };
	const backoff = await readBackoff(db, now);
	if (backoff[rateKeyOf(target.platform, target.instanceUrl)])
		return {
			refreshed: false,
			reason: metricStateText('rate_limited'),
			metrics: await view()
		};
	const row: WorkRow = {
		targetId: target.id,
		userId,
		platform: target.platform,
		publishedAt: target.metricsPublishedAt ?? target.updatedAt,
		stage: target.stage ?? 0,
		failures: target.failures ?? 0,
		remotePostId: target.remotePostId,
		connectionId: target.connectionId,
		connStatus: target.connStatus,
		credentialsEncrypted: target.credentialsEncrypted,
		metaJson: target.metaJson,
		instanceUrl: target.instanceUrl
	};
	const writes = new PendingWrites();
	const { pause } = await collectGroup(
		db,
		env,
		[row],
		writes,
		opts.fetchImpl ?? providerFetch,
		now
	);
	await flushWrites(db, writes);
	if (pause)
		await writeAppSetting(
			db,
			METRICS_BACKOFF_SETTING,
			JSON.stringify({ ...backoff, [pause.key]: pause.until })
		);
	return { refreshed: true, metrics: await view() };
}

export type MetricsSnapshotView = {
	kind: string;
	collectedAt: number;
	counts: MetricCounts;
};

export type DeliveryMetricsView = {
	targetId: string;
	platform: string;
	state: MetricState;
	/** The sentence to show when there are no counts, or why they are old. */
	message: string | null;
	counts: MetricCounts | null;
	collectedAt: number | null;
	nextAt: number | null;
	snapshots?: MetricsSnapshotView[];
};

function countsOf(row: Record<string, unknown>): MetricCounts | null {
	const counts: MetricCounts = {};
	let any = false;
	for (const key of [
		'likes',
		'comments',
		'shares',
		'quotes',
		'views',
		'impressions',
		'clicks'
	] as const) {
		const v = row[key];
		if (typeof v === 'number') {
			counts[key] = v;
			any = true;
		}
	}
	return any ? counts : null;
}

/** The view of a delivery that has no metrics row (never enrolled). */
function viewWithoutRow(
	targetId: string,
	platform: string,
	metaJson: string | null,
	status: string
): DeliveryMetricsView {
	const support = metricsSupport({
		platform,
		zernio: isZernioConnection(metaJson),
		linkedinOrganization: Boolean(parseJson<ConnectionMeta>(metaJson, {}).organizationUrn)
	});
	const state: MetricState = support.supported ? 'pending' : support.state;
	const message = support.supported
		? status === 'published'
			? 'Not read yet. Refresh to read it now.'
			: 'Metrics start once the post is published.'
		: support.reason;
	return { targetId, platform, state, message, counts: null, collectedAt: null, nextAt: null };
}

/**
 * Latest metrics of the caller's deliveries, keyed by delivery id. Deliveries
 * of other accounts are simply absent. Two statements per hundred ids.
 */
export async function latestMetricsFor(
	db: AppDb,
	userId: string,
	targetIds: string[]
): Promise<Map<string, DeliveryMetricsView>> {
	const out = new Map<string, DeliveryMetricsView>();
	for (const chunk of chunkIds([...new Set(targetIds)])) {
		const rows = await db
			.select({
				targetId: publishTargets.id,
				status: publishTargets.status,
				platform: connections.platform,
				metaJson: connections.metaJson,
				m: deliveryMetrics
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
			.innerJoin(connections, eq(connections.id, publishTargets.connectionId))
			.leftJoin(deliveryMetrics, eq(deliveryMetrics.targetId, publishTargets.id))
			.where(and(eq(drafts.userId, userId), inArray(publishTargets.id, chunk)));
		for (const row of rows) {
			if (!row.m) {
				out.set(row.targetId, viewWithoutRow(row.targetId, row.platform, row.metaJson, row.status));
				continue;
			}
			const state = row.m.state as MetricState;
			const counts = countsOf(row.m);
			out.set(row.targetId, {
				targetId: row.targetId,
				platform: row.platform,
				state,
				message: state === 'ok' ? null : metricStateText(state, row.m.stateDetail),
				counts,
				collectedAt: row.m.collectedAt?.getTime() ?? null,
				nextAt: row.m.nextDueAt?.getTime() ?? null
			});
		}
	}
	return out;
}

/** One delivery's latest metrics and its snapshot history (newest first). */
export async function loadDeliveryMetrics(
	db: AppDb,
	userId: string,
	targetId: string
): Promise<DeliveryMetricsView> {
	const latest = (await latestMetricsFor(db, userId, [targetId])).get(targetId);
	if (!latest) throw new MetricsRefreshError('Delivery not found', 404);
	const snapshots = await db
		.select()
		.from(deliveryMetricSnapshots)
		.where(
			and(
				eq(deliveryMetricSnapshots.targetId, targetId),
				eq(deliveryMetricSnapshots.userId, userId)
			)
		)
		.orderBy(desc(deliveryMetricSnapshots.collectedAt))
		.limit(30);
	return {
		...latest,
		snapshots: snapshots.map((s) => ({
			kind: s.kind,
			collectedAt: s.collectedAt.getTime(),
			counts: countsOf(s) ?? {}
		}))
	};
}
