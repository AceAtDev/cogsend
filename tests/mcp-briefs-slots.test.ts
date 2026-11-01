import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { newId } from '#lib/server/db/client.js';
import { drafts, publishTargets } from '#lib/server/db/schema.js';
import { saveBrief } from '#lib/server/brand-briefs.js';
import { savePostingRules } from '#lib/server/posting-slots.js';
import { createMcpHarness, data, text } from './mcp-harness';

/**
 * Briefs and posting slots as an agent uses them over MCP, with the clock
 * pinned to Monday 2026-11-02 07:00 in Berlin (06:00 UTC), after Berlin's
 * change to winter time.
 */

const NOW = new Date('2026-11-02T06:00:00.000Z');
const MON_09 = '2026-11-02T08:00:00.000Z';
const MON_18 = '2026-11-02T17:00:00.000Z';
const TUE_09 = '2026-11-03T08:00:00.000Z';

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let client: Client;
let ids: Record<string, string>;

const call = (name: string, args: Record<string, unknown> = {}) =>
	client.callTool({ name, arguments: args });

async function occupy(connectionId: string, iso: string, status = 'scheduled') {
	const draftId = newId();
	await h.db.insert(drafts).values({
		id: draftId,
		userId: h.user.id,
		baseBody: 'already planned',
		status: 'scheduled',
		createdAt: NOW,
		updatedAt: NOW
	});
	const id = newId();
	await h.db.insert(publishTargets).values({
		id,
		draftId,
		connectionId,
		status,
		scheduledFor: new Date(iso),
		createdAt: NOW,
		updatedAt: NOW
	});
	return { draftId, id };
}

const weekdays = (times: string[]) =>
	Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri'].map((d) => [d, times]));

async function scheduledTimes(connectionId: string) {
	return (await h.deliveries())
		.filter((d) => d.connectionId === connectionId && d.status === 'scheduled')
		.map((d) => d.scheduledFor!.toISOString())
		.sort();
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(NOW);
	h = await createMcpHarness({ timezone: 'Europe/Berlin' });
	const jobjob = await h.brand('JobJob', 'jobjob');
	const cal = await h.brand('465Cal', '465cal', '#db2777');
	ids = {
		jobjob,
		cal,
		linkedin: await h.channel('linkedin', 'jobjob', jobjob),
		bluesky: await h.channel('bluesky', 'jobjob.bsky.social', jobjob),
		calBluesky: await h.channel('bluesky', '465cal.bsky.social', cal),
		loose: await h.channel('mastodon', 'me@mastodon.example', null, {
			instanceUrl: 'https://mastodon.example'
		})
	};
	await savePostingRules(h.db, h.user.id, ids.linkedin, {
		slots: weekdays(['09:00', '18:00']),
		maxPerDay: 2,
		minGapMinutes: 60
	});
	await savePostingRules(h.db, h.user.id, ids.bluesky, {
		slots: weekdays(['12:00'])
	});
	await saveBrief(h.db, h.user.id, jobjob, {
		sections: {
			voice: 'Friendly, direct, no jargon.',
			audience: 'Job seekers in Berlin.',
			dont: 'Never promise salaries.'
		},
		platformNotes: { linkedin: 'Three hashtags at most.' }
	});
	client = await h.connect();
});

afterEach(async () => {
	await h.close();
	vi.useRealTimers();
});

