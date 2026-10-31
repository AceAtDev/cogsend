import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne } from 'drizzle-orm';
import {
	calendarStatus,
	filteredConnectionIds,
	itemInstant,
	type CalendarBrand,
	type CalendarChannel,
	type CalendarDraft,
	type CalendarItem,
	type CalendarMedia,
	type CalendarQuery
} from '#lib/domain/calendar.js';
import {
	assignChannelKeys,
	handleSlug,
	UNBRANDED_COLOR,
	UNBRANDED_SLUG
} from '#lib/domain/channel-keys.js';
import { isPlatformId, platformName } from '#lib/domain/platforms.js';
import { batchQueries, chunkIds, parseJson, type AppDb } from '#lib/server/db/client.js';
import {
	brands,
	connections,
	draftMedia,
	drafts,
	draftVariants,
	publishTargets
} from '#lib/server/db/schema.js';

/**
 * More than a month of ten busy channels; past it the calendar says it is
 * showing part of the range instead of spending the request's D1 budget.
 */
export const CALENDAR_ITEM_CAP = 400;
export const UNSCHEDULED_CAP = 30;

const RANGE_STATUSES = ['scheduled', 'pending', 'publishing', 'published', 'failed'];

function toMs(value: Date | number | null): number | null {
	if (value === null) return null;
	return value instanceof Date ? value.getTime() : value;
}

/**
 * Everything the calendar draws for [startMs, endMs): one item per publish
 * target, the brands and channels they belong to, and the drafts that have no
 * time yet.
 *
 * D1 counts every statement against the Workers Free budget of 50, so this
 * runs a fixed number of batches: brands, accounts and undated drafts; the two
 * range reads (a scheduled time in range, or no time and last changed in range,
 * which is how a publish-now or a cancelled row is placed), each served by an
 * index on (status, time); then media and platform text for the drafts found,
 * a hundred drafts per statement.
 */
