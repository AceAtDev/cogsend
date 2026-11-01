/**
 * What performed: totals per brand and per channel, and the top posts, over a
 * range of publish dates. Read by Insights, the MCP `get_performance` tool and
 * the daily digest (topPosts). Every statement is scoped to one account.
 */
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	lt,
	sql,
	type SQL,
	type SQLWrapper
} from 'drizzle-orm';
import { draftExcerpt } from '#lib/domain/excerpt.js';
import {
	engagementOf,
	metricsSupport,
	PLATFORM_METRICS,
	type MetricCounts,
	type MetricKey,
	type PerformanceSort
} from '#lib/domain/metrics.js';
import { platformName } from '#lib/domain/platforms.js';
import { isZernioConnection } from '#lib/domain/zernio.js';
import { batchQueries, parseJson, type AppDb } from './db/client';
import { connections, deliveryMetrics, draftVariants, drafts, publishTargets } from './db/schema';
import { loadChannels } from './brands';

const TOTAL_KEYS = [
	'likes',
	'comments',
	'shares',
	'quotes',
	'views',
	'impressions',
	'clicks'
] as const;

export type PerformanceTotals = Record<(typeof TOTAL_KEYS)[number], number> & {
	/** Published deliveries in the range. */
	posts: number;
	/** Of those, how many have been read at least once. */
	measured: number;
	engagement: number;
};

export type PerformanceChannel = PerformanceTotals & {
	connectionId: string;
	key: string;
	platform: string;
	platformName: string;
	handle: string | null;
	brand: { id: string | null; name: string; slug: string; color: string };
	connected: boolean;
	/** Why there are no counts for this channel, when there cannot be any. */
	notice: string | null;
	/** Deliveries waiting on a reconnect before they can be read. */
	needsReconnect: number;
};

export type PerformanceBrand = PerformanceTotals & {
	id: string | null;
	name: string;
	slug: string;
	color: string;
};

export type TopPost = {
	deliveryId: string;
	postId: string;
	connectionId: string;
	channel: string;
	brand: string;
	platform: string;
	handle: string | null;
	publishedAt: number;
	collectedAt: number | null;
	permalink: string | null;
	excerpt: string;
	counts: MetricCounts;
	engagement: number;
};

export type PerformanceFilter = {
	from: Date;
	to: Date;
	/** Only these channels; null or undefined for all. An empty list matches nothing. */
	connectionIds?: string[] | null;
	sort?: PerformanceSort;
	limit?: number;
};

