import { and, asc, eq, ne } from 'drizzle-orm';
import {
	assignChannelKeys,
	BRAND_COLORS,
	isBrandColor,
	isBrandSlug,
	MAX_BRAND_NAME,
	slugify,
	UNBRANDED_SLUG,
	type BrandRef,
	type Channel
} from '#lib/domain/channel-keys.js';
import { ApiOperationError } from '#lib/server/api/operation-error.js';
import type { AppDb } from '#lib/server/db/client.js';
import { first, newId } from '#lib/server/db/client.js';
import { brands, connections } from '#lib/server/db/schema.js';

export type BrandRow = typeof brands.$inferSelect;

function invalid(message: string, status = 400): never {
	throw new ApiOperationError(message, status);
}

export function serializeBrand(row: BrandRow) {
	return {
		id: row.id,
		name: row.name,
		slug: row.slug,
		color: row.color,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

export async function listBrandRows(db: AppDb, userId: string): Promise<BrandRow[]> {
	return db
		.select()
		.from(brands)
		.where(eq(brands.userId, userId))
		.orderBy(asc(brands.name), asc(brands.id));
}

/**
 * Every account that can still be addressed, with its keys. Disconnected
 * tombstones are left out (see assignChannelKeys).
 */
export async function loadChannels(
	db: AppDb,
	userId: string
): Promise<{ brands: BrandRef[]; channels: Channel[] }> {
	const [brandRows, rows] = await Promise.all([
		listBrandRows(db, userId),
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
			.where(and(eq(connections.userId, userId), ne(connections.status, 'disconnected')))
	]);
	const refs = brandRows.map(({ id, name, slug, color }) => ({ id, name, slug, color }));
	return { brands: refs, channels: assignChannelKeys(refs, rows) };
}

function parseName(raw: unknown): string {
	if (typeof raw !== 'string') invalid('name must be a string');
	const name = raw.trim().replace(/\s+/g, ' ');
	if (!name) invalid('name is required');
	if (name.length > MAX_BRAND_NAME) invalid(`name must be ${MAX_BRAND_NAME} characters or fewer`);
	return name;
}

function parseColor(raw: unknown): string {
	if (!isBrandColor(raw)) invalid('color must be a hex colour like #2563eb');
	return raw.toLowerCase();
}

function parseSlug(raw: unknown): string {
	if (raw === UNBRANDED_SLUG) invalid(`"${UNBRANDED_SLUG}" is reserved for accounts with no brand`);
	if (!isBrandSlug(raw))
		invalid('slug must be lowercase letters, digits and single dashes, at most 32 characters');
	return raw;
}

async function slugTaken(db: AppDb, userId: string, slug: string, exceptId?: string) {
	const row = await first(
		db
			.select({ id: brands.id })
			.from(brands)
			.where(and(eq(brands.userId, userId), eq(brands.slug, slug)))
	);
	return Boolean(row && row.id !== exceptId);
}

export async function createBrand(db: AppDb, userId: string, input: unknown) {
	if (!input || typeof input !== 'object') invalid('Invalid JSON body');
	const body = input as Record<string, unknown>;
	const name = parseName(body.name);
	const existing = await listBrandRows(db, userId);
	const color =
		body.color === undefined
			? BRAND_COLORS[existing.length % BRAND_COLORS.length]
			: parseColor(body.color);
	let slug: string;
	if (body.slug !== undefined) {
		slug = parseSlug(body.slug);
		if (existing.some((row) => row.slug === slug)) invalid(`A brand already uses "${slug}"`, 409);
	} else {
		const base = slugify(name) || 'brand';
		const root = base === UNBRANDED_SLUG ? 'brand-unbranded' : base;
		slug = root;
		for (let n = 2; existing.some((row) => row.slug === slug); n++) {
			slug = `${root.slice(0, 28)}-${n}`;
		}
	}
	const now = new Date();
	const [row] = await db
		.insert(brands)
		.values({ id: newId(), userId, name, slug, color, createdAt: now, updatedAt: now })
		.returning();
	return { brand: serializeBrand(row) };
}

export async function updateBrand(db: AppDb, userId: string, id: string, input: unknown) {
	const row = await first(
		db
			.select()
			.from(brands)
			.where(and(eq(brands.id, id), eq(brands.userId, userId)))
	);
	if (!row) invalid('Not found', 404);
	if (!input || typeof input !== 'object') invalid('Invalid JSON body');
	const body = input as Record<string, unknown>;
	const patch: Partial<Pick<BrandRow, 'name' | 'slug' | 'color'>> = {};
	if (body.name !== undefined) patch.name = parseName(body.name);
	if (body.color !== undefined) patch.color = parseColor(body.color);
	// Changing the slug renames every channel key of the brand, so it is never
	// a side effect of a rename: only an explicit `slug` changes it.
	if (body.slug !== undefined) {
		patch.slug = parseSlug(body.slug);
		if (await slugTaken(db, userId, patch.slug, id))
			invalid(`A brand already uses "${patch.slug}"`, 409);
	}
	if (!Object.keys(patch).length) invalid('Send name, color or slug');
	const [updated] = await db
		.update(brands)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(brands.id, id))
		.returning();
	return { brand: serializeBrand(updated) };
}

/** Its accounts stay connected and become unbranded. */
export async function deleteBrand(db: AppDb, userId: string, id: string) {
	const row = await first(
		db
			.select({ id: brands.id })
			.from(brands)
			.where(and(eq(brands.id, id), eq(brands.userId, userId)))
	);
	if (!row) invalid('Not found', 404);
	// Explicit rather than trusting ON DELETE SET NULL: foreign keys are only
	// best-effort on D1 (see db/init-sql.ts).
	const released = await db
		.update(connections)
		.set({ brandId: null, updatedAt: new Date() })
		.where(and(eq(connections.userId, userId), eq(connections.brandId, id)))
		.returning({ id: connections.id });
	await db.delete(brands).where(eq(brands.id, id));
	return { ok: true as const, unbranded: released.length };
}

/** `null` takes the account out of its brand. */
export async function assignConnectionBrand(
	db: AppDb,
	userId: string,
	connectionId: string,
	brandId: unknown
) {
	if (brandId !== null && typeof brandId !== 'string') invalid('brandId must be a string or null');
	const conn = await first(
		db
			.select({ id: connections.id })
			.from(connections)
			.where(and(eq(connections.id, connectionId), eq(connections.userId, userId)))
	);
	if (!conn) invalid('Not found', 404);
	if (brandId !== null) {
		const brand = await first(
			db
				.select({ id: brands.id })
				.from(brands)
				.where(and(eq(brands.id, brandId), eq(brands.userId, userId)))
		);
		if (!brand) invalid('Brand not found', 404);
	}
	await db
		.update(connections)
		.set({ brandId, updatedAt: new Date() })
		.where(eq(connections.id, connectionId));
	const { channels } = await loadChannels(db, userId);
	return { channel: channels.find((c) => c.connectionId === connectionId) ?? null };
}

/** The brands with their channels, plus the unbranded ones, for the API and the UI. */
export async function brandDirectory(db: AppDb, userId: string) {
	const [rows, { channels }] = await Promise.all([
		listBrandRows(db, userId),
		loadChannels(db, userId)
	]);
	return {
		brands: rows.map((row) => ({
			...serializeBrand(row),
			channels: channels.filter((c) => c.brand.id === row.id)
		})),
		unbranded: channels.filter((c) => c.brand.id === null)
	};
}