export async function loadCalendar(
	db: AppDb,
	userId: string,
	opts: {
		startMs: number;
		endMs: number;
		filter: Pick<CalendarQuery, 'brands' | 'channels' | 'cancelled'>;
		now?: Date;
	}
) {
	const now = opts.now ?? new Date();
	type BrandRow = { id: string; name: string; slug: string; color: string };
	type ConnRow = {
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		status: string;
		brandId: string | null;
		createdAt: Date;
	};
	type DraftRow = { id: string; title: string | null; baseBody: string; updatedAt: Date };
	const [brandRows, connRows, undated] = (await batchQueries(db, [
		db
			.select({ id: brands.id, name: brands.name, slug: brands.slug, color: brands.color })
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
				id: drafts.id,
				title: drafts.title,
				baseBody: drafts.baseBody,
				updatedAt: drafts.updatedAt
			})
			.from(drafts)
			.where(and(eq(drafts.userId, userId), eq(drafts.status, 'draft')))
			.orderBy(desc(drafts.updatedAt))
			.limit(UNSCHEDULED_CAP + 1)
	])) as [BrandRow[], ConnRow[], DraftRow[]];

	const channels = buildChannels(brandRows, connRows);
	const shown = filteredConnectionIds(
		channels.map((c) => ({ connectionId: c.connectionId, key: c.key, brandSlug: c.brand.slug })),
		opts.filter
	);
	const statuses = opts.filter.cancelled ? [...RANGE_STATUSES, 'cancelled'] : RANGE_STATUSES;
	// A filter naming no account shows nothing; one naming more accounts than
	// D1 binds in one statement is applied below instead.
	const shownIds = shown ? [...shown] : null;
	const sqlFilter =
		shownIds && shownIds.length <= 80 ? inArray(publishTargets.connectionId, shownIds) : undefined;
	const start = new Date(opts.startMs);
	const end = new Date(opts.endMs);
	const targetFields = {
		id: publishTargets.id,
		draftId: publishTargets.draftId,
		connectionId: publishTargets.connectionId,
		variantId: publishTargets.variantId,
		status: publishTargets.status,
		scheduledFor: publishTargets.scheduledFor,
		updatedAt: publishTargets.updatedAt,
		remotePostId: publishTargets.remotePostId,
		remoteUrl: publishTargets.remoteUrl,
		errorMessage: publishTargets.errorMessage,
		jobId: publishTargets.jobId,
		baseBody: drafts.baseBody
	};
	type TargetRow = {
		id: string;
		draftId: string;
		connectionId: string;
		variantId: string | null;
		status: string;
		scheduledFor: Date | null;
		updatedAt: Date;
		remotePostId: string | null;
		remoteUrl: string | null;
		errorMessage: string | null;
		jobId: string | null;
		baseBody: string;
	};
	let timed: TargetRow[] = [];
	let untimed: TargetRow[] = [];
	if (!shownIds || shownIds.length) {
		[timed, untimed] = (await batchQueries(db, [
			db
				.select(targetFields)
				.from(publishTargets)
				.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
				.where(
					and(
						inArray(publishTargets.status, statuses),
						gte(publishTargets.scheduledFor, start),
						lt(publishTargets.scheduledFor, end),
						eq(drafts.userId, userId),
						sqlFilter
					)
				)
				.limit(CALENDAR_ITEM_CAP + 1),
			db
				.select(targetFields)
				.from(publishTargets)
				.innerJoin(drafts, eq(drafts.id, publishTargets.draftId))
				.where(
					and(
						inArray(publishTargets.status, statuses),
						isNull(publishTargets.scheduledFor),
						gte(publishTargets.updatedAt, start),
						lt(publishTargets.updatedAt, end),
						eq(drafts.userId, userId),
						sqlFilter
					)
				)
				.limit(CALENDAR_ITEM_CAP + 1)
		])) as [TargetRow[], TargetRow[]];
	}

	const connById = new Map(connRows.map((c) => [c.id, c]));
	let rows = [...timed, ...untimed].filter((t) => {
		const conn = connById.get(t.connectionId);
		if (!conn || (shown && !shown.has(t.connectionId))) return false;
		// A disconnected account keeps what it published, as Posts does.
		return conn.status !== 'disconnected' || Boolean(t.remotePostId);
	});
	rows.sort((a, b) => itemInstant(a) - itemInstant(b) || a.id.localeCompare(b.id));
	const truncated =
		timed.length > CALENDAR_ITEM_CAP ||
		untimed.length > CALENDAR_ITEM_CAP ||
		rows.length > CALENDAR_ITEM_CAP;
	rows = rows.slice(0, CALENDAR_ITEM_CAP);

	const undatedPage = undated.slice(0, UNSCHEDULED_CAP);
	const draftIds = [...new Set([...rows.map((t) => t.draftId), ...undatedPage.map((d) => d.id)])];
	type MediaDbRow = {
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
	};
	type VariantRow = { id: string; draftId: string; platform: string; body: string | null };
	const media: Record<string, CalendarMedia[]> = {};
	const variantById = new Map<string, VariantRow>();
	const variantByDraftPlatform = new Map<string, VariantRow>();
	const timedDraftIds = new Set(rows.map((t) => t.draftId));
	for (const chunk of chunkIds(draftIds)) {
		const variantDraftIds = chunk.filter((id) => timedDraftIds.has(id));
		const queries: unknown[] = [
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
				.where(inArray(draftMedia.draftId, chunk))
		];
		if (variantDraftIds.length) {
			queries.push(
				db
					.select({
						id: draftVariants.id,
						draftId: draftVariants.draftId,
						platform: draftVariants.platform,
						body: draftVariants.body
					})
					.from(draftVariants)
					.where(
						and(
							inArray(draftVariants.draftId, variantDraftIds),
							isNotNull(draftVariants.body),
							ne(draftVariants.body, '')
						)
					)
			);
		}
		const [mediaRows, variantRows = []] = (await batchQueries(db, queries)) as [
			MediaDbRow[],
			VariantRow[]?
		];
		mediaRows.sort(
			(a, b) =>
				a.segmentIndex - b.segmentIndex || a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)
		);
		for (const m of mediaRows) {
			(media[m.draftId] ??= []).push({
				id: m.id,
				storageKey: m.storageKey,
				mime: m.mime,
				width: m.width,
				height: m.height,
				altText: m.altText,
				meta: m.metaJson ? parseJson<Record<string, unknown>>(m.metaJson, {}) : null
			});
		}
		for (const v of variantRows) {
			variantById.set(v.id, v);
			variantByDraftPlatform.set(`${v.draftId}:${v.platform}`, v);
		}
	}

	const items: CalendarItem[] = rows.map((t) => {
		const conn = connById.get(t.connectionId)!;
		const variant =
			(t.variantId ? variantById.get(t.variantId) : undefined) ??
			variantByDraftPlatform.get(`${t.draftId}:${conn.platform}`);
		const status = calendarStatus(t, now);
		return {
			id: t.id,
			draftId: t.draftId,
			connectionId: t.connectionId,
			status,
			at: itemInstant(t),
			scheduledFor: toMs(t.scheduledFor),
			retrying: status === 'scheduled' && Boolean(t.errorMessage),
			remoteUrl: t.remoteUrl,
			errorMessage: status === 'failed' || status === 'scheduled' ? t.errorMessage : null,
			text: variant?.body || t.baseBody,
			mediaCount: media[t.draftId]?.length ?? 0
		};
	});

	const unscheduled: CalendarDraft[] = undatedPage.map((d) => ({
		id: d.id,
		title: d.title,
		body: d.baseBody,
		updatedAt: d.updatedAt.getTime(),
		mediaCount: media[d.id]?.length ?? 0
	}));

	return {
		brands: calendarBrands(brandRows, channels),
		channels,
		items,
		media,
		unscheduled,
		unscheduledHasMore: undated.length > UNSCHEDULED_CAP,
		truncated
	};
}

