import { and, eq } from 'drizzle-orm';
import {
	briefFromStored,
	EMPTY_BRIEF,
	isBriefEmpty,
	parseBrief,
	type BrandBrief
} from '#lib/domain/brand-brief.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import type { AppDb } from '#lib/server/db/client.js';
import { first } from '#lib/server/db/client.js';
import { brandBriefs, brands } from '#lib/server/db/schema.js';

export interface StoredBrief extends BrandBrief {
	updatedAt: number | null;
}

function toStored(row: typeof brandBriefs.$inferSelect | undefined): StoredBrief {
	if (!row) return { ...EMPTY_BRIEF, updatedAt: null };
	return {
		...briefFromStored(row.sectionsJson, row.platformNotesJson),
		updatedAt: row.updatedAt.getTime()
	};
}

async function ownedBrand(db: AppDb, userId: string, brandId: string) {
	const row = await first(
		db
			.select()
			.from(brands)
			.where(and(eq(brands.id, brandId), eq(brands.userId, userId)))
	);
	if (!row) throw new ApiOperationError('Not found', 404);
	return row;
}

/** Every brief of the user's brands, keyed by brand id. */
export async function loadBriefs(db: AppDb, userId: string): Promise<Map<string, StoredBrief>> {
	const rows = await db.select().from(brandBriefs).where(eq(brandBriefs.userId, userId));
	return new Map(rows.map((row) => [row.brandId, toStored(row)]));
}

export async function getBrief(db: AppDb, userId: string, brandId: string) {
	const brand = await ownedBrand(db, userId, brandId);
	const row = await first(
		db
			.select()
			.from(brandBriefs)
			.where(and(eq(brandBriefs.brandId, brandId), eq(brandBriefs.userId, userId)))
	);
	return { brand: { id: brand.id, name: brand.name, slug: brand.slug }, brief: toStored(row) };
}

/** Replaces the whole brief; an empty one removes the row. */
export async function saveBrief(db: AppDb, userId: string, brandId: string, input: unknown) {
	const brand = await ownedBrand(db, userId, brandId);
	const parsed = parseBrief(input);
	if (!parsed.ok) throw new ApiOperationError(parsed.error, 400);
	const now = new Date();
	if (isBriefEmpty(parsed.brief)) {
		await db
			.delete(brandBriefs)
			.where(and(eq(brandBriefs.brandId, brandId), eq(brandBriefs.userId, userId)));
		return {
			brand: { id: brand.id, name: brand.name, slug: brand.slug },
			brief: { ...EMPTY_BRIEF, updatedAt: null } as StoredBrief
		};
	}
	const values = {
		sectionsJson: JSON.stringify(parsed.brief.sections),
		platformNotesJson: JSON.stringify(parsed.brief.platformNotes),
		updatedAt: now
	};
	await db
		.insert(brandBriefs)
		.values({ brandId, userId, ...values })
		.onConflictDoUpdate({ target: brandBriefs.brandId, set: values });
	return {
		brand: { id: brand.id, name: brand.name, slug: brand.slug },
		brief: { ...parsed.brief, updatedAt: now.getTime() } as StoredBrief
	};
}
