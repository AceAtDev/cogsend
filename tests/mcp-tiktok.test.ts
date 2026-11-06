import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { Client } from '@modelcontextprotocol/client';
import { newId } from '#lib/server/db/client.js';
import { draftMedia, draftVariants, publishTargets } from '#lib/server/db/schema.js';
import { createMcpHarness, data, inHours, text } from './mcp-harness';

/**
 * TikTok's guidelines leave who can see a post, its interactions and its
 * disclosure to the creator, with no default. The MCP tools must refuse a
 * TikTok delivery until each was chosen, by the same rules as REST and the
 * composer, and say what to send.
 */

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let agent: Client;
let tiktok: string;
let linkedin: string;

const OFFERED = ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'];
const CHOICE = {
	privacy: 'SELF_ONLY',
	allowComment: true,
	allowDuet: false,
	allowStitch: false,
	disclose: false
};

beforeEach(async () => {
	h = await createMcpHarness();
	const cal = await h.brand('465Cal', '465cal');
	tiktok = await h.channel('tiktok', '465cal', cal, {
		metaJson: JSON.stringify({ tiktokPrivacyOptions: OFFERED, tiktokMaxVideoSec: 600 })
	});
	linkedin = await h.channel('linkedin', '465cal', cal);
	agent = await h.connect();
});

afterEach(async () => {
	await h.close();
});

const call = (name: string, args: Record<string, unknown>) =>
	agent.callTool({ name, arguments: args });

/** A draft with one short H.264 video, which TikTok takes. */
async function videoDraft(extra: Record<string, unknown> = {}) {
	const saved = await call('save_draft', { text: 'Clip', ...extra });
	expect(saved.isError, text(saved)).toBeFalsy();
	const draftId = data(saved).postId as string;
	await h.db.insert(draftMedia).values({
		id: newId(),
		draftId,
		storageKey: `${Date.now()}-${newId().slice(0, 16).padEnd(16, '0')}.mp4`,
		mime: 'video/mp4',
		size: 2_000_000,
		width: 1080,
		height: 1920,
		metaJson: JSON.stringify({ durationMs: 30_000, videoCodec: 'avc', fps: 30, faststart: true }),
		altText: null,
		sortOrder: 0,
		segmentIndex: 0,
		createdAt: new Date()
	});
	return draftId;
}

async function storedChoices(draftId: string) {
	const row = (
		await h.db
			.select()
			.from(draftVariants)
			.where(and(eq(draftVariants.draftId, draftId), eq(draftVariants.platform, 'tiktok')))
	)[0];
	return row ? JSON.parse(row.optionsJson).tiktok : undefined;
}

