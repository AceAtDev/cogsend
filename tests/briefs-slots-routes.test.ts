import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { SessionUser } from '#lib/server/auth.js';
import { newId, type AppDb } from '#lib/server/db/client.js';
import {
	brandBriefs,
	brands,
	connections,
	drafts,
	postingSchedules,
	publishTargets
} from '#lib/server/db/schema.js';
import { createTestAdmin, createTestDb, TEST_ENV } from '#lib/server/db/test.js';
import * as briefRoute from '../src/routes/api/brands/[id]/brief/+server';
import * as slotsRoute from '../src/routes/api/connections/[id]/slots/+server';
import * as brandPage from '../src/routes/accounts/[slug]/+page.server';
import * as calendarPage from '../src/routes/calendar/+page.server';

const NOW = new Date('2026-11-02T06:00:00.000Z');

let db: AppDb;
let close: () => void;
let user: SessionUser;
let brandId: string;
let linkedin: string;
let loose: string;

type Handler = (event: never) => Promise<Response> | Response;

function call(
	handler: Handler,
	params: Record<string, string>,
	opts: { method?: string; body?: unknown; scopes?: string[] | null } = {}
) {
	const url = new URL('https://cogsend.example/api/x');
	return handler({
		request: new Request(url, {
			method: opts.method ?? 'GET',
			headers: { 'content-type': 'application/json' },
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
		}),
		params,
		url,
		locals: {
			db,
			env: TEST_ENV,
			user,
			authMethod: opts.scopes ? 'bearer' : 'session',
			apiKeyScopes: opts.scopes ?? null
		}
	} as never);
}

async function channel(platform: string, brand: string | null) {
	const id = newId();
	await db.insert(connections).values({
		id,
		userId: user.id,
		platform,
		handle: `${platform}-handle`,
		credentialsEncrypted: '{}',
		metaJson: '{}',
		status: 'active',
		brandId: brand,
		createdAt: NOW,
		updatedAt: NOW
	});
	return id;
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	({ db, close } = await createTestDb());
	const row = await createTestAdmin(db, { totpEnabled: true });
	user = {
		id: row.id,
		email: row.email,
		timezone: 'Europe/Berlin',
		totpEnabled: true,
		mfaVerified: true,
		role: 'admin'
	};
	brandId = newId();
	await db.insert(brands).values({
		id: brandId,
		userId: user.id,
		name: 'JobJob',
		slug: 'jobjob',
		color: '#2563eb',
		createdAt: NOW,
		updatedAt: NOW
	});
	linkedin = await channel('linkedin', brandId);
	loose = await channel('bluesky', null);
});

afterEach(() => {
	close();
	vi.useRealTimers();
});

describe('brief REST route', () => {
	it('saves, reads back and clears a brief', async () => {
		const empty = await (await call(briefRoute.GET, { id: brandId })).json();
		expect(empty.brief).toMatchObject({ sections: {}, platformNotes: {}, updatedAt: null });
		const saved = await call(
			briefRoute.PUT,
			{ id: brandId },
			{
				method: 'PUT',
				body: { sections: { voice: 'Plain.' }, platformNotes: { linkedin: 'No emoji.' } }
			}
		);
		expect(saved.status).toBe(200);
		const read = await (await call(briefRoute.GET, { id: brandId })).json();
		expect(read).toMatchObject({
			brand: { slug: 'jobjob' },
			brief: { sections: { voice: 'Plain.' }, platformNotes: { linkedin: 'No emoji.' } }
		});
		await call(
			briefRoute.PUT,
			{ id: brandId },
			{ method: 'PUT', body: { sections: { voice: ' ' } } }
		);
		expect(await db.select().from(brandBriefs)).toEqual([]);
	});

	it('refuses an invalid brief, an unknown brand and a read-only key', async () => {
		const bad = await call(
			briefRoute.PUT,
			{ id: brandId },
			{
				method: 'PUT',
				body: { sections: { tone: 'x' } }
			}
		);
		expect(bad.status).toBe(400);
		expect((await bad.json()).error).toMatch(/not a section/);
		expect((await call(briefRoute.GET, { id: 'nope' })).status).toBe(404);
		const readOnly = await call(
			briefRoute.PUT,
			{ id: brandId },
			{
				method: 'PUT',
				body: { sections: { voice: 'x' } },
				scopes: ['read']
			}
		);
		expect(readOnly.status).toBe(403);
	});

	it('goes with its brand when the brand is deleted', async () => {
		await call(
			briefRoute.PUT,
			{ id: brandId },
			{ method: 'PUT', body: { sections: { voice: 'x' } } }
		);
		await db.delete(brands).where(eq(brands.id, brandId));
		expect(await db.select().from(brandBriefs)).toEqual([]);
	});
});