/**
 * Keys for the accounts that can still be posted to, as `loadChannels` names
 * them; a disconnected account keeps its brand and platform so its published
 * history still reads, but no key.
 */
export function buildChannels(
	brandRows: Array<{ id: string; name: string; slug: string; color: string }>,
	connRows: Array<{
		id: string;
		platform: string;
		handle: string | null;
		displayName: string | null;
		status: string;
		brandId: string | null;
		createdAt?: Date | number | null;
	}>
): CalendarChannel[] {
	const live = assignChannelKeys(
		brandRows,
		connRows.filter((c) => c.status !== 'disconnected')
	).map((c): CalendarChannel => ({
		connectionId: c.connectionId,
		key: c.key,
		platform: c.platform,
		platformName: c.platformName,
		handle: c.handle,
		displayName: c.displayName,
		status: c.status,
		brand: c.brand
	}));
	const brandById = new Map(brandRows.map((b) => [b.id, b]));
	const gone = connRows
		.filter((c) => c.status === 'disconnected')
		.map((c): CalendarChannel => {
			const brand = c.brandId ? brandById.get(c.brandId) : undefined;
			return {
				connectionId: c.id,
				key: '',
				platform: c.platform,
				platformName: isPlatformId(c.platform) ? platformName(c.platform) : c.platform,
				handle: c.handle,
				displayName: c.displayName,
				status: c.status,
				brand: brand
					? { id: brand.id, name: brand.name, slug: brand.slug, color: brand.color }
					: { id: null, name: 'Unbranded', slug: UNBRANDED_SLUG, color: UNBRANDED_COLOR }
			};
		})
		.sort((a, b) =>
			handleSlug(a.handle, a.connectionId).localeCompare(handleSlug(b.handle, b.connectionId))
		);
	return [...live, ...gone];
}

/** Brands in legend order: by name, then Unbranded when any account has none. */
export function calendarBrands(
	brandRows: Array<{ id: string; name: string; slug: string; color: string }>,
	channels: CalendarChannel[]
): CalendarBrand[] {
	const out: CalendarBrand[] = [...brandRows]
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
		.map((b) => ({ id: b.id, name: b.name, slug: b.slug, color: b.color }));
	if (channels.some((c) => c.brand.id === null))
		out.push({ id: null, name: 'Unbranded', slug: UNBRANDED_SLUG, color: UNBRANDED_COLOR });
	return out;
}