describe('get_brand_brief', () => {
	it('returns a brand’s brief as sections and markdown, with its channels’ rules', async () => {
		const result = await call('get_brand_brief', { brand: 'jobjob' });
		expect(result.isError, text(result)).toBeFalsy();
		const out = data(result);
		expect(out.brands).toHaveLength(1);
		const [brand] = out.brands;
		expect(brand).toMatchObject({
			name: 'JobJob',
			slug: 'jobjob',
			hasBrief: true,
			sections: ['voice', 'audience', 'dont'],
			brief: { sections: { voice: 'Friendly, direct, no jargon.' } }
		});
		expect(brand.markdown).toContain('## Voice and tone\n\nFriendly, direct, no jargon.');
		const linkedin = brand.channels.find((c: { key: string }) => c.key === 'jobjob.linkedin');
		expect(linkedin.platformNote).toBe('Three hashtags at most.');
		expect(linkedin.posting).toMatchObject({ maxPerDay: 2, minGapMinutes: 60, slotsPerWeek: 10 });
		expect(text(result)).toContain('# JobJob brief');
	});

	it('picks out the platform note for a channel key, and lists every brand without arguments', async () => {
		const focused = data(await call('get_brand_brief', { channel: 'jobjob.linkedin' }));
		expect(focused.focus).toEqual({
			channel: 'jobjob.linkedin',
			platform: 'linkedin',
			platformNote: 'Three hashtags at most.'
		});
		const all = data(await call('get_brand_brief'));
		expect(all.brands.map((b: { slug: string }) => b.slug)).toEqual(['465cal', 'jobjob']);
		const cal = all.brands.find((b: { slug: string }) => b.slug === '465cal');
		expect(cal.hasBrief).toBe(false);
		expect(all.next).toMatch(/No brief yet for 465Cal: ask the operator/);
	});

	it('refuses an unknown brand with the valid ones, and unbranded channels', async () => {
		const unknown = await call('get_brand_brief', { brand: 'jobjb' });
		expect(unknown.isError).toBe(true);
		expect(text(unknown)).toMatch(
			/No brand "jobjb"\. Brands: 465cal \(465Cal\), jobjob \(JobJob\)/
		);
		const loose = await call('get_brand_brief', { channel: 'unbranded.mastodon' });
		expect(loose.isError).toBe(true);
		expect(text(loose)).toMatch(/not in a brand/);
	});
});

describe('list_channels', () => {
	it('carries each brand’s brief at a glance and each channel’s slots with its next open one', async () => {
		const out = data(await call('list_channels'));
		const jobjob = out.brands.find((b: { slug: string }) => b.slug === 'jobjob');
		expect(jobjob.brief).toMatchObject({ hasBrief: true, sections: ['voice', 'audience', 'dont'] });
		const linkedin = jobjob.channels.find((c: { key: string }) => c.key === 'jobjob.linkedin');
		expect(linkedin.posting).toMatchObject({
			slots: 'Mon–Fri 09:00, 18:00',
			maxPerDay: 2,
			minGapMinutes: 60,
			nextOpenSlot: { utc: MON_09, weekday: 'Monday' }
		});
		const calBluesky = out.brands
			.find((b: { slug: string }) => b.slug === '465cal')
			.channels.find((c: { key: string }) => c.key === '465cal.bluesky');
		expect(calBluesky.posting).toBeNull();
		const summary = out.summary as string;
		expect(summary).toContain(
			'JobJob (trusted: your posts are scheduled without review): brief: voice, audience, dont, linkedin notes'
		);
		expect(summary).toContain('posting: slots Mon–Fri 09:00, 18:00; max 2/day; 60 min apart');
		expect(summary).toContain(
			'465Cal (trusted: your posts are scheduled without review): no brief yet'
		);
	});
});

describe('list_slots', () => {
	it('lists open slots in the operator’s zone, leaving out taken ones', async () => {
		await occupy(ids.linkedin, MON_18);
		const out = data(
			await call('list_slots', {
				channels: ['jobjob.linkedin'],
				from: '2026-11-02',
				to: '2026-11-03'
			})
		);
		const [linkedin] = out.channels;
		expect(linkedin.openSlots.map((s: { utc: string }) => s.utc)).toEqual([
			MON_09,
			TUE_09,
			'2026-11-03T17:00:00.000Z'
		]);
		expect(linkedin.openSlots[0].local).toBe('2026-11-02T09:00:00+01:00');
		expect(linkedin.slotsInRange).toBe(4);
		expect(linkedin.takenOrBlocked).toBe(1);
	});

	it('counts a post held in a state it does not know, and ignores cancelled and failed ones', async () => {
		await occupy(ids.linkedin, MON_09, 'awaiting_review');
		await occupy(ids.linkedin, MON_18, 'cancelled');
		await occupy(ids.linkedin, TUE_09, 'failed');
		const out = data(await call('list_slots', { channels: ['jobjob.linkedin'], to: '2026-11-03' }));
		expect(out.channels[0].nextOpenSlot.utc).toBe(MON_18);
		expect(out.channels[0].openSlots.map((s: { utc: string }) => s.utc)).toContain(TUE_09);
	});

	it('covers one brand’s active channels and says which have no slots', async () => {
		const out = data(await call('list_slots', { brand: 'jobjob', limit: 1 }));
		expect(out.channels.map((c: { channel: { key: string } }) => c.channel.key).sort()).toEqual([
			'jobjob.bluesky',
			'jobjob.linkedin'
		]);
		expect(out.channels.every((c: { openSlots: unknown[] }) => c.openSlots.length === 1)).toBe(
			true
		);
		const all = data(await call('list_slots'));
		expect(all.summary).toContain(
			'unbranded.mastodon: no slots or limits set; any time is allowed.'
		);
	});

	it('refuses a range past the horizon or ending before it starts', async () => {
		expect((await call('list_slots', { from: '2026-11-02', to: '2027-02-01' })).isError).toBe(true);
		expect((await call('list_slots', { from: '2026-11-05', to: '2026-11-03' })).isError).toBe(true);
	});
});

