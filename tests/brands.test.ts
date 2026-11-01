import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import {
	assignChannelKeys,
	handleSlug,
	resolveChannelRef,
	slugify,
	type BrandRef,
	type ChannelSource
} from '#lib/domain/channel-keys.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import { brands, connections } from '#lib/server/db/schema.js';
import { ensureSchema, INIT_SQL } from '#lib/server/db/init-sql.js';
import { GET as brandsGET, POST as brandsPOST } from '../src/routes/api/brands/+server';
import { DELETE as brandDELETE, PATCH as brandPATCH } from '../src/routes/api/brands/[id]/+server';
import { PATCH as connectionPATCH } from '../src/routes/api/connections/[id]/+server';
import { GET as connectionsGET } from '../src/routes/api/connections/+server';

const jobjob: BrandRef = { id: 'b-job', name: 'JobJob', slug: 'jobjob', color: '#2563eb' };
const cal: BrandRef = { id: 'b-cal', name: '465Cal', slug: '465cal', color: '#db2777' };

function source(overrides: Partial<ChannelSource> & { id: string }): ChannelSource {
	return {
		platform: 'instagram',
		handle: null,
		displayName: null,
		status: 'active',
		brandId: null,
		createdAt: 0,
		...overrides
	};
}

describe('channel keys', () => {
	const sources = [
		source({ id: 'c1', platform: 'linkedin', handle: 'jobjob', brandId: 'b-job', createdAt: 1 }),
		source({
			id: 'c2',
			platform: 'instagram',
			handle: 'jobjob.hq',
			brandId: 'b-job',
			createdAt: 2
		}),
		source({ id: 'c3', platform: 'tiktok', handle: '465cal', brandId: 'b-cal', createdAt: 3 }),
		source({ id: 'c4', platform: 'instagram', handle: '465cal', brandId: 'b-cal', createdAt: 4 }),
		source({ id: 'c5', platform: 'bluesky', handle: 'me.bsky.social', createdAt: 5 })
	];
	const channels = assignChannelKeys([jobjob, cal], sources);
	const resolve = (ref: Parameters<typeof resolveChannelRef>[0]) =>
		resolveChannelRef(ref, channels, [jobjob, cal]);

	it('names each account <brand>.<platform> and accepts the long form too', () => {
		const byId = Object.fromEntries(channels.map((c) => [c.connectionId, c]));
		expect(byId.c1.key).toBe('jobjob.linkedin');
		expect(byId.c2.keys).toEqual(['jobjob.instagram', 'jobjob.instagram.jobjob-hq']);
		expect(byId.c4.key).toBe('465cal.instagram');
		expect(byId.c5.key).toBe('unbranded.bluesky');
		expect(byId.c5.keys).toContain('unbranded.bluesky.me-bsky-social');
	});

	it('refuses a bare platform when two brands post there, listing both', () => {
		const result = resolve('instagram');
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('ambiguous');
		expect(result.candidates.map((c) => c.key).sort()).toEqual([
			'465cal.instagram',
			'jobjob.instagram'
		]);
	});

	it('resolves exact keys, ids and {brand, platform} by slug or by name', () => {
		const pick = (ref: Parameters<typeof resolveChannelRef>[0]) => {
			const result = resolve(ref);
			return result.ok ? result.channel.connectionId : result.reason;
		};
		expect(pick('jobjob.instagram')).toBe('c2');
		expect(pick('JobJob.Instagram')).toBe('c2');
		expect(pick('465cal.instagram')).toBe('c4');
		expect(pick('c4')).toBe('c4');
		expect(pick({ brand: '465Cal', platform: 'instagram' })).toBe('c4');
		expect(pick({ brand: 'jobjob', platform: 'instagram', handle: '@jobjob.hq' })).toBe('c2');
		expect(pick('jobjob.tiktok')).toBe('unknown');
		expect(pick('jobjob.instagra')).toBe('unknown');
		expect(pick('jobjob')).toBe('ambiguous');
	});

	it('makes the short key ambiguous once a brand has two accounts on a platform', () => {
		const twin = assignChannelKeys(
			[jobjob],
			[
				source({ id: 'a1', handle: 'jobjob', brandId: 'b-job', createdAt: 1 }),
				source({ id: 'a2', handle: 'jobjob_careers', brandId: 'b-job', createdAt: 2 })
			]
		);
		expect(twin.map((c) => c.key).sort()).toEqual([
			'jobjob.instagram.jobjob',
			'jobjob.instagram.jobjob-careers'
		]);
		const result = resolveChannelRef('jobjob.instagram', twin, [jobjob]);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.candidates).toHaveLength(2);
	});

	it('keeps accounts whose handles slug the same apart, deterministically', () => {
		const make = () =>
			assignChannelKeys(
				[],
				[
					source({ id: 'zz9999', handle: 'pat.dev', createdAt: 2 }),
					source({ id: 'aa1111', handle: 'pat-dev', createdAt: 1 })
				]
			);
		const keys = make().map((c) => c.key);
		expect(keys).toEqual(['unbranded.instagram.pat-dev', 'unbranded.instagram.pat-dev-zz9999']);
		expect(make().map((c) => c.key)).toEqual(keys);
	});

	it('refuses an inactive account and suggests the active ones', () => {
		const list = assignChannelKeys(
			[jobjob],
			[
				source({ id: 'x1', status: 'expired', brandId: 'b-job', handle: 'old' }),
				source({ id: 'x2', platform: 'linkedin', brandId: 'b-job', handle: 'li' })
			]
		);
		const result = resolveChannelRef('jobjob.instagram', list, [jobjob]);
		expect(result).toMatchObject({ ok: false, reason: 'inactive' });
		expect(resolveChannelRef('jobjob.instagram', list, [jobjob], { requireActive: false }).ok).toBe(
			true
		);
	});

	it('slugs names and handles safely', () => {
		expect(slugify('465Cal')).toBe('465cal');
		expect(slugify('  Crème Brûlée & Co ')).toBe('creme-brulee-co');
		expect(handleSlug('@Pat@mastodon.social', 'id')).toBe('pat-mastodon-social');
		expect(handleSlug(null, 'ABCDEF123456')).toBe('abcdef12');
	});
});