function num(value: unknown): number {
	if (typeof value === 'bigint') return Number(value);
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function emptyTotals(): PerformanceTotals {
	return {
		posts: 0,
		measured: 0,
		engagement: 0,
		likes: 0,
		comments: 0,
		shares: 0,
		quotes: 0,
		views: 0,
		impressions: 0,
		clicks: 0
	};
}

function addInto(into: PerformanceTotals, from: PerformanceTotals) {
	into.posts += from.posts;
	into.measured += from.measured;
	into.engagement += from.engagement;
	for (const key of TOTAL_KEYS) into[key] += from[key];
}

const sortColumn: Record<Exclude<PerformanceSort, 'recent' | 'engagement'>, MetricKey> = {
	likes: 'likes',
	comments: 'comments',
	shares: 'shares',
	views: 'views',
	impressions: 'impressions'
};

const engagementSql = sql<number>`(coalesce(${deliveryMetrics.likes}, 0) + coalesce(${deliveryMetrics.comments}, 0) + coalesce(${deliveryMetrics.shares}, 0) + coalesce(${deliveryMetrics.quotes}, 0))`;

/**
 * Totals and top posts for deliveries published in [from, to). Three reads in
 * one batch (accounts, per-channel sums, the top list), then one for the
 * platform versions of the top posts' text.
 */
export async function performanceReport(db: AppDb, userId: string, filter: PerformanceFilter) {
	const limit = Math.min(50, Math.max(1, Math.floor(filter.limit ?? 10)));
	const sort: PerformanceSort = filter.sort ?? 'engagement';
	const where: Array<SQL | undefined> = [
		eq(drafts.userId, userId),
		eq(publishTargets.status, 'published'),
		gte(publishTargets.updatedAt, filter.from),
		lt(publishTargets.updatedAt, filter.to)
	];
	if (filter.connectionIds)
		where.push(
			filter.connectionIds.length
				? inArray(publishTargets.connectionId, filter.connectionIds)
				: sql`0`
		);

	const topWhere = [...where, isNotNull(deliveryMetrics.collectedAt)];
	let order: SQL;
	if (sort === 'recent') order = desc(publishTargets.updatedAt);
	else if (sort === 'engagement') order = desc(engagementSql);
	else {
		const column = deliveryMetrics[sortColumn[sort]];
		topWhere.push(isNotNull(column));
		order = desc(column);
	}

	const sum = (column: SQLWrapper, alias: string) =>
		sql<number>`coalesce(sum(${column}), 0)`.as(alias);

	const [connRows, channelRows, topRows] = (await batchQueries(db, [
		db
			.select({
				id: connections.id,
				platform: connections.platform,
				handle: connections.handle,
				status: connections.status,
				metaJson: connections.metaJson
			})
			.from(connections)
			.where(eq(connections.userId, userId)),
		db
			.select({
				connectionId: publishTargets.connectionId,
				posts: sql<number>`count(*)`.as('posts'),
				measured:
					sql<number>`coalesce(sum(case when ${deliveryMetrics.collectedAt} is not null then 1 else 0 end), 0)`.as(
						'measured'
					),
				reconnect:
					sql<number>`coalesce(sum(case when ${deliveryMetrics.state} = 'reconnect' then 1 else 0 end), 0)`.as(
						'reconnect'
					),
				likes: sum(deliveryMetrics.likes, 'likes'),
				comments: sum(deliveryMetrics.comments, 'comments'),
				shares: sum(deliveryMetrics.shares, 'shares'),
				quotes: sum(deliveryMetrics.quotes, 'quotes'),
				views: sum(deliveryMetrics.views, 'views'),
				impressions: sum(deliveryMetrics.impressions, 'impressions'),
				clicks: sum(deliveryMetrics.clicks, 'clicks')
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
			.leftJoin(deliveryMetrics, eq(deliveryMetrics.targetId, publishTargets.id))
			.where(and(...where))
			.groupBy(publishTargets.connectionId),
		db
			.select({
				targetId: publishTargets.id,
				draftId: publishTargets.draftId,
				connectionId: publishTargets.connectionId,
				publishedAt: publishTargets.updatedAt,
				remoteUrl: publishTargets.remoteUrl,
				title: drafts.title,
				baseBody: drafts.baseBody,
				m: deliveryMetrics
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
			.innerJoin(deliveryMetrics, eq(deliveryMetrics.targetId, publishTargets.id))
			.where(and(...topWhere))
			.orderBy(order, desc(publishTargets.updatedAt))
			.limit(limit)
	])) as [
		{ id: string; platform: string; handle: string | null; status: string; metaJson: string }[],
		Array<Record<string, unknown> & { connectionId: string }>,
		Array<{
			targetId: string;
			draftId: string;
			connectionId: string;
			publishedAt: Date;
			remoteUrl: string | null;
			title: string | null;
			baseBody: string;
			m: typeof deliveryMetrics.$inferSelect;
		}>
	];

	const dir = await loadChannels(db, userId);
	const channelOf = new Map(dir.channels.map((c) => [c.connectionId, c]));
	const connOf = new Map(connRows.map((c) => [c.id, c]));
	const unbranded = { id: null, name: 'Unbranded', slug: 'unbranded', color: '#78716c' };

	const describe = (connectionId: string) => {
		const channel = channelOf.get(connectionId);
		const conn = connOf.get(connectionId);
		const platform = channel?.platform ?? conn?.platform ?? 'unknown';
		return {
			key: channel?.key ?? '',
			platform,
			handle: channel?.handle ?? conn?.handle ?? null,
			brand: channel?.brand ?? unbranded,
			connected: Boolean(channel),
			metaJson: conn?.metaJson ?? '{}'
		};
	};

	const channels: PerformanceChannel[] = channelRows.map((row) => {
		const who = describe(row.connectionId);
		const totals = emptyTotals();
		totals.posts = num(row.posts);
		totals.measured = num(row.measured);
		for (const key of TOTAL_KEYS) totals[key] = num(row[key]);
		totals.engagement = engagementOf(totals);
		const support = metricsSupport({
			platform: who.platform,
			zernio: isZernioConnection(who.metaJson),
			linkedinOrganization: Boolean(
				parseJson<{ organizationUrn?: string }>(who.metaJson, {}).organizationUrn
			)
		});
		const needsReconnect = num(row.reconnect);
		return {
			...totals,
			connectionId: row.connectionId,
			key: who.key,
			platform: who.platform,
			platformName: platformName(who.platform),
			handle: who.handle,
			brand: who.brand,
			connected: who.connected,
			notice: support.supported
				? needsReconnect
					? 'Reconnect this account to collect metrics.'
					: null
				: support.reason,
			needsReconnect
		};
	});
	channels.sort((a, b) => b.engagement - a.engagement || b.posts - a.posts);

	const brandMap = new Map<string, PerformanceBrand>();
	const totals = emptyTotals();
	for (const channel of channels) {
		addInto(totals, channel);
		const id = channel.brand.id ?? 'unbranded';
		const brand =
			brandMap.get(id) ?? ({ ...emptyTotals(), ...channel.brand } satisfies PerformanceBrand);
		addInto(brand, channel);
		brandMap.set(id, brand);
	}
	const brands = [...brandMap.values()].sort(
		(a, b) => b.engagement - a.engagement || b.posts - a.posts
	);

	const draftIds = [...new Set(topRows.map((r) => r.draftId))];
	const variants = draftIds.length
		? await db
				.select({
					draftId: draftVariants.draftId,
					platform: draftVariants.platform,
					body: draftVariants.body
				})
				.from(draftVariants)
				.where(inArray(draftVariants.draftId, draftIds))
		: [];
	const top: TopPost[] = topRows.map((row) => {
		const who = describe(row.connectionId);
		const counts: MetricCounts = {};
		for (const key of PLATFORM_METRICS[who.platform] ?? TOTAL_KEYS) {
			const v = row.m[key];
			if (typeof v === 'number') counts[key] = v;
		}
		const text =
			variants.find((v) => v.draftId === row.draftId && v.platform === who.platform)?.body ||
			row.baseBody ||
			row.title ||
			'';
		return {
			deliveryId: row.targetId,
			postId: row.draftId,
			connectionId: row.connectionId,
			channel: who.key,
			brand: who.brand.name,
			platform: who.platform,
			handle: who.handle,
			publishedAt: row.publishedAt.getTime(),
			collectedAt: row.m.collectedAt?.getTime() ?? null,
			permalink: row.remoteUrl,
			excerpt: draftExcerpt(text, 140),
			counts,
			engagement: engagementOf(counts)
		};
	});

	return {
		from: filter.from.getTime(),
		to: filter.to.getTime(),
		sort,
		totals,
		brands,
		channels,
		top
	};
}

export type PerformanceReport = Awaited<ReturnType<typeof performanceReport>>;

/**
 * The best posts of the last `days` days (or an explicit range), for the
 * daily digest and anything else that wants a short list.
 */
export async function topPosts(
	db: AppDb,
	userId: string,
	range: { days: number; now?: Date } | { from: Date; to: Date },
	opts: { limit?: number; sort?: PerformanceSort } = {}
): Promise<TopPost[]> {
	const window =
		'days' in range
			? (() => {
					const to = range.now ?? new Date();
					return { from: new Date(to.getTime() - range.days * 86_400_000), to };
				})()
			: range;
	const report = await performanceReport(db, userId, {
		...window,
		limit: opts.limit ?? 5,
		sort: opts.sort ?? 'engagement'
	});
	return report.top;
}
