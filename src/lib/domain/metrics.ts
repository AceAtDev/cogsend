/**
 * Performance metrics for published deliveries: what each platform reports,
 * when CogSend reads it again, and how the counts are labelled. Pure logic,
 * shared by the scheduler, the routes, MCP and the UI.
 */

export const METRIC_KEYS = [
	'likes',
	'comments',
	'shares',
	'quotes',
	'views',
	'impressions',
	'clicks'
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];

/** A platform leaves out what it does not report; null and absent both mean "not reported". */
export type MetricCounts = Partial<Record<MetricKey, number | null>>;

export const METRIC_LABEL: Record<MetricKey, string> = {
	likes: 'Likes',
	comments: 'Comments',
	shares: 'Shares',
	quotes: 'Quotes',
	views: 'Views',
	impressions: 'Impressions',
	clicks: 'Clicks'
};

/** Which counts each collected platform reports, in display order. */
export const PLATFORM_METRICS: Partial<Record<string, readonly MetricKey[]>> = {
	bluesky: ['likes', 'shares', 'comments', 'quotes'],
	mastodon: ['likes', 'shares', 'comments', 'quotes'],
	tiktok: ['views', 'likes', 'comments', 'shares'],
	linkedin: ['impressions', 'likes', 'comments', 'shares', 'clicks']
};

/** Platform words for a count where they differ from ours (a Bluesky share is a repost). */
const PLATFORM_LABEL: Partial<Record<string, Partial<Record<MetricKey, string>>>> = {
	bluesky: { shares: 'Reposts', comments: 'Replies' },
	mastodon: { likes: 'Favourites', shares: 'Boosts', comments: 'Replies' }
};

export function metricLabel(platform: string, key: MetricKey): string {
	return PLATFORM_LABEL[platform]?.[key] ?? METRIC_LABEL[key];
}

/**
 * Where a delivery's metrics stand.
 * - `pending`: published, nothing read yet.
 * - `ok`: counts are current as of `collectedAt`.
 * - `reconnect`: the account must be connected again (expired token, or a
 *   TikTok connection made before CogSend asked for `video.list`).
 * - `unsupported`: the platform or account kind gives CogSend no counts.
 * - `not_found`: the platform no longer has the post (deleted or hidden).
 * - `unavailable`: this one post cannot be read (a TikTok post with no public id).
 * - `rate_limited` / `error`: a temporary failure, tried again later.
 */
export const METRIC_STATES = [
	'pending',
	'ok',
	'reconnect',
	'unsupported',
	'not_found',
	'unavailable',
	'rate_limited',
	'error'
] as const;
export type MetricState = (typeof METRIC_STATES)[number];

export const NOT_COLLECTED_YET = 'Metrics are not collected for this platform yet.';
export const LINKEDIN_PERSONAL_MESSAGE =
	'Not available on LinkedIn for personal profiles: LinkedIn only reports post statistics for company pages.';
export const TIKTOK_RECONNECT_MESSAGE =
	'TikTok metrics need permission to read video stats (video.list): once the instance asks TikTok for it (TIKTOK_METRICS), reconnect this account.';
export const ZERNIO_MESSAGE = 'Metrics are not collected for accounts posted through Zernio.';

/**
 * Whether CogSend collects metrics for an account at all, decided from what is
 * stored (no network call). `reason` is the sentence the UI and MCP show.
 */
export function metricsSupport(conn: {
	platform: string;
	zernio?: boolean;
	linkedinOrganization?: boolean;
	scopes?: readonly string[] | null;
}): { supported: true } | { supported: false; state: MetricState; reason: string } {
	if (conn.zernio) return { supported: false, state: 'unsupported', reason: ZERNIO_MESSAGE };
	switch (conn.platform) {
		case 'bluesky':
		case 'mastodon':
			return { supported: true };
		case 'tiktok':
			// Stored scopes come from the token answer; an older row without any
			// list is tried, and a refusal is classified when TikTok answers.
			if (conn.scopes && !conn.scopes.includes('video.list'))
				return { supported: false, state: 'reconnect', reason: TIKTOK_RECONNECT_MESSAGE };
			return { supported: true };
		case 'linkedin':
			return conn.linkedinOrganization
				? { supported: true }
				: { supported: false, state: 'unsupported', reason: LINKEDIN_PERSONAL_MESSAGE };
		default:
			return { supported: false, state: 'unsupported', reason: NOT_COLLECTED_YET };
	}
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Snapshots after publishing: about an hour, a day and a week. */
export const SNAPSHOT_OFFSETS_MS = [HOUR, DAY, 7 * DAY] as const;
export const SNAPSHOT_KINDS = ['1h', '24h', '7d'] as const;
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number] | 'manual';

/**
 * After the last offset, a missed week snapshot is still taken for this long
 * (a scheduler that was down for a day), and then the delivery is left alone.
 */