describe('schedule_posts with next_slot', () => {
	it('commits a single-channel post at the next open slot and says it was a slot', async () => {
		const result = await call('schedule_posts', {
			posts: [{ channels: ['jobjob.linkedin'], text: 'Tip of the week', runAt: 'next_slot' }]
		});
		expect(result.isError, text(result)).toBeFalsy();
		const [delivery] = data(result).posts[0].deliveries;
		expect(delivery).toMatchObject({
			status: 'scheduled',
			slot: true,
			runAt: { utc: MON_09, local: '2026-11-02T09:00:00+01:00', weekday: 'Monday' }
		});
		expect(await scheduledTimes(ids.linkedin)).toEqual([MON_09]);
	});

	it('gives two posts of one batch competing for the same channel different slots', async () => {
		const args = {
			posts: [
				{ channels: ['jobjob.linkedin'], text: 'First', runAt: 'next_slot' },
				{ channels: ['jobjob.linkedin'], text: 'Second', runAt: 'next_slot' },
				{ channels: ['jobjob.linkedin'], text: 'Third', runAt: { slot: 'next' } }
			],
			dryRun: true
		};
		const preview = data(await call('schedule_posts', args));
		expect(preview.status).toBe('preview');
		const times = preview.posts.map(
			(p: { deliveries: Array<{ runAt: { utc: string } }> }) => p.deliveries[0].runAt.utc
		);
		// Monday is full after two (maxPerDay 2), so the third goes to Tuesday.
		expect(times).toEqual([MON_09, MON_18, TUE_09]);
		expect(preview.summary).toContain('(next open slot)');
		expect(await h.deliveries()).toHaveLength(0);
		const { dryRun: _d, ...commit } = args;
		const done = await call('schedule_posts', { ...commit, confirmToken: preview.confirmToken });
		expect(done.isError, text(done)).toBeFalsy();
		expect(await scheduledTimes(ids.linkedin)).toEqual([MON_09, MON_18, TUE_09]);
	});

	it('lets an explicit time in the batch keep its slot even when listed after a next_slot post', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{ channels: ['jobjob.linkedin'], text: 'Whenever', runAt: 'next_slot' },
				{ channels: ['jobjob.linkedin'], text: 'At nine', runAt: '2026-11-02T09:00:00+01:00' }
			],
			dryRun: true
		});
		const out = data(result);
		expect(out.posts[0].deliveries[0].runAt.utc).toBe(MON_18);
		expect(out.posts[1].runAt.utc).toBe(MON_09);
	});

	it('looks from `after`, a day in the operator’s zone', async () => {
		const out = data(
			await call('schedule_posts', {
				posts: [
					{
						channels: ['jobjob.linkedin'],
						text: 'Later',
						runAt: { slot: 'next', after: '2026-11-05' }
					}
				],
				dryRun: true
			})
		);
		expect(out.posts[0].deliveries[0].runAt.display).toMatch(/^Thursday 2026-11-05 09:00/);
	});

	it('gives each channel of a post its own slot', async () => {
		const args = {
			posts: [
				{ channels: ['jobjob.linkedin', 'jobjob.bluesky'], text: 'Everywhere', runAt: 'next_slot' }
			]
		};
		const first = data(await call('schedule_posts', args));
		expect(first.status).toBe('confirmation_required');
		const byKey = Object.fromEntries(
			first.posts[0].deliveries.map((d: { channel: { key: string }; runAt: { utc: string } }) => [
				d.channel.key,
				d.runAt.utc
			])
		);
		expect(byKey).toEqual({
			'jobjob.linkedin': MON_09,
			'jobjob.bluesky': '2026-11-02T11:00:00.000Z'
		});
		const done = data(await call('schedule_posts', { ...args, confirmToken: first.confirmToken }));
		expect(done.status).toBe('scheduled');
		const rows = await h.deliveries();
		expect(new Set(rows.map((r) => r.draftId)).size).toBe(1);
		expect(await scheduledTimes(ids.bluesky)).toEqual(['2026-11-02T11:00:00.000Z']);
		expect(await scheduledTimes(ids.linkedin)).toEqual([MON_09]);
	});

	it('refuses the commit when the previewed slot was taken in between', async () => {
		const args = {
			posts: [
				{ channels: ['jobjob.linkedin'], text: 'Mine', runAt: 'next_slot' },
				{ channels: ['jobjob.bluesky'], text: 'Also mine', runAt: 'next_slot' }
			]
		};
		const preview = data(await call('schedule_posts', args));
		expect(preview.posts[0].deliveries[0].runAt.utc).toBe(MON_09);
		// Another client takes Monday 09:00 before the confirmation arrives.
		await occupy(ids.linkedin, MON_09);
		const commit = await call('schedule_posts', { ...args, confirmToken: preview.confirmToken });
		expect(commit.isError).toBe(true);
		expect(await scheduledTimes(ids.bluesky)).toEqual([]);
	});

	it('refuses next_slot on a channel without slots, naming what to do', async () => {
		const result = await call('schedule_posts', {
			posts: [{ channels: ['465cal.bluesky'], text: 'Hi', runAt: 'next_slot' }]
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/465cal\.bluesky has no posting slots.*explicit runAt/);
		expect(await h.deliveries()).toHaveLength(0);
	});

	it('refuses a malformed `after`', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{
					channels: ['jobjob.linkedin'],
					text: 'Hi',
					runAt: { slot: 'next', after: 'next Tuesday please' }
				}
			]
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/after "next Tuesday please" must be a day/);
	});
});

