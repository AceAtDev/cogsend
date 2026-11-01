import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { draftExcerpt } from '#lib/domain/excerpt.js';
import { UNBRANDED_SLUG } from '#lib/domain/channel-keys.js';
import {
	AWAITING_REVIEW,
	parseReviewNote,
	REJECTED,
	reviewTiming,
	type ReviewTiming
} from '#lib/domain/review.js';
import { ApiOperationError } from './api/operation-error';
import { recordActivity, SYSTEM_ACTOR, type Actor } from './activity';
import { batchQueries, chunkIds, parseJson, type AppDb } from './db/client';
import {
	brands,
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets
} from './db/schema';
import type { AppEnv } from './env';
import { refreshDraftStatuses } from './publish';
import { buildChannels } from './calendar';
import {
	emitReviewAlerts,
	hasReviewAlertListeners,
	type ReviewAlert,
	type ReviewAlertItem
} from './review-alerts';

function invalid(message: string, status = 400, details?: Record<string, unknown>): never {
	throw new ApiOperationError(message, status, details);
}

/** Keeps every IN(...) list well under D1's 100 bound parameters a statement. */
const ID_CHUNK = 80;

export type WriteOrigin = {
	authCredential?: 'session' | 'personal_api_key' | 'api_token' | null;
};

/**
 * An agent's write: a personal API key (REST or MCP) or the instance's
 * API_TOKEN. A cookie session is the operator in the app, whose writes are
 * never held; so is a caller that names no credential (internal code paths).
 */
export function isAgentWrite(origin: WriteOrigin | null | undefined): boolean {
	return origin?.authCredential === 'personal_api_key' || origin?.authCredential === 'api_token';
}

/** Accounts whose brand reviews agent writes; an account in no brand always does. */
function reviewedAccounts(db: AppDb, userId: string) {
	return db
		.select({ id: connections.id })
		.from(connections)
		.leftJoin(brands, eq(brands.id, connections.brandId))
		.where(
			and(eq(connections.userId, userId), or(isNull(brands.id), eq(brands.requireApproval, true)))
		);
}

/**
 * Which of these accounts an agent's write must hold for review. Empty for the
 * operator's own writes, so the caller can skip it without a query.
 */
export async function accountsToHold(
	db: AppDb,
	origin: WriteOrigin | null | undefined,
	userId: string,
	connectionIds: string[]
): Promise<Set<string>> {
	if (!isAgentWrite(origin) || !connectionIds.length) return new Set();
	const held = new Set<string>();
	for (const chunk of chunkIds(connectionIds, ID_CHUNK)) {
		const rows = await db
			.select({ id: connections.id })
			.from(connections)
			.leftJoin(brands, eq(brands.id, connections.brandId))
			.where(
				and(
					eq(connections.userId, userId),
					inArray(connections.id, chunk),
					or(isNull(brands.id), eq(brands.requireApproval, true))
				)
			);
		for (const row of rows) held.add(row.id);
	}
	return held;
}

/** Accounts among these whose brand is paused, with the brand's name. */
export async function pausedAccounts(
	db: AppDb,
	userId: string,
	connectionIds: string[]
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const chunk of chunkIds(connectionIds, ID_CHUNK)) {
		const rows = await db
			.select({ id: connections.id, brand: brands.name })
			.from(connections)
			.innerJoin(brands, eq(brands.id, connections.brandId))
			.where(
				and(
					eq(connections.userId, userId),
					inArray(connections.id, chunk),
					isNotNull(brands.pausedAt)
				)
			);
		for (const row of rows) out.set(row.id, row.brand);
	}
	return out;
}

/** Refuses to send now to a paused brand: the operator stopped it on purpose. */
export async function refusePausedBrands(db: AppDb, userId: string, connectionIds: string[]) {
	const paused = await pausedAccounts(db, userId, connectionIds);
	if (!paused.size) return;
	const names = [...new Set(paused.values())];
	invalid(
		`${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} paused: nothing of ${names.length === 1 ? 'it' : 'them'} is published until it is resumed in Accounts.`,
		409,
		{ code: 'brand_paused', pausedBrands: names, connectionIds: [...paused.keys()] }
	);
}