export const SNAPSHOT_GRACE_MS = 2 * DAY;
export const SNAPSHOT_WINDOW_MS =
	SNAPSHOT_OFFSETS_MS[SNAPSHOT_OFFSETS_MS.length - 1] + SNAPSHOT_GRACE_MS;

/** When the first snapshot of a delivery published at `publishedAt` is due. */
export function firstDueAt(publishedAt: number): number | null {
	return dueAfter(publishedAt, 0);
}

function dueAfter(publishedAt: number, stage: number): number | null {
	const offset = SNAPSHOT_OFFSETS_MS[stage];
	return offset === undefined ? null : publishedAt + offset;
}

/**
 * The plan after a successful read at `now`. A tick that ran late (or a read
 * on demand) may have passed several offsets at once: every offset already
 * passed counts as taken, so a delivery read 30 hours in gets one "24h"
 * snapshot instead of an "1h" and then an immediate "24h".
 */
export function planAfterRead(
	publishedAt: number,
	stage: number,
	now: number
): { stage: number; nextDueAt: number | null; kind: SnapshotKind } {
	const age = now - publishedAt;
	let passed = 0;
	while (passed < SNAPSHOT_OFFSETS_MS.length && SNAPSHOT_OFFSETS_MS[passed] <= age) passed++;
	const newStage = Math.max(stage, passed);
	const kind: SnapshotKind = passed > stage ? SNAPSHOT_KINDS[passed - 1] : 'manual';
	if (age > SNAPSHOT_WINDOW_MS) return { stage: SNAPSHOT_OFFSETS_MS.length, nextDueAt: null, kind };
	return { stage: newStage, nextDueAt: dueAfter(publishedAt, newStage), kind };
}

const BACKOFF_BASE_MS = 15 * 60_000;
const BACKOFF_MAX_MS = 6 * HOUR;
/** A reconnect-shaped failure is looked at again once a day, in case the account came back. */
export const RECONNECT_RETRY_MS = DAY;

/**
 * When to try again after a failed read: what the platform asked for when it
 * said (Retry-After / a reset time), else 15 minutes doubling per consecutive
 * failure, capped at six hours.
 */
export function retryDelayMs(failures: number, retryAfterMs?: number | null): number {
	if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0)
		return Math.min(Math.max(retryAfterMs, 60_000), BACKOFF_MAX_MS);
	const n = Math.max(0, Math.min(10, failures));
	return Math.min(BACKOFF_BASE_MS * 2 ** n, BACKOFF_MAX_MS);
}

/**
 * The next time a failed delivery is read, or null to stop: nothing is
 * scheduled past the window, and a post that is gone or unsupported is never
 * asked about again on a timer (a refresh on demand still can).
 */
export function nextAfterFailure(opts: {
	state: MetricState;
	publishedAt: number;
	failures: number;
	now: number;
	retryAfterMs?: number | null;
}): number | null {
	const { state, publishedAt, failures, now } = opts;
	if (state === 'not_found' || state === 'unsupported' || state === 'unavailable') return null;
	const at =
		state === 'reconnect'
			? now + RECONNECT_RETRY_MS
			: now + retryDelayMs(failures, opts.retryAfterMs);
	return at > publishedAt + SNAPSHOT_WINDOW_MS ? null : at;
}

/** Interactions people made, for ranking: views and impressions are reach, not engagement. */
export function engagementOf(counts: MetricCounts): number {
	return (counts.likes ?? 0) + (counts.comments ?? 0) + (counts.shares ?? 0) + (counts.quotes ?? 0);
}

export const PERFORMANCE_SORTS = [
	'engagement',
	'likes',
	'comments',
	'shares',
	'views',
	'impressions',
	'recent'
] as const;
export type PerformanceSort = (typeof PERFORMANCE_SORTS)[number];

/** A refresh on demand is refused while the last read is younger than this. */
export const MANUAL_REFRESH_MIN_MS = 5 * 60_000;

/** One line for a state that has no counts to show. */
export function metricStateText(state: MetricState, detail?: string | null): string {
	switch (state) {
		case 'pending':
			return 'Metrics are collected about an hour after publishing.';
		case 'reconnect':
			return detail || 'Reconnect this account to collect metrics.';
		case 'unsupported':
			return detail || NOT_COLLECTED_YET;
		case 'not_found':
			return 'The platform no longer has this post (deleted or hidden).';
		case 'unavailable':
			return detail || 'The platform gives no stats for this post.';
		case 'rate_limited':
			return 'The platform asked CogSend to slow down; metrics are read again shortly.';
		case 'error':
			return detail
				? `Could not read metrics: ${detail}`
				: 'Could not read metrics; tried again later.';
		case 'ok':
			return '';
	}
}

/** Short "1.2k" style numbers for tight layouts. */
export function compactCount(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
