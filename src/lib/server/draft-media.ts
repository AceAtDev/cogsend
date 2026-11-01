import { and, count, eq, ne } from 'drizzle-orm';
import { MAX_IMAGES_PER_SEGMENT, videoMixProblem } from '#lib/domain/media-limits.js';
import { splitThreadSegments } from '#lib/domain/thread-segments.js';
import { first } from './db/client';
import { draftMedia, draftVariants, drafts, publishTargets } from './db/schema';
import { fail } from './http';
import { draftEditBlock } from './publish-plan';

const MAX_SEGMENT_INDEX = 100;
export const MAX_ALT_LENGTH = 1500;
// No per-draft or per-user cap existed: segment math alone allows
// ~400 files per draft (100 segments x 4), unbounded R2 cost and
// Worker-memory pressure at publish (bytes are buffered ~2x).
export const MAX_FILES_PER_DRAFT = 32;
export const MAX_FILES_PER_USER = 1000;

export function parseSegmentIndex(value: unknown): number {
	const n = typeof value === 'number' ? value : parseInt(String(value ?? '0'), 10);
	if (!Number.isFinite(n)) return 0;
	return Math.min(MAX_SEGMENT_INDEX, Math.max(0, Math.floor(n)));
}

export function cleanAltText(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, MAX_ALT_LENGTH);
}

/** Why the draft's media cannot change now (publishing, or published), or null. */
export async function draftMediaEditBlock(
	db: App.Locals['db'],
	draftId: string
): Promise<string | null> {
	const targets = await db.select().from(publishTargets).where(eq(publishTargets.draftId, draftId));
	return draftEditBlock(targets);
}

export async function rejectIfNotEditable(db: App.Locals['db'], draftId: string) {
	const blocked = await draftMediaEditBlock(db, draftId);
	return blocked ? fail(blocked, 409) : null;
}

type DbLocals = Pick<App.Locals, 'db'>;

export async function ownDraft(locals: DbLocals, id: string, userId: string) {
	return first(
		locals.db
			.select()
			.from(drafts)
			.where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
	);
}

/**
 * Refuse a media row on a segment the draft does not have. `resolvePublishSegments`
 * walks the same `splitThreadSegments` the composer renders, so a row parked
 * past the last card is never attached to a post — the image is silently
 * dropped at publish, with nothing to see in the editor either. Empty segments
 * count: the composer shows them, and a card with only an image publishes.
 *
 * The bound is the longest body the draft can publish, not the shared one: a
 * per-platform variant may add posts of its own, and media attached to one of
 * those is attached at publish.
 */
export async function segmentProblem(
	locals: DbLocals,
	draft: { id: string; baseBody: string | null },
	segmentIndex: number
): Promise<string | null> {
	const variants = await locals.db
		.select({ body: draftVariants.body })
		.from(draftVariants)
		.where(eq(draftVariants.draftId, draft.id));
	const cards = Math.max(
		splitThreadSegments(draft.baseBody ?? '').length,
		...variants.map((v) => splitThreadSegments(v.body ?? '').length)
	);
	if (segmentIndex < cards) return null;
	return `segmentIndex ${segmentIndex} is past the last segment (${cards - 1})`;
}

/**
 * Whether `adding` more files would take the account past MAX_FILES_PER_USER.
 * Files on fully published drafts do not count: they are locked, never sent
 * again, and their bytes are cleared after a retention period, so counting
 * them would block uploads after a few weeks of steady posting. One
 * statement whatever the account size.
 */
export async function overUserFileCap(
	db: App.Locals['db'],
	userId: string,
	adding: number
): Promise<boolean> {
	const row = await first(
		db
			.select({ n: count() })
			.from(draftMedia)
			.innerJoin(drafts, eq(drafts.id, draftMedia.draftId))
			.where(and(eq(drafts.userId, userId), ne(drafts.status, 'published')))
	);
	return Number(row?.n ?? 0) + adding > MAX_FILES_PER_USER;
}

const isVideoRow = (m: { mime: string | null }) =>
	(m.mime || '').toLowerCase().startsWith('video/');

/**
 * Every check a new video on `segmentIndex` must pass before any bytes are
 * stored: the card exists, the draft and account have room, and the card holds
 * no other media. The parts route runs it when an upload starts and again when
 * it completes, since another upload may have landed in between.
 */
export async function videoSlotProblem(
	locals: DbLocals,
	draft: { id: string; baseBody: string | null; userId: string },
	segmentIndex: number
): Promise<{ message: string; status: number } | null> {
	const problem = await segmentProblem(locals, draft, segmentIndex);
	if (problem) return { message: problem, status: 400 };
	const existing = await locals.db
		.select()
		.from(draftMedia)
		.where(eq(draftMedia.draftId, draft.id));
	if (existing.length + 1 > MAX_FILES_PER_DRAFT) {
		return { message: `Max ${MAX_FILES_PER_DRAFT} files per draft`, status: 413 };
	}
	if (await overUserFileCap(locals.db, draft.userId, 1)) {
		return { message: `Max ${MAX_FILES_PER_USER} files per account`, status: 413 };
	}
	const onSegment = existing.filter((m) => (m.segmentIndex ?? 0) === segmentIndex);
	if (onSegment.length >= MAX_IMAGES_PER_SEGMENT) {
		return { message: `Max ${MAX_IMAGES_PER_SEGMENT} images per post`, status: 400 };
	}
	const videos = onSegment.filter(isVideoRow).length;
	const mix = videoMixProblem(videos + 1, onSegment.length - videos);
	return mix ? { message: mix, status: 400 } : null;
}