/**
 * After an agent changes a post's text, media or options, the deliveries the
 * operator already approved on reviewed brands wait for review again: they
 * approved what they read, not what the agent wrote since. One statement when
 * there is nothing to send back.
 */
export async function reholdAfterAgentEdit(
	db: AppDb,
	origin: (WriteOrigin & { apiKey?: { id: string; prefix: string } | null }) | null | undefined,
	userId: string,
	draftId: string,
	actor: Actor | null = null,
	now: Date = new Date()
): Promise<string[]> {
	if (!isAgentWrite(origin)) return [];
	const rows = await db
		.update(publishTargets)
		.set({ status: AWAITING_REVIEW, reviewOverdueAt: null, updatedAt: now })
		.where(
			and(
				eq(publishTargets.draftId, draftId),
				eq(publishTargets.status, 'scheduled'),
				isNull(publishTargets.remotePostId),
				isNull(publishTargets.jobId),
				inArray(publishTargets.connectionId, reviewedAccounts(db, userId))
			)
		)
		.returning({ id: publishTargets.id });
	if (!rows.length) return [];
	await refreshDraftStatuses(db, [draftId]);
	if (actor)
		await recordActivity(
			db,
			userId,
			actor,
			{
				action: 'review.held',
				targetType: 'post',
				targetId: draftId,
				summary: `An approved post was edited, so ${rows.length} deliver${rows.length === 1 ? 'y waits' : 'ies wait'} for review again`,
				before: 'scheduled',
				after: AWAITING_REVIEW
			},
			now
		);
	return rows.map((r) => r.id);
}

type QueueTargetRow = {
	id: string;
	draftId: string;
	connectionId: string;
	variantId: string | null;
	status: string;
	scheduledFor: Date | null;
	updatedAt: Date;
	createdAt: Date;
	reviewNote: string | null;
	reviewedAt: Date | null;
	reviewOverdueAt: Date | null;
	title: string | null;
	baseBody: string;
};

export type ReviewDelivery = {
	deliveryId: string;
	connectionId: string;
	channelKey: string;
	platform: string;
	platformName: string;
	handle: string | null;
	status: string;
	scheduledFor: number | null;
	timing: ReviewTiming;
	text: string;
	connectionStatus: string;
};

export type ReviewCard = {
	postId: string;
	title: string | null;
	text: string;
	status: 'awaiting_review' | 'rejected';
	/** Earliest time among its deliveries; null when one is a held "publish now". */
	scheduledFor: number | null;
	timing: ReviewTiming;
	heldAt: number;
	reviewNote: string | null;
	reviewedAt: number | null;
	deliveries: ReviewDelivery[];
	media: Array<{
		id: string;
		storageKey: string;
		mime: string;
		width: number | null;
		height: number | null;
		altText: string | null;
		meta: Record<string, unknown> | null;
	}>;
};

export type ReviewBrandGroup = {
	brand: {
		id: string | null;
		name: string;
		slug: string;
		color: string;
		paused: boolean;
		requireApproval: boolean;
	};
	cards: ReviewCard[];
};

/** More than anyone reviews in one sitting; past it the page says so. */
export const REVIEW_QUEUE_CAP = 300;

/**
 * Everything waiting for the operator, by brand: one card per post and brand,
 * so approving a card approves that post on that brand's channels only.
 * Rejected posts come after, until the agent resubmits or someone cancels them.
 */
