import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Client } from '@modelcontextprotocol/client';
import { connections, mcpConfirmations, publishTargets } from '#lib/server/db/schema.js';
import { createMcpHarness, data, inHours, text } from './mcp-harness';

/**
 * Agent traps. Each case is a request an agent could plausibly make that, if
 * the server guessed, would post on the wrong account: a bare platform shared
 * by two brands, a typo, look-alike handles, an expired account, a key that
 * changed meaning between preview and commit. The invariant is the same for
 * all of them: every delivery that exists afterwards is on an account the
 * request named exactly, and an unclear request writes nothing.
 */

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let agent: Client;
let ch: Record<string, string>;
let jobjob: string;
let cal: string;

const JPEG = Buffer.from(
	new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1])
).toString('base64');

beforeEach(async () => {
	h = await createMcpHarness({ timezone: 'America/New_York' });
	jobjob = await h.brand('JobJob', 'jobjob');
	cal = await h.brand('465Cal', '465cal');
	ch = {
		jobjobLinkedin: await h.channel('linkedin', 'jobjob', jobjob),
		jobjobInstagram: await h.channel('instagram', 'jobjob.hq', jobjob),
		calTiktok: await h.channel('tiktok', '465cal', cal),
		calInstagram: await h.channel('instagram', '465cal', cal),
		patDot: await h.channel('bluesky', 'pat.dev', null),
		patDash: await h.channel('bluesky', 'pat-dev', null)
	};
	agent = await h.connect();
});

afterEach(async () => {
	await h.close();
});

const call = (name: string, args: Record<string, unknown>) =>
	agent.callTool({ name, arguments: args });

/** Every live delivery is on one of the accounts the request named. */
async function expectOnlyOn(allowed: string[]) {
	const rows = (await h.deliveries()).filter((d) => d.status !== 'cancelled');
	const wrong = rows.filter((d) => !allowed.includes(d.connectionId));
	expect(wrong, 'wrong-channel writes').toEqual([]);
	return rows;
}

async function stagedImageDraft() {
	return data(await call('attach_media', { base64: JPEG })).postId as string;
}