describe('posting limits', () => {
	it('refuses a time over the day limit, naming the next allowed time and slot', async () => {
		await occupy(ids.linkedin, MON_09);
		await occupy(ids.linkedin, MON_18);
		const result = await call('schedule_posts', {
			posts: [
				{ channels: ['jobjob.linkedin'], text: 'One more', runAt: '2026-11-02T15:00:00+01:00' }
			]
		});
		expect(result.isError).toBe(true);
		const message = text(result);
		expect(message).toMatch(/allows at most 2 posts a day and Monday 2026-11-02 already has 2/);
		expect(message).toMatch(/Next allowed time: Tuesday 2026-11-03 00:00/);
		expect(message).toMatch(/next open slot: Tuesday 2026-11-03 09:00/);
		const out = data(result);
		expect(out.code).toBe('posting_limit');
		expect(out.limits[0]).toMatchObject({
			channel: 'jobjob.linkedin',
			code: 'max_per_day',
			nextAllowed: { local: '2026-11-03T00:00:00+01:00' },
			nextSlot: { utc: TUE_09 }
		});
		expect(await scheduledTimes(ids.linkedin)).toEqual([MON_09, MON_18]);
	});

	it('refuses a time inside the minimum gap, including against another post of the batch', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{ channels: ['jobjob.linkedin'], text: 'A', runAt: '2026-11-02T10:00:00+01:00' },
				{ channels: ['jobjob.linkedin'], text: 'B', runAt: '2026-11-02T10:30:00+01:00' }
			]
		});
		expect(result.isError).toBe(true);
		expect(text(result)).toMatch(/posts\[1\]: jobjob\.linkedin needs 60 minutes between posts/);
		expect(text(result)).toMatch(/Next allowed time: Monday 2026-11-02 11:00/);
		expect(await h.deliveries()).toHaveLength(0);
	});

	it('leaves channels without rules unchecked', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{ channels: ['465cal.bluesky'], text: 'A', runAt: '2026-11-02T10:00:00+01:00' },
				{ channels: ['465cal.bluesky'], text: 'B', runAt: '2026-11-02T10:05:00+01:00' }
			],
			dryRun: true
		});
		expect(result.isError, text(result)).toBeFalsy();
	});
});