export async function loadReviewQueue(
	db: AppDb,
	userId: string,
	opts: { now?: Date; includeRejected?: boolean } = {}
) {
	const now = opts.now ?? new Date();
	const statuses = opts.includeRejected === false ? [AWAITING_REVIEW] : [AWAITING_REVIEW, REJECTED];
	type BrandRow = {
		id: string;
		name: string;
		slug: string;
		color: string;
		requireApproval: boolean;
		pausedAt: Date | null;
	};
	type ConnRow = {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		status: string;
		brandId: string | null;
		createdAt: Date;
	};
	const [brandRows, connRows, targetRows] = (await batchQueries(db, [
		db
			.select({
				id: brands.id,
				name: brands.name,
				slug: brands.slug,
				color: brands.color,
				requireApproval: brands.requireApproval,
				pausedAt: brands.pausedAt
			})
			.from(brands)
			.where(eq(brands.userId, userId)),
		db
			.select({
				id: connections.id,
				platform: connections.platform,
				handle: connections.handle,
				displayName: connections.displayName,
				status: connections.status,
				brandId: connections.brandId,
				createdAt: connections.createdAt
			})
			.from(connections)
			.where(eq(connections.userId, userId)),
		db
			.select({
				id: publishTargets.id,
				draftId: publishTargets.draftId,
				connectionId: publishTargets.connectionId,
				variantId: publishTargets.variantId,
				status: publishTargets.status,
				scheduledFor: publishTargets.scheduledFor,
				updatedAt: publishTargets.updatedAt,
				createdAt: publishTargets.createdAt,
				reviewNote: publishTargets.reviewNote,
				reviewedAt: publishTargets.reviewedAt,
				reviewOverdueAt: publishTargets.reviewOverdueAt,
				title: drafts.title,
				baseBody: drafts.baseBody
			})
			.from(publishTargets)
			.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
			.where(and(eq(drafts.userId, userId), inArray(publishTargets.status, statuses)))
			.orderBy(asc(publishTargets.scheduledFor), asc(publishTargets.id))
			.limit(REVIEW_QUEUE_CAP + 1)
	])) as [BrandRow[], ConnRow[], QueueTargetRow[]];
	const truncated = targetRows.length > REVIEW_QUEUE_CAP;
	const rows = targetRows.slice(0, REVIEW_QUEUE_CAP);
	const channels = buildChannels(brandRows, connRows);
	const channelById = new Map(channels.map((c) => [c.connectionId, c]));
	const draftIds = [...new Set(rows.map((r) => r.draftId))];

	const media = new Map<string, ReviewCard['media']>();
	const variants = new Map<string, Array<{ id: string; platform: string; body: string | null }>>();
	for (const chunk of chunkIds(draftIds, ID_CHUNK)) {
		const [mediaRows, variantRows] = (await batchQueries(db, [
			db
				.select({
					id: draftMedia.id,
					draftId: draftMedia.draftId,
					storageKey: draftMedia.storageKey,
					mime: draftMedia.mime,
					width: draftMedia.width,
					height: draftMedia.height,
					altText: draftMedia.altText,
					sortOrder: draftMedia.sortOrder,
					segmentIndex: draftMedia.segmentIndex,
					metaJson: draftMedia.metaJson
				})
				.from(draftMedia)
				.where(inArray(draftMedia.draftId, chunk)),
			db
				.select({
					id: draftVariants.id,
					draftId: draftVariants.draftId,
					platform: draftVariants.platform,
					body: draftVariants.body
				})
				.from(draftVariants)
				.where(inArray(draftVariants.draftId, chunk))
		])) as [
			Array<{
				id: string;
				draftId: string;
				storageKey: string;
				mime: string;
				width: number | null;
				height: number | null;
				altText: string | null;
				sortOrder: number;
				segmentIndex: number;
				metaJson: string | null;
			}>,
			Array<{ id: string; draftId: string; platform: string; body: string | null }>
		];
		mediaRows.sort((a, b) => a.segmentIndex - b.segmentIndex || a.sortOrder - b.sortOrder);
		for (const m of mediaRows)
			media.set(m.draftId, [
				...(media.get(m.draftId) ?? []),
				{
					id: m.id,
					storageKey: m.storageKey,
					mime: m.mime,
					width: m.width,
					height: m.height,
					altText: m.altText,
					meta: m.metaJson ? parseJson<Record<string, unknown>>(m.metaJson, {}) : null
				}
			]);
		for (const v of variantRows) variants.set(v.draftId, [...(variants.get(v.draftId) ?? []), v]);
	}

	const brandMeta = new Map(brandRows.map((b) => [b.id, b]));
	const groups = new Map<string, ReviewBrandGroup>();
	const cards = new Map<string, ReviewCard>();
	for (const row of rows) {
		const channel = channelById.get(row.connectionId);
		// A disconnected account's delivery can never be sent; it is Posts' to show.
		if (!channel || channel.status === 'disconnected') continue;
		const brandId = channel.brand.id;
		const groupKey = brandId ?? UNBRANDED_SLUG;
		let group = groups.get(groupKey);
		if (!group) {
			const meta = brandId ? brandMeta.get(brandId) : undefined;
			group = {
				brand: {
					...channel.brand,
					paused: Boolean(meta?.pausedAt),
					requireApproval: meta ? meta.requireApproval : true
				},
				cards: []
			};
			groups.set(groupKey, group);
		}
		const status = row.status === REJECTED ? REJECTED : AWAITING_REVIEW;
		const cardKey = `${groupKey}:${row.draftId}:${status}`;
		let card = cards.get(cardKey);
		if (!card) {
			card = {
				postId: row.draftId,
				title: row.title,
				text: row.baseBody,
				status,
				scheduledFor: row.scheduledFor?.getTime() ?? null,
				timing: reviewTiming(row.scheduledFor, now),
				heldAt: row.updatedAt.getTime(),
				reviewNote: row.reviewNote,
				reviewedAt: row.reviewedAt?.getTime() ?? null,
				deliveries: [],
				media: media.get(row.draftId) ?? []
			};
			cards.set(cardKey, card);
			group.cards.push(card);
		}
		const variant =
			(row.variantId
				? variants.get(row.draftId)?.find((v) => v.id === row.variantId)
				: undefined) ?? variants.get(row.draftId)?.find((v) => v.platform === channel.platform);
		const at = row.scheduledFor?.getTime() ?? null;
		if (at === null || (card.scheduledFor !== null && at < card.scheduledFor))
			card.scheduledFor = at;
		card.timing = reviewTiming(card.scheduledFor, now);
		card.heldAt = Math.max(card.heldAt, row.updatedAt.getTime());
		card.reviewNote ??= row.reviewNote;
		card.deliveries.push({
			deliveryId: row.id,
			connectionId: row.connectionId,
			channelKey: channel.key,
			platform: channel.platform,
			platformName: channel.platformName,
			handle: channel.handle,
			status: row.status,
			scheduledFor: at,
			timing: reviewTiming(row.scheduledFor, now),
			text: variant?.body?.trim() ? variant.body : row.baseBody,
			connectionStatus: channel.status
		});
	}
	const ordered = [...groups.values()].sort((a, b) => {
		if (a.brand.id === null) return 1;
		if (b.brand.id === null) return -1;
		return a.brand.name.localeCompare(b.brand.name);
	});
	for (const group of ordered)
		group.cards.sort(
			(a, b) =>
				Number(a.status === REJECTED) - Number(b.status === REJECTED) ||
				(a.scheduledFor ?? 0) - (b.scheduledFor ?? 0)
		);
	const all = ordered.flatMap((g) => g.cards);
	const waiting = all.filter((c) => c.status === AWAITING_REVIEW);
	return {
		groups: ordered,
		counts: {
			waiting: waiting.reduce((n, c) => n + c.deliveries.length, 0),
			overdue: waiting
				.filter((c) => c.timing === 'overdue')
				.reduce((n, c) => n + c.deliveries.length, 0),
			rejected: all
				.filter((c) => c.status === REJECTED)
				.reduce((n, c) => n + c.deliveries.length, 0)
		},
		truncated
	};
}