describe('slots REST route', () => {
	it('saves normalised slots and limits, and clears them', async () => {
		const res = await call(
			slotsRoute.PUT,
			{ id: linkedin },
			{
				method: 'PUT',
				body: { slots: { mon: ['18:00', '09:00'] }, maxPerDay: 2, minGapMinutes: null }
			}
		);
		expect(res.status).toBe(200);
		expect((await res.json()).rules).toEqual({
			slots: { mon: ['09:00', '18:00'] },
			maxPerDay: 2,
			minGapMinutes: null
		});
		const read = await (await call(slotsRoute.GET, { id: linkedin })).json();
		expect(read.rules.slots).toEqual({ mon: ['09:00', '18:00'] });
		await call(slotsRoute.PUT, { id: linkedin }, { method: 'PUT', body: { slots: {} } });
		expect(await db.select().from(postingSchedules)).toEqual([]);
	});

	it('refuses bad times and unknown accounts', async () => {
		const bad = await call(
			slotsRoute.PUT,
			{ id: linkedin },
			{
				method: 'PUT',
				body: { slots: { mon: ['9am'] } }
			}
		);
		expect(bad.status).toBe(400);
		expect((await call(slotsRoute.PUT, { id: 'nope' }, { method: 'PUT', body: {} })).status).toBe(
			404
		);
	});
});

describe('brand settings page', () => {
	it('loads the brief, the brand’s accounts with their rules and next open slots', async () => {
		await call(
			briefRoute.PUT,
			{ id: brandId },
			{ method: 'PUT', body: { sections: { voice: 'Plain.' } } }
		);
		await call(
			slotsRoute.PUT,
			{ id: linkedin },
			{
				method: 'PUT',
				body: { slots: { mon: ['09:00', '18:00'], tue: ['09:00'] } }
			}
		);
		const loaded = (await brandPage.load({
			locals: { db, user },
			params: { slug: 'jobjob' }
		} as never)) as Record<string, unknown> & {
			channels: Array<{ connectionId: string; nextOpen: number[] }>;
		};
		expect(loaded.brand).toMatchObject({ name: 'JobJob', slug: 'jobjob' });
		expect(loaded.brief).toMatchObject({ sections: { voice: 'Plain.' } });
		expect(loaded.timeZone).toBe('Europe/Berlin');
		expect(loaded.channels.map((c) => c.connectionId)).toEqual([linkedin]);
		expect(loaded.channels[0].nextOpen.map((ms) => new Date(ms).toISOString())).toEqual([
			'2026-11-02T08:00:00.000Z',
			'2026-11-02T17:00:00.000Z',
			'2026-11-03T08:00:00.000Z'
		]);
	});

	it('loads unbranded accounts without a brief, and 404s an unknown brand', async () => {
		const loaded = (await brandPage.load({
			locals: { db, user },
			params: { slug: 'unbranded' }
		} as never)) as Record<string, unknown> & { channels: Array<{ connectionId: string }> };
		expect(loaded.brief).toBeNull();
		expect(loaded.channels.map((c) => c.connectionId)).toEqual([loose]);
		await expect(
			brandPage.load({ locals: { db, user }, params: { slug: 'nope' } } as never)
		).rejects.toMatchObject({ status: 404 });
	});
});

describe('calendar open slots', () => {
	it('shows future open slots in the visible week, leaving out taken ones and filtered channels', async () => {
		await call(
			slotsRoute.PUT,
			{ id: linkedin },
			{
				method: 'PUT',
				body: { slots: { mon: ['05:00', '09:00', '18:00'] } }
			}
		);
		const draftId = newId();
		await db.insert(drafts).values({
			id: draftId,
			userId: user.id,
			baseBody: 'x',
			status: 'scheduled',
			createdAt: NOW,
			updatedAt: NOW
		});
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId: linkedin,
			status: 'scheduled',
			scheduledFor: new Date('2026-11-02T17:00:00.000Z'),
			createdAt: NOW,
			updatedAt: NOW
		});
		const load = (search: string) =>
			calendarPage.load({
				locals: { db, env: TEST_ENV, user },
				url: new URL(`https://cogsend.example/calendar?view=week&date=2026-11-02${search}`)
			} as never) as Promise<{ openSlots: Array<{ connectionId: string; at: number }> }>;
		const week = await load('');
		// 05:00 has passed (it is 07:00), 18:00 is taken: only 09:00 is open.
		expect(week.openSlots.map((s) => [s.connectionId, new Date(s.at).toISOString()])).toEqual([
			[linkedin, '2026-11-02T08:00:00.000Z']
		]);
		const filtered = await load('&channel=unbranded.bluesky');
		expect(filtered.openSlots).toEqual([]);
	});
});