describe('agent traps: no write ever lands on a channel the request did not name', () => {
	it('"post to Instagram" with no brand is refused, listing both brands’ accounts', async () => {
		const draftId = await stagedImageDraft();
		const result = await call('schedule_posts', {
			posts: [{ channels: ['instagram'], draftId, runAt: inHours(30) }]
		});
		expect(result.isError).toBe(true);
		expect(data(result).unresolved[0]).toMatchObject({ reason: 'ambiguous' });
		const keys = data(result).unresolved[0].candidates.map((c: { key: string }) => c.key);
		expect(keys.sort()).toEqual(['465cal.instagram', 'jobjob.instagram']);
		expect(text(result)).toContain('@jobjob.hq');
		expect(text(result)).toContain('@465cal');
		await expectOnlyOn([]);
		expect(await h.db.select().from(mcpConfirmations)).toEqual([]);
	});

	it('never fuzzy-matches a typo, a swapped key, a brand alone or an unknown brand', async () => {
		for (const ref of [
			'jobjob.instagramm',
			'job-job.instagram',
			'jobjob.insta',
			'instagram.jobjob',
			'jobjob',
			'465',
			'jobjob.tiktok',
			{ brand: 'JobJob Inc', platform: 'instagram' }
		]) {
			const result = await call('schedule_posts', {
				posts: [{ channels: [ref], text: 'Hi', runAt: inHours(30) }]
			});
			expect(result.isError, JSON.stringify(ref)).toBe(true);
			expect(data(result).code, JSON.stringify(ref)).toBe('channel_unresolved');
		}
		await expectOnlyOn([]);
	});

	it('tells look-alike handles apart and refuses the short key they share', async () => {
		const shared = await call('schedule_posts', {
			posts: [{ channels: ['unbranded.bluesky'], text: 'Hi', runAt: inHours(30) }]
		});
		expect(data(shared).unresolved[0].reason).toBe('ambiguous');
		const exact = await call('schedule_posts', {
			posts: [
				{
					channels: [{ brand: 'unbranded', platform: 'bluesky', handle: '@pat-dev' }],
					text: 'For the dash one',
					runAt: inHours(30)
				}
			]
		});
		expect(exact.isError).toBeFalsy();
		expect(data(exact).posts[0].deliveries[0].channel.handle).toBe('@pat-dev');
		await expectOnlyOn([ch.patDash]);
		const listed = data(await call('list_channels', {}));
		const keys = listed.brands
			.find((b: { slug: string }) => b.slug === 'unbranded')
			.channels.map((c: { key: string; handle: string }) => `${c.key}=${c.handle}`);
		expect(keys).toEqual([
			'unbranded.bluesky.pat-dev=@pat.dev',
			expect.stringMatching(/^unbranded\.bluesky\.pat-dev-[a-z0-9]{6}=@pat-dev$/)
		]);
	});

	it('refuses an expired account instead of falling back to another on the platform', async () => {
		await h.db
			.update(connections)
			.set({ status: 'expired' })
			.where(eq(connections.id, ch.jobjobInstagram));
		const draftId = await stagedImageDraft();
		const result = await call('schedule_posts', {
			posts: [{ channels: ['jobjob.instagram'], draftId, runAt: inHours(30) }]
		});
		expect(data(result).unresolved[0]).toMatchObject({ reason: 'inactive' });
		expect(text(result)).toContain('expired');
		await expectOnlyOn([]);
	});

	it('cannot reuse a preview for a different channel', async () => {
		const draftId = await stagedImageDraft();
		const posts = [
			{ channels: ['jobjob.instagram', 'jobjob.linkedin'], draftId, runAt: inHours(30) }
		];
		const preview = data(await call('schedule_posts', { posts }));
		const swapped = await call('schedule_posts', {
			posts: [{ ...posts[0], channels: ['465cal.instagram', 'jobjob.linkedin'] }],
			confirmToken: preview.confirmToken
		});
		expect(data(swapped).code).toBe('confirm_payload_mismatch');
		await expectOnlyOn([]);
		await call('schedule_posts', { posts, confirmToken: preview.confirmToken });
		const rows = await expectOnlyOn([ch.jobjobInstagram, ch.jobjobLinkedin]);
		expect(rows).toHaveLength(2);
	});

	it('refuses a commit whose key changed meaning after the preview', async () => {
		const posts = [
			{ channels: ['jobjob.linkedin', 'unbranded.bluesky.pat-dev'], text: 'Hi', runAt: inHours(30) }
		];
		const preview = data(await call('schedule_posts', { posts }));
		expect(preview.status).toBe('confirmation_required');
		// The operator connects a second JobJob LinkedIn page in between.
		await h.channel('linkedin', 'jobjob-careers', jobjob);
		const stale = await call('schedule_posts', { posts, confirmToken: preview.confirmToken });
		expect(stale.isError).toBe(true);
		expect(data(stale).unresolved[0]).toMatchObject({ reason: 'ambiguous' });
		await expectOnlyOn([]);
	});

	it('refuses a commit after the key was re-pointed at another account', async () => {
		const draftId = await stagedImageDraft();
		const posts = [
			{ channels: ['jobjob.instagram', 'jobjob.linkedin'], draftId, runAt: inHours(30) }
		];
		const preview = data(await call('schedule_posts', { posts }));
		// jobjob's Instagram leaves the brand and 465Cal's joins it: the key now
		// names a different account, so the token must not carry over.
		await h.db
			.update(connections)
			.set({ brandId: null })
			.where(eq(connections.id, ch.jobjobInstagram));
		await h.db
			.update(connections)
			.set({ brandId: jobjob })
			.where(eq(connections.id, ch.calInstagram));
		const result = await call('schedule_posts', { posts, confirmToken: preview.confirmToken });
		expect(data(result).code).toBe('confirm_payload_mismatch');
		await expectOnlyOn([]);
	});

	it('refuses a variant aimed at a channel the post does not go to', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{
					channels: ['jobjob.linkedin'],
					text: 'Base',
					variants: [{ for: '465cal.instagram', text: 'Meant for Cal' }],
					runAt: inHours(30)
				}
			]
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('neither a platform nor one of this post');
		await expectOnlyOn([]);
	});

	it('refuses the same account named twice in one post', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{
					channels: ['jobjob.linkedin', ch.jobjobLinkedin],
					text: 'Twice?',
					runAt: inHours(30)
				}
			]
		});
		expect(text(result)).toContain('same channel');
		await expectOnlyOn([]);
	});

	it('does not reach another user’s account by id', async () => {
		const { createTestAdmin } = await import('#lib/server/db/test.js');
		const stranger = await createTestAdmin(h.db, { email: 'stranger@localhost' });
		const foreign = 'foreign-conn';
		const now = new Date();
		await h.db.insert(connections).values({
			id: foreign,
			userId: stranger.id,
			platform: 'linkedin',
			handle: 'stranger',
			credentialsEncrypted: '{}',
			status: 'active',
			createdAt: now,
			updatedAt: now
		});
		const result = await call('schedule_posts', {
			posts: [{ channels: [foreign], text: 'Hi', runAt: inHours(30) }]
		});
		expect(data(result).code).toBe('channel_unresolved');
		await expectOnlyOn([]);
	});

	it('moves only between the channels named, and never to an ambiguous one', async () => {
		const draftId = await stagedImageDraft();
		const first = data(
			await call('schedule_posts', {
				posts: [{ channels: ['jobjob.instagram'], draftId, runAt: inHours(30) }]
			})
		);
		const postId = first.posts[0].postIds[0];
		const vague = await call('move_post', {
			postId,
			from: ['jobjob.instagram'],
			to: ['instagram']
		});
		expect(data(vague).code).toBe('channel_unresolved');
		const same = await call('move_post', {
			postId,
			from: ['jobjob.instagram'],
			to: ['jobjob.instagram']
		});
		expect(same.isError).toBe(true);
		await expectOnlyOn([ch.jobjobInstagram]);

		const preview = data(
			await call('move_post', { postId, from: ['jobjob.instagram'], to: ['465cal.instagram'] })
		);
		// A token for one destination does not move it to another.
		const elsewhere = await call('move_post', {
			postId,
			from: ['jobjob.instagram'],
			to: ['jobjob.linkedin'],
			confirmToken: preview.confirmToken
		});
		expect(data(elsewhere).code).toBe('confirm_payload_mismatch');
		await expectOnlyOn([ch.jobjobInstagram]);
		await call('move_post', {
			postId,
			from: ['jobjob.instagram'],
			to: ['465cal.instagram'],
			confirmToken: preview.confirmToken
		});
		await expectOnlyOn([ch.calInstagram]);
	});

	it('changes only the deliveries named when rescheduling or cancelling', async () => {
		const posts = [
			{
				channels: ['jobjob.linkedin', 'unbranded.bluesky.pat-dev'],
				text: 'Both',
				runAt: inHours(30)
			}
		];
		const out = data(await call('schedule_posts', { posts }));
		await call('schedule_posts', { posts, confirmToken: out.confirmToken });
		const [delivery] = await h.deliveries();
		const postId = delivery.draftId;
		const notOnPost = await call('reschedule_posts', {
			items: [{ postId, channels: ['465cal.instagram'], runAt: inHours(40) }]
		});
		expect(text(notOnPost)).toContain('does not go to 465cal.instagram');
		await call('cancel_posts', { items: [{ postId, channels: ['jobjob.linkedin'] }] });
		const rows = await h.deliveries();
		// Taken down for good; the post stays for its other channel.
		expect(rows.find((r) => r.connectionId === ch.jobjobLinkedin)).toBeUndefined();
		// Unbranded, so held for review rather than scheduled; untouched either way.
		expect(rows.find((r) => r.connectionId === ch.patDot)!.status).toBe('awaiting_review');
		await expectOnlyOn([ch.patDot]);
	});

	it('keeps a cross-brand batch on exactly the accounts in the preview', async () => {
		const draftA = await stagedImageDraft();
		const draftB = await stagedImageDraft();
		const posts = [
			{
				channels: [{ brand: 'JobJob', platform: 'instagram' }],
				draftId: draftA,
				runAt: inHours(30)
			},
			{
				channels: [{ brand: '465Cal', platform: 'instagram' }],
				draftId: draftB,
				runAt: inHours(31)
			}
		];
		const preview = data(await call('schedule_posts', { posts }));
		expect(preview.status).toBe('confirmation_required');
		const shown = preview.posts.map(
			(p: { deliveries: Array<{ channel: { key: string; handle: string } }> }) =>
				`${p.deliveries[0].channel.key} ${p.deliveries[0].channel.handle}`
		);
		expect(shown).toEqual(['jobjob.instagram @jobjob.hq', '465cal.instagram @465cal']);
		await call('schedule_posts', { posts, confirmToken: preview.confirmToken });
		const rows = await expectOnlyOn([ch.jobjobInstagram, ch.calInstagram]);
		const byDraft = Object.fromEntries(rows.map((r) => [r.draftId, r.connectionId]));
		expect(byDraft[draftA]).toBe(ch.jobjobInstagram);
		expect(byDraft[draftB]).toBe(ch.calInstagram);
		expect(
			await h.db.select().from(publishTargets).where(eq(publishTargets.connectionId, ch.calTiktok))
		).toEqual([]);
	});
});