/** How many deliveries wait for review, for the navigation badge. One statement. */
export async function countAwaitingReview(db: AppDb, userId: string): Promise<number> {
	const [row] = await db
		.select({ n: sql<number>`count(*)` })
		.from(publishTargets)
		.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
		.where(and(eq(drafts.userId, userId), eq(publishTargets.status, AWAITING_REVIEW)));
	return Number(row?.n ?? 0);
}

export type ReviewSelection = {
	deliveryIds?: unknown;
	/** A brand id, or "unbranded": every held delivery of that brand. */
	brandId?: unknown;
	/** Every delivery held for review. */
	all?: unknown;
};

/**
 * The held deliveries a selection names, owned by this user and in one of
 * `statuses`. Ids that are not (another account's, or no longer held) are
 * simply not returned: approving twice, or after a cancel, changes nothing.
 */
async function selectHeld(
	db: AppDb,
	userId: string,
	selection: ReviewSelection,
	statuses: string[]
): Promise<Array<{ id: string; draftId: string; status: string; scheduledFor: Date | null }>> {
	const ids = Array.isArray(selection.deliveryIds)
		? [
				...new Set(
					selection.deliveryIds.filter(
						(id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128
					)
				)
			]
		: null;
	const brandId = typeof selection.brandId === 'string' ? selection.brandId : null;
	const all = selection.all === true;
	if (!ids?.length && !brandId && !all) invalid('Send deliveryIds, brandId or all: true');
	if (ids && ids.length > 500) invalid('At most 500 deliveries at once');
	const fields = {
		id: publishTargets.id,
		draftId: publishTargets.draftId,
		status: publishTargets.status,
		scheduledFor: publishTargets.scheduledFor
	};
	const owned = and(eq(drafts.userId, userId), inArray(publishTargets.status, statuses));
	let brandFilter;
	if (brandId === UNBRANDED_SLUG)
		brandFilter = inArray(
			publishTargets.connectionId,
			db
				.select({ id: connections.id })
				.from(connections)
				.where(and(eq(connections.userId, userId), isNull(connections.brandId)))
		);
	else if (brandId)
		brandFilter = inArray(
			publishTargets.connectionId,
			db
				.select({ id: connections.id })
				.from(connections)
				.where(and(eq(connections.userId, userId), eq(connections.brandId, brandId)))
		);
	if (!ids) {
		return db
			.select(fields)
			.from(publishTargets)
			.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
			.where(and(owned, brandFilter))
			.limit(500);
	}
	const out = [];
	for (const chunk of chunkIds(ids, ID_CHUNK)) {
		out.push(
			...(await db
				.select(fields)
				.from(publishTargets)
				.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
				.where(and(owned, inArray(publishTargets.id, chunk), brandFilter)))
		);
	}
	return out;
}

function deliveriesWord(n: number) {
	return `${n} deliver${n === 1 ? 'y' : 'ies'}`;
}

/**
 * Approve held (or rejected) deliveries: they become `scheduled` at their own
 * time, or at `runAt` when given. One whose time has passed goes out on the
 * next tick; so does a held "publish now". Only the operator approves, so the
 * routes calling this require a session.
 */
export async function approveDeliveries(
	db: AppDb,
	userId: string,
	actor: Actor,
	selection: ReviewSelection & { runAt?: unknown },
	now: Date = new Date()
) {
	let runAt: Date | null = null;
	if (selection.runAt !== undefined && selection.runAt !== null) {
		runAt = typeof selection.runAt === 'string' ? new Date(selection.runAt) : new Date(NaN);
		if (Number.isNaN(runAt.getTime())) invalid('runAt must be an ISO 8601 time');
		if (runAt.getTime() <= now.getTime()) invalid('runAt must be in the future');
	}
	const rows = await selectHeld(db, userId, selection, [AWAITING_REVIEW, REJECTED]);
	const approved: string[] = [];
	for (const chunk of chunkIds(
		rows.map((r) => r.id),
		ID_CHUNK
	)) {
		const done = await db
			.update(publishTargets)
			.set({
				status: 'scheduled',
				scheduledFor: runAt ?? sql`coalesce(${publishTargets.scheduledFor}, ${now.getTime()})`,
				reviewedAt: now,
				reviewOverdueAt: null,
				errorMessage: null,
				jobId: null,
				attemptCount: 0,
				updatedAt: now
			})
			.where(
				and(
					inArray(publishTargets.id, chunk),
					inArray(publishTargets.status, [AWAITING_REVIEW, REJECTED])
				)
			)
			.returning({ id: publishTargets.id });
		approved.push(...done.map((d) => d.id));
	}
	const drafted = [...new Set(rows.filter((r) => approved.includes(r.id)).map((r) => r.draftId))];
	if (drafted.length) await refreshDraftStatuses(db, drafted);
	if (approved.length)
		await recordActivity(
			db,
			userId,
			actor,
			drafted.map((draftId) => {
				const n = rows.filter((r) => r.draftId === draftId && approved.includes(r.id)).length;
				return {
					action: 'review.approve',
					targetType: 'post',
					targetId: draftId,
					summary: `Approved ${deliveriesWord(n)}${runAt ? ` for ${runAt.toISOString()}` : ''}`,
					before: AWAITING_REVIEW,
					after: 'scheduled'
				};
			}),
			now
		);
	return { approved, posts: drafted };
}

/** Reject with a note the agent reads (get_post, list_posts) before resubmitting. */
export async function rejectDeliveries(
	db: AppDb,
	userId: string,
	actor: Actor,
	selection: ReviewSelection & { note?: unknown },
	now: Date = new Date()
) {
	const parsed = parseReviewNote(selection.note);
	if (!parsed.ok) invalid('note must be text of at most 2000 characters');
	const rows = await selectHeld(db, userId, selection, [AWAITING_REVIEW]);
	const rejected: string[] = [];
	for (const chunk of chunkIds(
		rows.map((r) => r.id),
		ID_CHUNK
	)) {
		const done = await db
			.update(publishTargets)
			.set({
				status: REJECTED,
				reviewNote: parsed.note,
				reviewedAt: now,
				jobId: null,
				updatedAt: now
			})
			.where(and(inArray(publishTargets.id, chunk), eq(publishTargets.status, AWAITING_REVIEW)))
			.returning({ id: publishTargets.id });
		rejected.push(...done.map((d) => d.id));
	}
	const drafted = [...new Set(rows.filter((r) => rejected.includes(r.id)).map((r) => r.draftId))];
	if (drafted.length) await refreshDraftStatuses(db, drafted);
	if (rejected.length)
		await recordActivity(
			db,
			userId,
			actor,
			drafted.map((draftId) => ({
				action: 'review.reject',
				targetType: 'post',
				targetId: draftId,
				summary: `Rejected ${deliveriesWord(rows.filter((r) => r.draftId === draftId && rejected.includes(r.id)).length)}${parsed.note ? `: ${parsed.note}` : ''}`,
				before: AWAITING_REVIEW,
				after: REJECTED
			})),
			now
		);
	return { rejected, posts: drafted, note: parsed.note };
}

/**
 * An agent's answer to a rejection: the deliveries wait for review again,
 * optionally at a new time. The note stays, so the operator sees what they
 * asked for next to what came back.
 */
export async function resubmitDeliveries(
	db: AppDb,
	userId: string,
	actor: Actor,
	deliveryIds: string[],
	runAt: Date | null,
	now: Date = new Date()
) {
	const rows = await selectHeld(db, userId, { deliveryIds }, [REJECTED, AWAITING_REVIEW]);
	const resubmitted: string[] = [];
	for (const chunk of chunkIds(
		rows.map((r) => r.id),
		ID_CHUNK
	)) {
		const done = await db
			.update(publishTargets)
			.set({
				status: AWAITING_REVIEW,
				...(runAt ? { scheduledFor: runAt } : {}),
				reviewOverdueAt: null,
				updatedAt: now
			})
			.where(
				and(
					inArray(publishTargets.id, chunk),
					inArray(publishTargets.status, [REJECTED, AWAITING_REVIEW])
				)
			)
			.returning({ id: publishTargets.id });
		resubmitted.push(...done.map((d) => d.id));
	}
	const drafted = [...new Set(rows.map((r) => r.draftId))];
	if (drafted.length) await refreshDraftStatuses(db, drafted);
	if (resubmitted.length)
		await recordActivity(
			db,
			userId,
			actor,
			drafted.map((draftId) => ({
				action: 'review.resubmit',
				targetType: 'post',
				targetId: draftId,
				summary: `Resubmitted ${deliveriesWord(rows.filter((r) => r.draftId === draftId).length)} for review`,
				before: REJECTED,
				after: AWAITING_REVIEW
			})),
			now
		);
	return { resubmitted, posts: drafted, rows };
}

/** Rows the overdue sweep reads per tick; the rest are flagged on the next one. */
export const OVERDUE_SWEEP_LIMIT = 100;

async function alertItems(
	db: AppDb,
	where: ReturnType<typeof and>,
	limit: number
): Promise<Array<ReviewAlertItem & { userId: string }>> {
	const rows = await db
		.select({
			id: publishTargets.id,
			draftId: publishTargets.draftId,
			connectionId: publishTargets.connectionId,
			scheduledFor: publishTargets.scheduledFor,
			userId: drafts.userId,
			baseBody: drafts.baseBody,
			platform: connections.platform,
			handle: connections.handle,
			brandId: brands.id,
			brandName: brands.name
		})
		.from(publishTargets)
		.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
		.innerJoin(connections, eq(connections.id, publishTargets.connectionId))
		.leftJoin(brands, eq(brands.id, connections.brandId))
		.where(where)
		.orderBy(asc(publishTargets.scheduledFor))
		.limit(limit);
	return rows.map((r) => ({
		userId: r.userId,
		deliveryId: r.id,
		postId: r.draftId,
		connectionId: r.connectionId,
		platform: r.platform,
		handle: r.handle,
		brandId: r.brandId ?? null,
		brandName: r.brandName ?? 'Unbranded',
		scheduledFor: r.scheduledFor,
		excerpt: draftExcerpt(r.baseBody, 90)
	}));
}

function byUser(
	items: Array<ReviewAlertItem & { userId: string }>,
	kind: ReviewAlert['kind'],
	at: Date
) {
	const out = new Map<string, ReviewAlert>();
	for (const { userId, ...item } of items) {
		const alert = out.get(userId) ?? { kind, userId, items: [], at };
		alert.items.push(item);
		out.set(userId, alert);
	}
	return [...out.values()];
}

/**
 * The tick's half of review: a held delivery whose time has passed stays
 * held, and the first tick to notice flags it (`review_overdue_at`), logs it
 * and raises one `review_overdue` alert per user. One read when nothing is
 * newly overdue, which is every tick but a few.
 */
export async function sweepOverdueReviews(
	db: AppDb,
	env: AppEnv,
	now: Date = new Date()
): Promise<ReviewAlert[]> {
	const found = await alertItems(
		db,
		and(
			eq(publishTargets.status, AWAITING_REVIEW),
			isNull(publishTargets.reviewOverdueAt),
			or(isNull(publishTargets.scheduledFor), lte(publishTargets.scheduledFor, now))
		),
		OVERDUE_SWEEP_LIMIT
	);
	if (!found.length) return [];
	const flagged = new Set<string>();
	for (const chunk of chunkIds(
		found.map((f) => f.deliveryId),
		ID_CHUNK
	)) {
		// Conditional, so two overlapping ticks cannot both alert for one row.
		const rows = await db
			.update(publishTargets)
			.set({ reviewOverdueAt: now })
			.where(
				and(
					inArray(publishTargets.id, chunk),
					eq(publishTargets.status, AWAITING_REVIEW),
					isNull(publishTargets.reviewOverdueAt)
				)
			)
			.returning({ id: publishTargets.id });
		for (const row of rows) flagged.add(row.id);
	}
	const alerts = byUser(
		found.filter((f) => flagged.has(f.deliveryId)),
		'review_overdue',
		now
	);
	for (const alert of alerts)
		await recordActivity(
			db,
			alert.userId,
			SYSTEM_ACTOR,
			{
				action: 'review.overdue',
				targetType: 'delivery',
				targetId: alert.items.length === 1 ? alert.items[0].deliveryId : null,
				summary: `${deliveriesWord(alert.items.length)} reached ${alert.items.length === 1 ? 'its' : 'their'} time unapproved and stay${alert.items.length === 1 ? 's' : ''} held: ${alert.items
					.slice(0, 5)
					.map((i) => `${i.brandName} ${i.platform} "${i.excerpt}"`)
					.join('; ')}`
			},
			now
		);
	await emitReviewAlerts(alerts, { db, env });
	return alerts;
}

/**
 * After a write held deliveries: log it and raise `review_waiting`. The read
 * for the alert's detail is skipped while nobody listens.
 */
export async function announceHeld(
	db: AppDb,
	env: AppEnv,
	userId: string,
	actor: Actor,
	draftId: string,
	deliveryIds: string[],
	now: Date = new Date()
) {
	if (!deliveryIds.length) return;
	await recordActivity(
		db,
		userId,
		actor,
		{
			action: 'review.held',
			targetType: 'post',
			targetId: draftId,
			summary: `Held ${deliveriesWord(deliveryIds.length)} for review`,
			after: AWAITING_REVIEW
		},
		now
	);
	if (!hasReviewAlertListeners()) return;
	const items = await alertItems(
		db,
		and(inArray(publishTargets.id, deliveryIds.slice(0, ID_CHUNK)), eq(drafts.userId, userId)),
		ID_CHUNK
	);
	await emitReviewAlerts(byUser(items, 'review_waiting', now), { db, env });
}
