import {
	and,
	asc,
	count,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	isNull,
	lt,
	lte,
	ne,
	sql
} from 'drizzle-orm';
import { draftExcerpt } from '#lib/domain/excerpt.js';
import { describeInstant } from '#lib/domain/zoned-time.js';
import { humanizeError } from '#lib/domain/human-error.js';
import { displayHandle, platformName } from '#lib/domain/platforms.js';
import { brands, connections, drafts, publishTargets } from '../db/schema';
import type {
	AlertEvent,
	AlertSource,
	DigestContext,
	DigestSection,
	MailBlock,
	MailGroup,
	MailLine,
	NotificationHooks
} from './events';
import { localClock } from './time';
import { countsLine, topPosts as topPostsReport } from '../metrics-report';

/**
 * Delivery statuses that mean "an agent wrote this and a person has to approve
 * it" (workstream A, the review inbox). Nothing writes them before that lands,
 * so the review alert and the digest's review line find nothing and stay out
 * of the email. A renamed status only needs changing here.
 */
export const REVIEW_STATUSES = ['awaiting_review', 'review_overdue'];

const NO_BRAND = 'No brand';

function link(appUrl: string, path: string): string | undefined {
	return appUrl ? `${appUrl}${path}` : undefined;
}

function account(platform: string | null, handle: string | null): string {
	return [platform ? platformName(platform) : 'Account', displayHandle(handle)]
		.filter(Boolean)
		.join(' ');
}

function postText(baseBody: string | null, title: string | null): string {
	return draftExcerpt(baseBody || title || '(no text)', 80);
}

function plural(n: number, one: string, many = `${one}s`): string {
	return `${n} ${n === 1 ? one : many}`;
}

/** Each user's events after their own cursor, from rows fetched after the earliest one. */
function afterCursor<T extends { userId: string; at: Date }>(
	events: T[],
	users: { userId: string; since: Date }[]
): T[] {
	const since = new Map(users.map((u) => [u.userId, u.since.getTime()]));
	return events.filter((e) => e.at.getTime() > (since.get(e.userId) ?? Infinity));
}

function earliest(users: { since: Date }[]): Date {
	return new Date(Math.min(...users.map((u) => u.since.getTime())));
}

