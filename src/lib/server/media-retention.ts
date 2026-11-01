import { inArray, sql } from 'drizzle-orm';
import type { AppDb } from './db/client';
import { draftMedia } from './db/schema';
import type { SubrequestBudget } from './budget';
import { readAppSetting, writeAppSetting } from './app-settings';
import { deleteMediaObjects, type MediaStore } from './media';

const DAY = 24 * 60 * 60_000;

/**
 * How long a fully published post keeps its uploaded files. A published post
 * is locked and never sent again, so after this its originals (and the
 * preview, thumbnail and cover copies beside them) only cost storage.
 */
export const PUBLISHED_MEDIA_RETENTION_MS = 14 * DAY;
/** Files cleared per run; one R2 batch delete covers them all. */
export const MEDIA_PURGE_BATCH = 200;
/** Up to when the purge has looked, in `app_settings` (epoch ms). */
export const MEDIA_PURGE_SETTING = 'media_purged_through';
/** Rows a run looks back past its mark, for a slow write that landed late. */
const PURGE_OVERLAP_MS = DAY;

export type MediaPurgeResult = { files: number; drafts: number };

/**
 * Clear the uploaded files of posts that finished publishing more than
 * PUBLISHED_MEDIA_RETENTION_MS ago: R2 objects first, then their rows (a
 * crash in between leaves a row that is cleared next run, never orphaned
 * bytes). A post with any delivery still open, failed or touched since the
 * cutoff keeps its files, so Retry always has them.
 *
 * Runs hourly with the janitors. It scans only from a stored mark through the
 * publish index, so each run reads about an hour of published deliveries, not
 * the whole history.
 */
export async function purgePublishedMedia(
	db: AppDb,
	store: MediaStore,
	opts: { now?: number; budget?: SubrequestBudget | null } = {}
): Promise<MediaPurgeResult> {
	const now = opts.now ?? Date.now();
	const budget = opts.budget ?? null;
	const result: MediaPurgeResult = { files: 0, drafts: 0 };
	// A select, a batch delete, a row delete and the mark.
	if (budget && budget.remaining < 4) return result;
	const cutoff = now - PUBLISHED_MEDIA_RETENTION_MS;
	const mark = Number(await readAppSetting(db, MEDIA_PURGE_SETTING));
	const markOk = Number.isFinite(mark) && mark > 0 && mark <= cutoff;
	const from = markOk ? mark - PURGE_OVERLAP_MS : 0;
	const rows =
		(await db.all(sql`SELECT dm.id AS id, dm.storage_key AS storageKey, dm.draft_id AS draftId
		FROM draft_media dm
		WHERE dm.draft_id IN (
			SELECT pt.draft_id FROM publish_targets pt
			WHERE pt.status = 'published' AND pt.updated_at >= ${from} AND pt.updated_at < ${cutoff}
		)
		AND EXISTS (SELECT 1 FROM drafts d WHERE d.id = dm.draft_id AND d.status = 'published')
		AND NOT EXISTS (
			SELECT 1 FROM publish_targets p2
			WHERE p2.draft_id = dm.draft_id
				AND (p2.updated_at >= ${cutoff} OR p2.status IN ('scheduled', 'pending', 'publishing', 'awaiting_review', 'failed'))
		)
		LIMIT ${MEDIA_PURGE_BATCH}`)) as { id: string; storageKey: string; draftId: string }[];
	if (rows.length) {
		await deleteMediaObjects(
			store,
			rows.map((r) => r.storageKey)
		);
		await db.delete(draftMedia).where(
			inArray(
				draftMedia.id,
				rows.map((r) => r.id)
			)
		);
		result.files = rows.length;
		result.drafts = new Set(rows.map((r) => r.draftId)).size;
		if (budget) budget.count(2);
	}
	// A full batch may have left files in this range: keep the mark so the next
	// run looks again from the same place.
	if (rows.length < MEDIA_PURGE_BATCH) {
		await writeAppSetting(db, MEDIA_PURGE_SETTING, String(cutoff));
	}
	return result;
}
