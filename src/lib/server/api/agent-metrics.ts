import { NOT_COLLECTED_YET, type PerformanceSort } from '#lib/domain/metrics.js';
import { describeInstant } from '#lib/domain/zoned-time.js';
import type { ChannelRef } from '#lib/domain/channel-keys.js';
import { UNBRANDED_SLUG } from '#lib/domain/channel-keys.js';
import { loadChannels } from '#lib/server/brands.js';
import { countsLine, performanceReport } from '#lib/server/metrics-report.js';
import { ApiOperationError } from './operation-error';
import { nowView, parseBound, resolveRefs, type AgentContext } from './agent-operations';

export const PERFORMANCE_DEFAULT_DAYS = 30;
const MAX_RANGE_DAYS = 366;

export type PerformanceInput = {
	brand?: string;
	channels?: ChannelRef[];
	from?: string;
	to?: string;
	sort: PerformanceSort;
	limit: number;
	response_format: 'concise' | 'detailed';
};

function fail(message: string, details?: Record<string, unknown>, status = 400): never {
	throw new ApiOperationError(message, status, details);
}

/**
 * What performed over a range of publish dates: totals per brand and per
 * channel, and the top deliveries by the chosen count, so an agent can see
 * which posts, channels and formats work before it drafts the next ones.
 */
export async function getPerformanceOp(agent: AgentContext, input: PerformanceInput) {
	const { ctx, userId, timeZone } = agent;
	const dir = await loadChannels(ctx.db, userId);
	let connectionIds: string[] | null = null;
	if (input.brand) {
		const wanted = input.brand.trim().toLowerCase();
		const brand = dir.brands.find((b) => b.slug === wanted || b.name.toLowerCase() === wanted);
		if (!brand && wanted !== UNBRANDED_SLUG)
			fail(
				`No brand "${input.brand}". Brands: ${dir.brands.map((b) => b.slug).join(', ') || 'none'}.`,
				{ code: 'unknown_brand' }
			);
		connectionIds = dir.channels
			.filter((c) => c.brand.slug === (brand?.slug ?? UNBRANDED_SLUG))
			.map((c) => c.connectionId);
	}
	if (input.channels?.length) {
		const resolved = resolveRefs(input.channels, dir, 'channels', false);
		if (resolved.problems.length)
			fail(resolved.problems[0], {
				code: 'channel_unresolved',
				problems: resolved.problems,
				unresolved: resolved.unresolved
			});
		const ids = resolved.channels.map((c) => c.connectionId);
		connectionIds = connectionIds ? connectionIds.filter((id) => ids.includes(id)) : ids;
	}
	const to = input.to ? parseBound(input.to, true, timeZone, 'to') : agent.now;
	const from = input.from
		? parseBound(input.from, false, timeZone, 'from')
		: new Date(to.getTime() - PERFORMANCE_DEFAULT_DAYS * 86_400_000);
	if (from.getTime() >= to.getTime())
		fail('from must be before to.', { code: 'invalid_range', now: nowView(agent) });
	if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 86_400_000)
		fail(`A range covers at most ${MAX_RANGE_DAYS} days.`, { code: 'invalid_range' });

	const report = await performanceReport(ctx.db, userId, {
		from,
		to,
		connectionIds,
		sort: input.sort,
		limit: input.limit
	});
	const detailed = input.response_format === 'detailed';
	const at = (ms: number) => describeInstant(ms, timeZone);
	const top = report.top.map((p) => ({
		postId: p.postId,
		deliveryId: p.deliveryId,
		channel: p.channel,
		brand: p.brand,
		platform: p.platform,
		handle: p.handle,
		publishedAt: at(p.publishedAt),
		counts: p.counts,
		engagement: p.engagement,
		excerpt: detailed ? p.excerpt : p.excerpt.slice(0, 80),
		...(detailed
			? { permalink: p.permalink, collectedAt: p.collectedAt ? at(p.collectedAt) : null }
			: {})
	}));
	const channels = report.channels.map((c) => ({
		channel: c.key,
		brand: c.brand.name,
		platform: c.platform,
		handle: c.handle,
		posts: c.posts,
		measured: c.measured,
		engagement: c.engagement,
		totals: {
			likes: c.likes,
			comments: c.comments,
			shares: c.shares,
			quotes: c.quotes,
			views: c.views,
			impressions: c.impressions,
			clicks: c.clicks
		},
		note: c.notice
	}));
	const brands = report.brands.map((b) => ({
		brand: b.name,
		slug: b.slug,
		posts: b.posts,
		measured: b.measured,
		engagement: b.engagement,
		...(detailed
			? {
					totals: {
						likes: b.likes,
						comments: b.comments,
						shares: b.shares,
						quotes: b.quotes,
						views: b.views,
						impressions: b.impressions,
						clicks: b.clicks
					}
				}
			: {})
	}));
	const range = { from: at(from.getTime()), to: at(to.getTime()) };
	const lines = [
		`Performance ${range.from.display} → ${range.to.display}: ${report.totals.posts} published deliver${report.totals.posts === 1 ? 'y' : 'ies'}, ${report.totals.measured} with metrics, engagement ${report.totals.engagement} (likes + comments + shares + quotes).`,
		...brands.map((b) => `  Brand ${b.slug}: ${b.posts} posts, engagement ${b.engagement}`),
		...channels.map(
			(c) =>
				`  ${c.channel || '(disconnected)'} ${c.handle ?? ''}: ${c.posts} posts, engagement ${c.engagement}${c.note ? ` — ${c.note}` : ''}`
		),
		top.length ? `Top by ${report.sort}:` : 'No measured posts in this range yet.',
		...top.map(
			(p, i) =>
				`  ${i + 1}. ${p.channel} ${p.publishedAt.display}: ${countsLine(p.platform, p.counts)} — "${p.excerpt}" (post ${p.postId})`
		),
		`Instagram, Threads and X: ${NOT_COLLECTED_YET.toLowerCase()}`
	];
	return {
		now: nowView(agent),
		range,
		sort: report.sort,
		totals: report.totals,
		brands,
		channels,
		top,
		coverage: {
			bluesky: 'likes, reposts, replies, quotes',
			mastodon: 'favourites, boosts, replies, quotes (Mastodon 4.5+)',
			tiktok: 'views, likes, comments, shares (public videos; needs the video.list permission)',
			linkedin: 'company pages only: impressions, likes, comments, shares, clicks',
			instagram: NOT_COLLECTED_YET,
			threads: NOT_COLLECTED_YET,
			x: NOT_COLLECTED_YET
		},
		summary: lines.join('\n')
	};
}