export const failureAlerts: AlertSource = {
	kind: 'failures',
	heading: 'Failed to publish',
	subject: (n) => `${plural(n, 'post')} failed to publish`,
	async collect(db, { users, appUrl, limit }) {
		if (!users.length) return [];
		const rows = await db
			.select({
				at: publishTargets.updatedAt,
				userId: drafts.userId,
				error: publishTargets.errorMessage,
				platform: connections.platform,
				handle: connections.handle,
				brand: brands.name,
				baseBody: drafts.baseBody,
				title: drafts.title
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
			.leftJoin(connections, eq(publishTargets.connectionId, connections.id))
			.leftJoin(brands, eq(connections.brandId, brands.id))
			.where(
				and(
					eq(publishTargets.status, 'failed'),
					isNull(publishTargets.remotePostId),
					inArray(
						drafts.userId,
						users.map((u) => u.userId)
					),
					gt(publishTargets.updatedAt, earliest(users))
				)
			)
			.orderBy(asc(publishTargets.updatedAt))
			.limit(limit);
		return afterCursor(
			rows.map((r) => ({
				userId: r.userId,
				at: r.at,
				group: r.brand ?? NO_BRAND,
				line: {
					text: `${account(r.platform, r.handle)}: “${postText(r.baseBody, r.title)}”`,
					detail: humanizeError(r.error),
					tone: 'error' as const,
					href: link(appUrl, '/posts?tab=failed')
				}
			})),
			users
		);
	}
};

/** A TikTok inbox upload is "published" once it reaches the inbox: its publish id says which. */
function inboxDraft(remotePostId: string | null): 'photo' | 'video' | null {
	if (remotePostId?.startsWith('p_inbox')) return 'photo';
	if (remotePostId?.startsWith('v_inbox')) return 'video';
	return null;
}

const LIVE_BADGE = { text: 'Live', tone: 'success' as const };
const DRAFT_BADGE = { text: 'TikTok draft', tone: 'warn' as const };

function wentOut(events: AlertEvent[]): { live: number; drafts: number } {
	const drafts = events.filter((e) => e.line.badge === DRAFT_BADGE).length;
	return { live: events.length - drafts, drafts };
}

/** The post's first picture (or video cover) for the email card, in the same statement. */
const firstMedia = sql<string | null>`(
	select json_object('key', dm.storage_key, 'mime', dm.mime)
	from draft_media dm
	where dm.draft_id = ${drafts.id}
	order by dm.segment_index, dm.sort_order
	limit 1
)`;

export const publishedAlerts: AlertSource = {
	kind: 'published',
	heading: 'Went out',
	subject: (n) => `${plural(n, 'post')} went out`,
	subjectFor(events) {
		const { live, drafts } = wentOut(events);
		return [
			live ? `${plural(live, 'post')} live` : '',
			drafts ? `${plural(drafts, 'TikTok draft')} ready to post` : ''
		]
			.filter(Boolean)
			.join(', ');
	},
	summarize(events) {
		const { live, drafts } = wentOut(events);
		if (!drafts) return undefined;
		return `${drafts === 1 ? 'The TikTok draft waits' : `The ${drafts} TikTok drafts wait`} in the account's TikTok inbox until you post ${drafts === 1 ? 'it' : 'them'} from the app${live ? '; the rest are live.' : '.'}`;
	},
	async collect(db, { users, appUrl, limit, mediaUrl }) {
		if (!users.length) return [];
		const rows = await db
			.select({
				at: publishTargets.updatedAt,
				userId: drafts.userId,
				draftId: drafts.id,
				remotePostId: publishTargets.remotePostId,
				remoteUrl: publishTargets.remoteUrl,
				platform: connections.platform,
				handle: connections.handle,
				brand: brands.name,
				baseBody: drafts.baseBody,
				title: drafts.title,
				media: firstMedia
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
			.leftJoin(connections, eq(publishTargets.connectionId, connections.id))
			.leftJoin(brands, eq(connections.brandId, brands.id))
			.where(
				and(
					eq(publishTargets.status, 'published'),
					inArray(
						drafts.userId,
						users.map((u) => u.userId)
					),
					gt(publishTargets.updatedAt, earliest(users))
				)
			)
			.orderBy(asc(publishTargets.updatedAt))
			.limit(limit);
		const fresh = afterCursor(
			rows.map((r) => ({ userId: r.userId, at: r.at, row: r })),
			users
		);
		return Promise.all(
			fresh.map(async ({ row: r }) => {
				const inbox = inboxDraft(r.remotePostId);
				const image = await thumbnailFor(r.media, mediaUrl);
				const live = !inbox && r.remoteUrl;
				return {
					userId: r.userId,
					at: r.at,
					group: r.brand ?? undefined,
					line: {
						title: account(r.platform, r.handle),
						text: `“${draftExcerpt(r.baseBody || r.title || '(no text)', 100)}”`,
						badge: inbox ? DRAFT_BADGE : LIVE_BADGE,
						image: image ?? undefined,
						detail: inbox
							? inbox === 'photo'
								? 'In the TikTok inbox: open the notification, add a sound and post it.'
								: 'In the TikTok inbox: open the notification, paste the caption and post it.'
							: undefined,
						href: live
							? r.remoteUrl!
							: link(appUrl, `/compose?id=${encodeURIComponent(r.draftId)}`),
						action: live ? 'View post' : 'Open in CogSend'
					}
				};
			})
		);
	}
};

async function thumbnailFor(
	media: string | null,
	sign: ((key: string) => Promise<string | null>) | undefined
): Promise<string | null> {
	if (!media || !sign) return null;
	try {
		const { key, mime } = JSON.parse(media) as { key?: string; mime?: string };
		if (!key || !mime || !(mime.startsWith('image/') || mime.startsWith('video/'))) return null;
		return await sign(key);
	} catch {
		return null;
	}
}

export const connectionAlerts: AlertSource = {
	kind: 'connections',
	heading: 'Accounts that need reconnecting',
	subject: (n) => `${plural(n, 'account')} need${n === 1 ? 's' : ''} reconnecting`,
	async collect(db, { users, appUrl, limit }) {
		if (!users.length) return [];
		const rows = await db
			.select({
				at: connections.updatedAt,
				userId: connections.userId,
				platform: connections.platform,
				handle: connections.handle,
				brand: brands.name
			})
			.from(connections)
			.leftJoin(brands, eq(connections.brandId, brands.id))
			.where(
				and(
					eq(connections.status, 'expired'),
					inArray(
						connections.userId,
						users.map((u) => u.userId)
					),
					gt(connections.updatedAt, earliest(users))
				)
			)
			.orderBy(asc(connections.updatedAt))
			.limit(limit);
		const lost = rows.map((r) => ({
			userId: r.userId,
			at: r.at,
			group: r.brand ?? NO_BRAND,
			line: {
				text: `${account(r.platform, r.handle)} lost access`,
				detail: 'Reconnect it in Accounts; its scheduled posts wait until then.',
				href: link(appUrl, '/accounts')
			}
		}));
		// Accounts still working but due to lose access within a week in a way
		// only a reconnect fixes (token upkeep records it in the metadata).
		const warnedAt = sql<number>`json_extract(${connections.metaJson}, '$.expiryWarnedAt')`;
		const soon = await db
			.select({
				warnedAt,
				reconnectBy: sql<number>`json_extract(${connections.metaJson}, '$.reconnectBy')`,
				userId: connections.userId,
				platform: connections.platform,
				handle: connections.handle,
				brand: brands.name
			})
			.from(connections)
			.leftJoin(brands, eq(connections.brandId, brands.id))
			.where(
				and(
					eq(connections.status, 'active'),
					inArray(
						connections.userId,
						users.map((u) => u.userId)
					),
					gt(warnedAt, earliest(users).getTime())
				)
			)
			.orderBy(asc(warnedAt))
			.limit(limit);
		const expiring = soon.map((r) => ({
			userId: r.userId,
			at: new Date(Number(r.warnedAt)),
			group: r.brand ?? NO_BRAND,
			line: {
				text: `${account(r.platform, r.handle)} needs reconnecting by ${new Date(Number(r.reconnectBy)).toISOString().slice(0, 10)}`,
				detail:
					'The platform stops accepting its sign-in then. Reconnecting in Accounts resets it.',
				href: link(appUrl, '/accounts')
			}
		}));
		return afterCursor(
			[...lost, ...expiring].sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, limit),
			users
		);
	}
};

/** Posts whose time came while they still waited for approval (workstream A). */
export const reviewAlerts: AlertSource = {
	kind: 'review',
	heading: 'Review overdue',
	subject: (n) => `${plural(n, 'post')} passed ${n === 1 ? 'its' : 'their'} time unapproved`,
	async collect(db, { users, now, appUrl, limit }) {
		if (!users.length) return [];
		const rows = await db
			.select({
				at: publishTargets.scheduledFor,
				userId: drafts.userId,
				platform: connections.platform,
				handle: connections.handle,
				brand: brands.name,
				baseBody: drafts.baseBody,
				title: drafts.title
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
			.leftJoin(connections, eq(publishTargets.connectionId, connections.id))
			.leftJoin(brands, eq(connections.brandId, brands.id))
			.where(
				and(
					inArray(publishTargets.status, REVIEW_STATUSES),
					inArray(
						drafts.userId,
						users.map((u) => u.userId)
					),
					gt(publishTargets.scheduledFor, earliest(users)),
					lte(publishTargets.scheduledFor, now)
				)
			)
			.orderBy(asc(publishTargets.scheduledFor))
			.limit(limit);
		return afterCursor(
			rows
				.filter((r): r is typeof r & { at: Date } => r.at instanceof Date)
				.map((r) => ({
					userId: r.userId,
					at: r.at,
					group: r.brand ?? NO_BRAND,
					line: {
						text: `${account(r.platform, r.handle)}: “${postText(r.baseBody, r.title)}”`,
						detail: 'Held: approve or reschedule it in the Review inbox.',
						href: link(appUrl, '/review')
					}
				})),
			users
		);
	}
};

function groupByBrand(rows: { brand: string | null; line: MailLine }[]): MailGroup[] {
	const groups = new Map<string, MailLine[]>();
	for (const row of rows) {
		const key = row.brand ?? NO_BRAND;
		const list = groups.get(key) ?? [];
		list.push(row.line);
		groups.set(key, list);
	}
	// Brands by name, the unfiled accounts last.
	return [...groups.entries()]
		.sort(([a], [b]) => (a === NO_BRAND ? 1 : b === NO_BRAND ? -1 : a.localeCompare(b)))
		.map(([label, lines]) => ({ label, lines }));
}

const PLANNED_LIMIT = 60;
/** Cancelled and preempted deliveries are no longer part of the day. */
const PLANNED_STATUSES = [
	'scheduled',
	'pending',
	'publishing',
	'published',
	'failed',
	...REVIEW_STATUSES
];
const STATUS_NOTE: Record<string, string> = {
	published: 'published',
	failed: 'failed',
	publishing: 'publishing now',
	awaiting_review: 'waiting for review',
	review_overdue: 'review overdue'
};

export const plannedToday: DigestSection = {
	id: 'planned',
	requires: 'digest',
	cost: 1,
	async build(ctx) {
		const rows = await ctx.db
			.select({
				at: publishTargets.scheduledFor,
				status: publishTargets.status,
				platform: connections.platform,
				handle: connections.handle,
				brand: brands.name,
				baseBody: drafts.baseBody,
				title: drafts.title
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
			.innerJoin(connections, eq(publishTargets.connectionId, connections.id))
			.leftJoin(brands, eq(connections.brandId, brands.id))
			.where(
				and(
					eq(drafts.userId, ctx.userId),
					ne(connections.status, 'disconnected'),
					inArray(publishTargets.status, PLANNED_STATUSES),
					gte(publishTargets.scheduledFor, ctx.today.start),
					lt(publishTargets.scheduledFor, ctx.today.end)
				)
			)
			.orderBy(asc(publishTargets.scheduledFor))
			.limit(PLANNED_LIMIT + 1);
		const shown = rows.slice(0, PLANNED_LIMIT);
		const groups = groupByBrand(
			shown.map((r) => ({
				brand: r.brand,
				line: {
					text: `${r.at ? localClock(r.at, ctx.timeZone) : '--:--'} · ${account(r.platform, r.handle)}: “${postText(r.baseBody, r.title)}”`,
					detail: STATUS_NOTE[r.status],
					tone: r.status === 'failed' ? ('error' as const) : undefined
				}
			}))
		);
		return {
			id: 'planned',
			heading: `Planned today, ${ctx.today.label}`,
			summary: shown.length
				? `${rows.length > PLANNED_LIMIT ? `More than ${PLANNED_LIMIT}` : plural(shown.length, 'post')} across ${plural(groups.length, 'brand')}.`
				: undefined,
			groups,
			empty: 'Nothing is scheduled for today.'
		};
	}
};

const YESTERDAY_LIMIT = 40;

export const yesterdayResults: DigestSection = {
	id: 'yesterday',
	requires: 'digest',
	cost: 1,
	async build(ctx) {
		const rows = await ctx.db
			.select({
				status: publishTargets.status,
				error: publishTargets.errorMessage,
				remoteUrl: publishTargets.remoteUrl,
				platform: connections.platform,
				handle: connections.handle,
				brand: brands.name,
				baseBody: drafts.baseBody,
				title: drafts.title
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
			.leftJoin(connections, eq(publishTargets.connectionId, connections.id))
			.leftJoin(brands, eq(connections.brandId, brands.id))
			.where(
				and(
					eq(drafts.userId, ctx.userId),
					inArray(publishTargets.status, ['published', 'failed']),
					gte(publishTargets.updatedAt, ctx.yesterday.start),
					lt(publishTargets.updatedAt, ctx.yesterday.end)
				)
			)
			// Failures first: they are what the reader has to do something about.
			.orderBy(asc(publishTargets.status), desc(publishTargets.updatedAt))
			.limit(YESTERDAY_LIMIT + 1);
		const published = rows.filter((r) => r.status === 'published').length;
		const failed = rows.length - published;
		const more = rows.length > YESTERDAY_LIMIT;
		const groups = groupByBrand(
			rows.slice(0, YESTERDAY_LIMIT).map((r) => ({
				brand: r.brand,
				line:
					r.status === 'failed'
						? {
								text: `Failed · ${account(r.platform, r.handle)}: “${postText(r.baseBody, r.title)}”`,
								detail: humanizeError(r.error),
								tone: 'error' as const,
								href: link(ctx.appUrl, '/posts?tab=failed')
							}
						: {
								text: `Published · ${account(r.platform, r.handle)}: “${postText(r.baseBody, r.title)}”`,
								href: r.remoteUrl ?? undefined
							}
			}))
		);
		return {
			id: 'yesterday',
			heading: `Yesterday, ${ctx.yesterday.label}`,
			summary: rows.length
				? `${more ? 'At least ' : ''}${published} published, ${failed} failed.`
				: undefined,
			groups,
			empty: 'Nothing went out yesterday.'
		};
	}
};

export const needsAction: DigestSection = {
	id: 'action',
	requires: 'digest',
	cost: 3,
	async build(ctx) {
		const [failedRows, expired, review] = await Promise.all([
			ctx.db
				.select({ n: count() })
				.from(publishTargets)
				.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
				.where(
					and(
						eq(drafts.userId, ctx.userId),
						eq(publishTargets.status, 'failed'),
						isNull(publishTargets.remotePostId)
					)
				),
			ctx.db
				.select({ platform: connections.platform, handle: connections.handle })
				.from(connections)
				.where(and(eq(connections.userId, ctx.userId), eq(connections.status, 'expired')))
				.limit(20),
			ctx.db
				.select({ n: count() })
				.from(publishTargets)
				.innerJoin(drafts, eq(publishTargets.draftId, drafts.id))
				.where(and(eq(drafts.userId, ctx.userId), inArray(publishTargets.status, REVIEW_STATUSES)))
		]);
		const lines: MailLine[] = [];
		const reviewCount = Number(review[0]?.n ?? 0);
		if (reviewCount > 0) {
			lines.push({
				text: `${plural(reviewCount, 'post')} wait${reviewCount === 1 ? 's' : ''} for your review`,
				href: link(ctx.appUrl, '/review')
			});
		}
		const failedCount = Number(failedRows[0]?.n ?? 0);
		if (failedCount > 0) {
			lines.push({
				text: `${plural(failedCount, 'post')} failed and ${failedCount === 1 ? 'needs' : 'need'} a retry or a new time`,
				tone: 'error',
				href: link(ctx.appUrl, '/posts?tab=failed')
			});
		}
		for (const c of expired) {
			lines.push({
				text: `${account(c.platform, c.handle)} needs reconnecting`,
				href: link(ctx.appUrl, '/accounts')
			});
		}
		return {
			id: 'action',
			heading: 'Needs your attention',
			groups: lines.length ? [{ lines }] : [],
			empty: 'Nothing needs you right now.'
		};
	}
};

/** Best performers of the last week, by engagement, from the metrics snapshots. */
export const topPosts: DigestSection = {
	id: 'top-posts',
	requires: 'digest',
	// performanceReport reads targets, snapshots and connections in a few statements.
	cost: 4,
	async build(ctx) {
		const top = await topPostsReport(ctx.db, ctx.userId, { days: 7, now: ctx.now }, { limit: 3 });
		if (!top.length) return null;
		return {
			id: 'top-posts',
			heading: 'Best posts this week',
			groups: [
				{
					lines: top.map((p) => ({
						text: `${p.brand} · ${account(p.platform, p.handle)}: “${p.excerpt}”`,
						detail: countsLine(p.platform, p.counts),
						href: p.permalink ?? undefined
					}))
				}
			]
		};
	}
};

/** Brands whose publishing is paused, so a forgotten pause does not silently stop posting. */
export const pausedBrands: DigestSection = {
	id: 'paused',
	requires: 'paused',
	cost: 1,
	async build(ctx) {
		const rows = await ctx.db
			.select({ name: brands.name, pausedAt: brands.pausedAt })
			.from(brands)
			.where(and(eq(brands.userId, ctx.userId), isNotNull(brands.pausedAt)))
			.orderBy(asc(brands.name))
			.limit(20);
		if (!rows.length) return null;
		return {
			id: 'paused',
			heading: 'Paused brands',
			summary: `${plural(rows.length, 'brand')} ${rows.length === 1 ? 'is' : 'are'} paused: nothing of ${rows.length === 1 ? 'it' : 'them'} is published until resumed.`,
			groups: [
				{
					lines: rows.map((r) => ({
						text: `${r.name}, paused since ${describeInstant(r.pausedAt!, ctx.timeZone).local.slice(0, 10)}`,
						href: link(ctx.appUrl, '/accounts')
					}))
				}
			]
		};
	}
};

/** What the tick sends unless a caller passes its own hooks. Order is email order. */
export const defaultHooks: NotificationHooks = {
	alertSources: [failureAlerts, publishedAlerts, connectionAlerts, reviewAlerts],
	digestSections: [needsAction, plannedToday, yesterdayResults, topPosts, pausedBrands]
};

export type { DigestContext, MailBlock };