describe('reschedule_posts', () => {
	it('moves a delivery to the next open slot, not counting the time it leaves', async () => {
		const { id } = await occupy(ids.linkedin, MON_09);
		const result = await call('reschedule_posts', {
			items: [{ deliveryId: id, runAt: 'next_slot' }]
		});
		expect(result.isError, text(result)).toBeFalsy();
		const [delivery] = data(result).deliveries;
		// Its own 09:00 is free once it moves, so that is the next open slot.
		expect(delivery).toMatchObject({ slot: true, after: { utc: MON_09 } });
		const later = await call('reschedule_posts', {
			items: [{ deliveryId: id, runAt: { slot: 'next', after: '2026-11-03' } }]
		});
		expect(data(later).deliveries[0].after.utc).toBe(TUE_09);
		expect(await scheduledTimes(ids.linkedin)).toEqual([TUE_09]);
	});

	it('spreads several deliveries over successive slots and refuses one over the limit', async () => {
		const a = await occupy(ids.linkedin, '2026-11-04T08:00:00.000Z');
		const b = await occupy(ids.linkedin, '2026-11-05T08:00:00.000Z');
		const preview = data(
			await call('reschedule_posts', {
				items: [
					{ deliveryId: a.id, runAt: 'next_slot' },
					{ deliveryId: b.id, runAt: 'next_slot' }
				],
				dryRun: true
			})
		);
		expect(preview.deliveries.map((d: { after: { utc: string } }) => d.after.utc)).toEqual([
			MON_09,
			MON_18
		]);
		await occupy(ids.linkedin, MON_09);
		await occupy(ids.linkedin, MON_18);
		const refused = await call('reschedule_posts', {
			items: [{ deliveryId: a.id, runAt: '2026-11-02T14:00:00+01:00' }]
		});
		expect(refused.isError).toBe(true);
		expect(text(refused)).toMatch(/Next allowed time: Tuesday 2026-11-03 00:00/);
	});
});

describe('slots far ahead', () => {
	it('sees posts near an `after` past the usual window, in both tools', async () => {
		// Monday 2027-01-11 is ten weeks out; its 09:00 is already taken.
		await occupy(ids.linkedin, '2027-01-11T08:00:00.000Z');
		const { id } = await occupy(ids.linkedin, TUE_09);
		const after = { slot: 'next', after: '2027-01-11' };
		const scheduled = data(
			await call('schedule_posts', {
				posts: [{ channels: ['jobjob.linkedin'], text: 'Far', runAt: after }],
				dryRun: true
			})
		);
		expect(scheduled.posts[0].deliveries[0].runAt.utc).toBe('2027-01-11T17:00:00.000Z');
		const moved = data(
			await call('reschedule_posts', { items: [{ deliveryId: id, runAt: after }], dryRun: true })
		);
		expect(moved.deliveries[0].after.utc).toBe('2027-01-11T17:00:00.000Z');
	});
});

describe('move_post', () => {
	it('refuses moving onto a channel whose day is full', async () => {
		await occupy(ids.linkedin, MON_09);
		await occupy(ids.linkedin, MON_18);
		const { draftId } = await occupy(ids.calBluesky, '2026-11-02T14:00:00.000Z');
		const result = await call('move_post', {
			postId: draftId,
			from: ['465cal.bluesky'],
			to: ['jobjob.linkedin'],
			dryRun: true
		});
		expect(result.isError).toBe(true);
		expect(data(result).code).toBe('posting_limit');
		expect(text(result)).toMatch(/to: jobjob\.linkedin allows at most 2 posts a day/);
	});
});

describe('the brand brief resource', () => {
	it('lists one resource per brand and reads it as markdown', async () => {
		const { resources } = await client.listResources();
		expect(resources.map((r) => r.uri)).toEqual(
			expect.arrayContaining(['cogsend://brands/jobjob/brief', 'cogsend://brands/465cal/brief'])
		);
		const read = await client.readResource({ uri: 'cogsend://brands/jobjob/brief' });
		const [content] = read.contents as Array<{ text: string; mimeType: string }>;
		expect(content.mimeType).toBe('text/markdown');
		expect(content.text).toContain('## Audience\n\nJob seekers in Berlin.');
	});
});