describe('MCP TikTok per-post choices', () => {
	it('refuses a TikTok delivery with no choices, naming the levels the account offers', async () => {
		const draftId = await videoDraft();
		const result = await call('schedule_posts', {
			posts: [{ channels: ['465cal.tiktok'], draftId, runAt: inHours(30) }]
		});
		expect(result.isError).toBe(true);
		expect(data(result).code).toBe('tiktok_privacy_required');
		expect(data(result).tiktokMissing).toEqual([
			{ channel: '465cal.tiktok', privacyOptions: OFFERED }
		]);
		expect(text(result)).toContain('posts[0].tiktok for 465cal.tiktok');
		expect(text(result)).toContain('PUBLIC_TO_EVERYONE, SELF_ONLY');
		expect(text(result)).toContain('no default');
		expect(await h.deliveries()).toEqual([]);
	});

	it('refuses a choice that leaves a switch unsaid', async () => {
		const draftId = await videoDraft();
		const { allowDuet: _omitted, ...partial } = CHOICE;
		const result = await call('schedule_posts', {
			posts: [{ channels: ['465cal.tiktok'], draftId, runAt: inHours(30), tiktok: partial }]
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('allowDuet');
		expect(await h.deliveries()).toEqual([]);
	});

	it('applies the same rules as REST: offered privacy, disclosure, no private branded content', async () => {
		const draftId = await videoDraft();
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ ...CHOICE, privacy: 'FOLLOWER_OF_CREATOR' }, 'this account offers PUBLIC_TO_EVERYONE'],
			[{ ...CHOICE, disclose: true }, 'promotes yourself, a third party, or both'],
			[
				{ ...CHOICE, disclose: true, brandedContent: true },
				'Branded content visibility cannot be set to private'
			]
		];
		for (const [choice, message] of cases) {
			const result = await call('schedule_posts', {
				posts: [{ channels: ['465cal.tiktok'], draftId, runAt: inHours(30), tiktok: choice }]
			});
			expect(result.isError, JSON.stringify(choice)).toBe(true);
			expect(data(result).code).toBe('tiktok_options');
			expect(text(result)).toContain(message);
		}
		expect(await h.deliveries()).toEqual([]);
	});

	it('refuses TikTok options for a post with no TikTok channel', async () => {
		const result = await call('schedule_posts', {
			posts: [{ channels: ['465cal.linkedin'], text: 'Hi', runAt: inHours(30), tiktok: CHOICE }]
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('none of this post');
	});

	it('previews the choices with the consent line, then schedules and keeps them on the draft', async () => {
		const draftId = await videoDraft();
		const args = {
			posts: [{ channels: ['465cal.tiktok'], draftId, runAt: inHours(30), tiktok: CHOICE }]
		};
		const preview = await call('schedule_posts', { ...args, dryRun: true });
		expect(preview.isError, text(preview)).toBeFalsy();
		expect(data(preview).posts[0].deliveries[0].tiktok).toBe(
			'who can see it: Only me; comments on, Duet off, Stitch off; not promotional'
		);
		expect(data(preview).consent).toContain('Music Usage Confirmation');
		const done = await call('schedule_posts', {
			...args,
			confirmToken: data(preview).confirmToken
		});
		expect(done.isError, text(done)).toBeFalsy();
		expect(data(done).status).toBe('scheduled');
		const [row] = await h.deliveries();
		expect(row).toMatchObject({ connectionId: tiktok, status: 'scheduled' });
		expect((await storedChoices(draftId))[tiktok]).toMatchObject({
			privacy: 'SELF_ONLY',
			allowComment: true,
			allowDuet: false
		});
	});

	it('takes one set per channel with `for`, and the branded-content consent', async () => {
		const draftId = await videoDraft();
		const result = await call('schedule_posts', {
			posts: [
				{
					channels: ['465cal.tiktok'],
					draftId,
					runAt: inHours(30),
					tiktok: [
						{
							for: '465cal.tiktok',
							...CHOICE,
							privacy: 'PUBLIC_TO_EVERYONE',
							disclose: true,
							brandedContent: true
						}
					]
				}
			],
			dryRun: true
		});
		expect(result.isError, text(result)).toBeFalsy();
		expect(data(result).consent).toContain('Branded Content Policy');
		expect(text(result)).toContain('Paid partnership');
	});

	it('save_draft stores the choices, and scheduling the draft then needs none in the call', async () => {
		const missing = await call('save_draft', { text: 'Clip', channels: ['465cal.tiktok'] });
		expect(missing.isError).toBeFalsy();
		expect(data(missing).tiktokMissing).toEqual([
			{ channel: '465cal.tiktok', privacyOptions: OFFERED }
		]);
		const draftId = await videoDraft({ channels: ['465cal.tiktok'], tiktok: CHOICE });
		expect((await storedChoices(draftId))[tiktok].privacy).toBe('SELF_ONLY');
		const result = await call('schedule_posts', {
			posts: [{ channels: ['465cal.tiktok'], draftId, runAt: inHours(30) }]
		});
		expect(result.isError, text(result)).toBeFalsy();
		expect(await h.deliveries()).toHaveLength(1);
	});

	it('never turns an internal label into a public TikTok title', async () => {
		const draftId = await videoDraft({
			title: 'Internal label: do not publish',
			channels: ['465cal.tiktok'],
			tiktok: { draft: true }
		});
		const scheduled = await call('schedule_posts', {
			posts: [{ channels: ['465cal.tiktok'], draftId, runAt: inHours(30) }]
		});
		expect(scheduled.isError, text(scheduled)).toBeFalsy();
		expect((await storedChoices(draftId))[tiktok]).not.toHaveProperty('title');
	});

	it('save_draft refuses a bad choice before writing anything', async () => {
		const result = await call('save_draft', {
			text: 'Clip',
			channels: ['465cal.tiktok'],
			tiktok: { ...CHOICE, disclose: true, brandedContent: true }
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toContain('Branded content visibility cannot be set to private');
		expect(await h.db.select().from(draftVariants)).toEqual([]);
	});

	it('keeps the separate photo title through save, caption edit and schedule', async () => {
		const saved = await call('save_draft', {
			title: 'Internal calendar label',
			text: 'Photo caption',
			channels: ['465cal.tiktok'],
			tiktok: { draft: true, title: 'Public photo title' }
		});
		expect(saved.isError, text(saved)).toBeFalsy();
		const draftId = data(saved).postId as string;
		await h.db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey: `${newId()}.jpg`,
			mime: 'image/jpeg',
			size: 1000,
			width: 1080,
			height: 1350,
			sortOrder: 0,
			segmentIndex: 0,
			createdAt: new Date()
		});
		const edited = await call('save_draft', { draftId, text: 'Edited photo caption' });
		expect(edited.isError, text(edited)).toBeFalsy();
		expect((await storedChoices(draftId))[tiktok]).toMatchObject({
			draft: true,
			title: 'Public photo title'
		});
		const retitled = await call('save_draft', {
			draftId,
			tiktok: { draft: true, title: 'Edited public title' }
		});
		expect(retitled.isError, text(retitled)).toBeFalsy();
		const detail = await call('get_post', { postId: draftId, response_format: 'detailed' });
		expect(detail.isError, text(detail)).toBeFalsy();
		expect(data(detail).post.title).toBe('Internal calendar label');
		expect(
			data(detail).post.variants.find((v: { platform: string }) => v.platform === 'tiktok').tiktok[
				tiktok
			]
		).toMatchObject({ draft: true, title: 'Edited public title' });
		const concise = await call('get_post', { postId: draftId });
		expect(data(concise).post.variants[0]).not.toHaveProperty('tiktok');
		const scheduled = await call('schedule_posts', {
			posts: [{ channels: ['465cal.tiktok'], draftId, runAt: inHours(30) }]
		});
		expect(scheduled.isError, text(scheduled)).toBeFalsy();
		expect((await storedChoices(draftId))[tiktok]).toMatchObject({
			draft: true,
			title: 'Edited public title'
		});
		expect(await h.deliveries()).toHaveLength(1);
	});

	it('publish_now and move_post refuse a TikTok channel without choices', async () => {
		const draftId = await videoDraft();
		const publish = await call('publish_now', {
			postId: draftId,
			channels: ['465cal.tiktok'],
			dryRun: true
		});
		expect(publish.isError).toBe(true);
		expect(data(publish).code).toBe('tiktok_privacy_required');

		const scheduled = await call('schedule_posts', {
			posts: [{ channels: ['465cal.linkedin'], draftId, runAt: inHours(30) }]
		});
		expect(scheduled.isError, text(scheduled)).toBeFalsy();
		const move = await call('move_post', {
			postId: draftId,
			from: ['465cal.linkedin'],
			to: ['465cal.tiktok'],
			dryRun: true
		});
		expect(move.isError).toBe(true);
		expect(data(move).code).toBe('tiktok_privacy_required');

		const withChoice = await call('move_post', {
			postId: draftId,
			from: ['465cal.linkedin'],
			to: ['465cal.tiktok'],
			tiktok: CHOICE,
			dryRun: true
		});
		expect(withChoice.isError, text(withChoice)).toBeFalsy();
		const moved = await call('move_post', {
			postId: draftId,
			from: ['465cal.linkedin'],
			to: ['465cal.tiktok'],
			tiktok: CHOICE,
			confirmToken: data(withChoice).confirmToken
		});
		expect(moved.isError, text(moved)).toBeFalsy();
		const live = (await h.db.select().from(publishTargets)).filter((t) => t.status !== 'cancelled');
		expect(live.map((t) => t.connectionId)).toEqual([tiktok]);
		expect(live.some((t) => t.connectionId === linkedin)).toBe(false);
	});

	it('get_platform_requirements lists what the TikTok account offers', async () => {
		const result = await call('get_platform_requirements', { channels: ['465cal.tiktok'] });
		expect(result.isError).toBeFalsy();
		const out = data(result);
		expect(out.platforms[0].tiktok.perPostChoices.required).toBe(true);
		expect(out.accounts[0].tiktok.privacyOptions).toEqual(OFFERED);
		expect(out.accounts[0].summary).toContain('privacy one of PUBLIC_TO_EVERYONE, SELF_ONLY');
	});
});