describe('brands API', () => {
	let db: AppDb;
	let close: () => void;
	let user: {
		id: string;
		email: string;
		timezone: string;
		totpEnabled: boolean;
		mfaVerified: boolean;
	};

	beforeEach(async () => {
		const t = await createTestDb();
		db = t.db;
		close = t.close;
		const row = await createTestAdmin(db, { totpEnabled: true });
		user = { id: row.id, email: row.email, timezone: 'UTC', totpEnabled: true, mfaVerified: true };
	});
	afterEach(() => close());

	function event(
		init: { body?: unknown; params?: Record<string, string>; method?: string } = {},
		auth: { scopes?: string[] | null; method?: 'session' | 'bearer' } = {}
	) {
		const request = new Request('https://cogsend.example/api/brands', {
			method: init.method ?? 'POST',
			headers: { 'content-type': 'application/json' },
			body: init.body === undefined ? undefined : JSON.stringify(init.body)
		});
		return {
			request,
			params: init.params ?? {},
			url: new URL(request.url),
			locals: {
				user,
				db,
				env: TEST_ENV,
				authMethod: auth.method ?? 'session',
				apiKeyScopes: auth.scopes ?? null
			}
		} as never;
	}

	async function addConnection(platform: string, handle: string) {
		const id = newId();
		const now = new Date();
		await db.insert(connections).values({
			id,
			userId: user.id,
			platform,
			handle,
			credentialsEncrypted: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	it('creates, renames without changing the slug, recolours and deletes a brand', async () => {
		const created = await brandsPOST(event({ body: { name: 'JobJob' } }));
		expect(created.status).toBe(201);
		const { brand } = await created.json();
		expect(brand).toMatchObject({ name: 'JobJob', slug: 'jobjob' });
		expect(brand.color).toMatch(/^#[0-9a-f]{6}$/);

		const second = await (await brandsPOST(event({ body: { name: 'jobjob!' } }))).json();
		expect(second.brand.slug).toBe('jobjob-2');

		const renamed = await brandPATCH(
			event({
				method: 'PATCH',
				params: { id: brand.id },
				body: { name: 'Job Job', color: '#00AA11' }
			})
		);
		expect(await renamed.json()).toMatchObject({
			brand: { name: 'Job Job', slug: 'jobjob', color: '#00aa11' }
		});

		const taken = await brandPATCH(
			event({ method: 'PATCH', params: { id: second.brand.id }, body: { slug: 'jobjob' } })
		);
		expect(taken.status).toBe(409);
		const reserved = await brandsPOST(event({ body: { name: 'x', slug: 'unbranded' } }));
		expect(reserved.status).toBe(400);
		const badColor = await brandsPOST(event({ body: { name: 'y', color: 'red' } }));
		expect(badColor.status).toBe(400);

		const connId = await addConnection('linkedin', 'jobjob');
		const assigned = await connectionPATCH(
			event({ method: 'PATCH', params: { id: connId }, body: { brandId: brand.id } })
		);
		expect(await assigned.json()).toMatchObject({ channel: { key: 'jobjob.linkedin' } });

		const listed = await (await brandsGET(event({ method: 'GET' }))).json();
		expect(listed.brands.find((b: { id: string }) => b.id === brand.id).channels).toEqual([
			expect.objectContaining({ connectionId: connId, key: 'jobjob.linkedin' })
		]);

		const deleted = await brandDELETE(event({ method: 'DELETE', params: { id: brand.id } }));
		expect(await deleted.json()).toEqual({ ok: true, unbranded: 1 });
		const [row] = await db.select().from(connections).where(eq(connections.id, connId));
		expect(row.brandId).toBeNull();
		const after = await (await connectionsGET(event({ method: 'GET' }))).json();
		expect(after.connections[0]).toMatchObject({ brandId: null, channelKey: 'unbranded.linkedin' });
	});

	it('keeps brands per user and enforces key scopes', async () => {
		const readOnly = await brandsPOST(
			event({ body: { name: 'Nope' } }, { scopes: ['read'], method: 'bearer' })
		);
		expect(readOnly.status).toBe(403);
		const listed = await brandsGET(
			event({ method: 'GET' }, { scopes: ['read'], method: 'bearer' })
		);
		expect(listed.status).toBe(200);
		const viaKey = await brandsPOST(
			event({ body: { name: 'Keyed' } }, { scopes: ['read', 'write'], method: 'bearer' })
		);
		expect(viaKey.status).toBe(201);
		const { brand } = await viaKey.json();

		const connId = await addConnection('instagram', 'keyed');
		// Re-pointing an account's key stays in the browser session.
		const assign = await connectionPATCH(
			event(
				{ method: 'PATCH', params: { id: connId }, body: { brandId: brand.id } },
				{ scopes: ['read', 'write'], method: 'bearer' }
			)
		);
		expect(assign.status).toBe(401);

		const other = await createTestAdmin(db, { email: 'other@localhost' });
		const now = new Date();
		await db.insert(brands).values({
			id: 'foreign',
			userId: other.id,
			name: 'Theirs',
			slug: 'theirs',
			color: '#000000',
			createdAt: now,
			updatedAt: now
		});
		const foreign = await brandPATCH(
			event({ method: 'PATCH', params: { id: 'foreign' }, body: { name: 'Mine' } })
		);
		expect(foreign.status).toBe(404);
		const foreignAssign = await connectionPATCH(
			event({ method: 'PATCH', params: { id: connId }, body: { brandId: 'foreign' } })
		);
		expect(foreignAssign.status).toBe(404);
	});
});

describe('brands on an existing database', () => {
	it('adds the table and the column to a database bootstrapped before them', async () => {
		const client = createClient({ url: ':memory:' });
		const older = INIT_SQL.replace(/CREATE TABLE IF NOT EXISTS `brand_briefs`[\s\S]*?;\n/, '')
			.replace(/CREATE INDEX IF NOT EXISTS `brand_briefs_user_idx`[^;]*;/, '')
			.replace(/CREATE TABLE IF NOT EXISTS `brands`[\s\S]*?;\n/, '')
			.replace(/CREATE UNIQUE INDEX IF NOT EXISTS `brands_user_slug_uq`[^;]*;/, '')
			.replace(/CREATE INDEX IF NOT EXISTS `connections_brand_idx`[^;]*;/, '')
			.replace(/\t`brand_id` text,\n/, '')
			.replace(/,\n\tFOREIGN KEY \(`brand_id`\)[^\n]*/, '');
		expect(older).not.toContain('brand');
		await client.executeMultiple(older);
		const binding = {
			exec: (sql: string) => client.executeMultiple(sql),
			prepare: (sql: string) => {
				const stmt = (args: unknown[] = []) => ({
					run: () => client.execute({ sql, args: args as never }),
					all: async () => ({ results: (await client.execute({ sql, args: args as never })).rows }),
					first: async () => (await client.execute({ sql, args: args as never })).rows[0] ?? null,
					bind: (...next: unknown[]) => stmt(next)
				});
				return stmt();
			}
		} as unknown as D1Database;
		await ensureSchema(binding);
		const cols = (await client.execute('PRAGMA table_info(connections)')).rows.map((r) =>
			String((r as unknown as { name: string }).name)
		);
		expect(cols).toContain('brand_id');
		const tables = (
			await client.execute("SELECT name FROM sqlite_master WHERE type='table'")
		).rows.map((r) => String((r as unknown as { name: string }).name));
		expect(tables).toContain('brands');
		expect(tables).toContain('brand_briefs');
		client.close();
	});
});
