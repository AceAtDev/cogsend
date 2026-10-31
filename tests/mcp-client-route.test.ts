import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Client } from '@modelcontextprotocol/client';
import { mcpConfirmations, mcpIdempotency, publishTargets } from '#lib/server/db/schema.js';
import * as publish from '#lib/server/publish.js';
import { createMcpHarness, data, inHours, text } from './mcp-harness';

const expectedTools = [
	'list_channels',
	'list_posts',
	'get_post',
	'get_platform_requirements',
	'validate_post',
	'schedule_posts',
	'reschedule_posts',
	'move_post',
	'cancel_posts',
	'publish_now',
	'save_draft',
	'attach_media',
	'media_upload',
	'edit_media'
];

const read = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false
};
const expectedAnnotations: Record<string, Record<string, boolean>> = {
	list_channels: read,
	list_posts: read,
	get_post: read,
	get_platform_requirements: read,
	validate_post: read,
	schedule_posts: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	reschedule_posts: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	},
	move_post: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	cancel_posts: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false
	},
	publish_now: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	},
	save_draft: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	attach_media: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true
	},
	media_upload: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false
	},
	edit_media: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true
	}
};

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let client: Client;
let ids: Record<string, string>;

beforeEach(async () => {
	h = await createMcpHarness({ timezone: 'Europe/Berlin' });
	const jobjob = await h.brand('JobJob', 'jobjob');
	const cal = await h.brand('465Cal', '465cal', '#db2777');
	ids = {
		jobjobLinkedin: await h.channel('linkedin', 'jobjob', jobjob),
		jobjobInstagram: await h.channel('instagram', 'jobjob.hq', jobjob),
		calTiktok: await h.channel('tiktok', '465cal', cal),
		calInstagram: await h.channel('instagram', '465cal', cal),
		bluesky: await h.channel('bluesky', 'me.bsky.social', null)
	};
	client = await h.connect();
});

afterEach(async () => {
	vi.restoreAllMocks();
	await h.close();
});

const call = (name: string, args: Record<string, unknown> = {}) =>
	client.callTool({ name, arguments: args });

describe('MCP v2 catalog', () => {
	it('lists the workflow tools with honest annotations, strict schemas and output schemas', async () => {
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name)).toEqual(expectedTools);
		for (const tool of tools) {
			const { title: _title, ...hints } = tool.annotations ?? {};
			expect(hints, tool.name).toEqual(expectedAnnotations[tool.name]);
			expect(tool.title, tool.name).toBeTruthy();
			expect(tool.inputSchema.additionalProperties, tool.name).toBe(false);
			expect((tool.outputSchema as { type?: string }).type, tool.name).toBe('object');
			const sentences = (tool.description ?? '').split(/(?<=[.!?])\s+(?=[A-Z])/).length;
			expect(sentences, tool.name).toBeGreaterThanOrEqual(3);
			expect(sentences, tool.name).toBeLessThanOrEqual(7);
			expect(
				(tool._meta as Record<string, unknown[]>)['cogsend/inputExamples'].length
			).toBeGreaterThan(0);
		}
		const schedule = tools.find((t) => t.name === 'schedule_posts')!;
		const examples = (schedule._meta as Record<string, unknown[]>)['cogsend/inputExamples'];
		expect(examples.length).toBeGreaterThanOrEqual(2);
	});

	it('starts with list_channels: brands, keys, handles, now in both zones and requirements', async () => {
		const result = await call('list_channels');
		expect(result.isError).toBeFalsy();
		const out = data(result);
		expect(out.timeZone).toBe('Europe/Berlin');
		expect(out.now.utc).toMatch(/Z$/);
		expect(out.now.local).toMatch(/[+-]\d{2}:\d{2}$/);
		expect(out.brands.map((b: { slug: string }) => b.slug)).toEqual([
			'465cal',
			'jobjob',
			'unbranded'
		]);
		const jobjob = out.brands.find((b: { slug: string }) => b.slug === 'jobjob');
		expect(jobjob.channels).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: 'jobjob.instagram',
					handle: '@jobjob.hq',
					brand: 'JobJob',
					status: 'active'
				})
			])
		);
		expect(out.platforms.map((p: { platform: string }) => p.platform).sort()).toEqual(
			['bluesky', 'instagram', 'linkedin', 'tiktok'].sort()
		);
		expect(text(result)).toContain('jobjob.linkedin');
	});
});

describe('schedule_posts', () => {
	it('schedules a single-channel post directly and echoes what it resolved', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{
					channels: ['jobjob.linkedin'],
					text: 'New roles are open.',
					runAt: { localTime: '2027-03-02T09:00', timeZone: 'Europe/Berlin' }
				}
			]
		});
		expect(result.isError).toBeFalsy();
		const out = data(result);
		expect(out).toMatchObject({ status: 'scheduled', committed: true });
		const [delivery] = out.posts[0].deliveries;
		expect(delivery).toMatchObject({
			status: 'scheduled',
			channel: { key: 'jobjob.linkedin', brand: 'JobJob', handle: '@jobjob', platform: 'linkedin' },
			runAt: {
				utc: '2027-03-02T08:00:00.000Z',
				weekday: 'Tuesday',
				local: '2027-03-02T09:00:00+01:00'
			}
		});
		expect(out.next).toBeTruthy();
		const rows = await h.deliveries();
		expect(rows.map((r) => r.connectionId)).toEqual([ids.jobjobLinkedin]);
	});

	it('refuses a post a platform would reject before issuing any token', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{
					channels: ['jobjob.linkedin', 'jobjob.instagram'],
					text: 'Hiring!',
					runAt: '2027-03-02T09:00:00+01:00'
				}
			]
		});
		expect(result.isError).toBe(true);
		expect(data(result).problems).toEqual([
			'posts[0] jobjob.instagram (Instagram @jobjob.hq): Instagram needs a photo or video'
		]);
		expect(await h.db.select().from(mcpConfirmations)).toEqual([]);
	});

	it('previews, confirms and refuses a tampered or reused token', async () => {
		const posts = [
			{ channels: ['jobjob.linkedin', 'unbranded.bluesky'], text: 'Hello both', runAt: inHours(30) }
		];
		const preview = await call('schedule_posts', { posts });
		const out = data(preview);
		expect(out).toMatchObject({
			status: 'confirmation_required',
			committed: false,
			confirmationRequired: true
		});
		expect(out.posts[0].deliveries.map((d: { channel: { key: string } }) => d.channel.key)).toEqual(
			['jobjob.linkedin', 'unbranded.bluesky']
		);
		expect(out.warnings.join(' ')).toContain('2 brands');
		expect(await h.deliveries()).toEqual([]);

		const tampered = await call('schedule_posts', {
			posts: [{ ...posts[0], text: 'Hello both, edited' }],
			confirmToken: out.confirmToken
		});
		expect(tampered.isError).toBe(true);
		expect(data(tampered).code).toBe('confirm_payload_mismatch');
		expect(await h.deliveries()).toEqual([]);

		const committed = await call('schedule_posts', { posts, confirmToken: out.confirmToken });
		expect(data(committed)).toMatchObject({ status: 'scheduled', committed: true });
		expect((await h.deliveries()).map((d) => d.connectionId).sort()).toEqual(
			[ids.jobjobLinkedin, ids.bluesky].sort()
		);

		const reused = await call('schedule_posts', { posts, confirmToken: out.confirmToken });
		expect(data(reused).code).toBe('confirm_token_used');
		expect(await h.deliveries()).toHaveLength(2);
	});

	it('refuses an expired token and a token from another tool', async () => {
		const posts = [
			{ channels: ['jobjob.linkedin', 'unbranded.bluesky'], text: 'Later', runAt: inHours(30) }
		];
		const preview = data(await call('schedule_posts', { posts, dryRun: true }));
		expect(preview.status).toBe('preview');
		await h.db.update(mcpConfirmations).set({ expiresAt: new Date(Date.now() - 1000) });
		const expired = await call('schedule_posts', { posts, confirmToken: preview.confirmToken });
		expect(data(expired).code).toBe('confirm_token_expired');
		expect(text(expired)).toContain('dryRun: true');

		const scheduled = data(
			await call('schedule_posts', {
				posts: [{ channels: ['jobjob.linkedin'], text: 'x', runAt: inHours(40) }]
			})
		);
		const postId = scheduled.posts[0].postIds[0];
		const movePreview = data(await call('move_post', { postId, to: ['unbranded.bluesky'] }));
		const crossTool = await call('schedule_posts', {
			posts,
			confirmToken: movePreview.confirmToken
		});
		expect(data(crossTool).code).toBe('confirm_token_invalid');
	});

	it('replays an idempotent commit and refuses the key with different arguments', async () => {
		const args = {
			posts: [{ channels: ['jobjob.linkedin'], text: 'Once only', runAt: inHours(26) }],
			idempotencyKey: 'agent-run-0001'
		};
		const first = data(await call('schedule_posts', args));
		const again = data(await call('schedule_posts', args));
		expect(again.idempotentReplay).toBe(true);
		expect(again.posts[0].postIds).toEqual(first.posts[0].postIds);
		expect(await h.deliveries()).toHaveLength(1);
		const different = await call('schedule_posts', {
			...args,
			posts: [{ ...args.posts[0], text: 'Something else' }]
		});
		expect(data(different).code).toBe('idempotency_key_reused');
		expect(await h.deliveries()).toHaveLength(1);
		const [row] = await h.db.select().from(mcpIdempotency);
		expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(24 * 3_600_000);
	});

	it('validates the whole batch first and reports every problem with a valid example', async () => {
		const result = await call('schedule_posts', {
			posts: [
				{ channels: ['jobjob.linkedin'], text: 'Fine', runAt: inHours(30) },
				{ channels: ['instagram'], text: 'Which one?', runAt: inHours(31) },
				{ channels: ['465cal.tiktok'], text: 'No video', runAt: '2027-03-02T09:00' },
				{ channels: ['jobjob.linkedin'], text: 'x'.repeat(3001), runAt: inHours(32) }
			]
		});
		expect(result.isError).toBe(true);
		const out = data(result);
		const problems: string[] = out.problems;
		expect(
			problems.some(
				(p) =>
					p.startsWith('posts[1].channels[0]') &&
					p.includes('jobjob.instagram') &&
					p.includes('465cal.instagram')
			)
		).toBe(true);
		expect(
			problems.some(
				(p) =>
					p.startsWith('posts[2].runAt') && p.includes('no time zone') && p.includes('Server now')
			)
		).toBe(true);
		expect(problems.some((p) => p.startsWith('posts[2]') && p.includes('TikTok'))).toBe(true);
		expect(problems.some((p) => p.startsWith('posts[3]') && p.includes('LinkedIn'))).toBe(true);
		expect(text(result)).toContain('Example of a valid call');
		expect(await h.deliveries()).toEqual([]);
	});

	it('refuses past times and DST gaps with the server clock and zone', async () => {
		const past = await call('schedule_posts', {
			posts: [{ channels: ['jobjob.linkedin'], text: 'Late', runAt: '2020-01-01T09:00:00Z' }]
		});
		expect(text(past)).toMatch(/in the past.*Server now: .*Europe\/Berlin/s);
		const gap = await call('schedule_posts', {
			posts: [
				{
					channels: ['jobjob.linkedin'],
					text: 'Spring',
					runAt: { localTime: '2027-03-28T02:30', timeZone: 'Europe/Berlin' }
				}
			]
		});
		expect(text(gap)).toContain('does not exist in Europe/Berlin');
		expect(await h.deliveries()).toEqual([]);
	});

	it('splits a post when two channels on one platform get different text', async () => {
		const posts = [
			{
				channels: ['jobjob.instagram', '465cal.instagram'],
				draftId: undefined as string | undefined,
				text: 'Base',
				variants: [{ for: '465cal.instagram', text: 'Cal copy' }],
				runAt: inHours(48)
			}
		];
		// Instagram needs media: stage it on a draft first.
		const attached = data(
			await call('attach_media', {
				base64: Buffer.from(
					new Uint8Array([
						0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1
					])
				).toString('base64')
			})
		);
		posts[0].draftId = attached.postId;
		const preview = data(await call('schedule_posts', { posts }));
		expect(preview.warnings.join(' ')).toContain('saved as 2 posts');
		const done = data(await call('schedule_posts', { posts, confirmToken: preview.confirmToken }));
		expect(done.status).toBe('scheduled');
		expect(done.posts[0].postIds).toHaveLength(2);
		const listed = data(await call('list_posts', { response_format: 'detailed' }));
		const byChannel = Object.fromEntries(
			listed.posts.map((p: { channel: string; text: string }) => [p.channel, p.text])
		);
		expect(byChannel).toEqual({ 'jobjob.instagram': 'Base', '465cal.instagram': 'Cal copy' });
	});

	it('publishes now only after confirmation', async () => {
		vi.spyOn(publish, 'publishTarget').mockImplementation(async (db, _env, _media, targetId) => {
			await db
				.update(publishTargets)
				.set({ status: 'published', remotePostId: 'r1' })
				.where(eq(publishTargets.id, targetId));
			return { status: 'published', remotePostId: 'r1' } as never;
		});
		const posts = [{ channels: ['jobjob.linkedin'], text: 'Right now', runAt: 'now' }];
		const preview = data(await call('schedule_posts', { posts }));
		expect(preview.status).toBe('confirmation_required');
		expect(await h.deliveries()).toEqual([]);
		const done = data(await call('schedule_posts', { posts, confirmToken: preview.confirmToken }));
		expect(done.status).toBe('published');
		expect(done.posts[0].deliveries[0]).toMatchObject({
			status: 'published',
			channel: { key: 'jobjob.linkedin' }
		});
	});
});

describe('changing what is planned', () => {
	async function scheduleOne(channel: string, hours: number) {
		const out = data(
			await call('schedule_posts', {
				posts: [{ channels: [channel], text: `On ${channel}`, runAt: inHours(hours) }]
			})
		);
		return {
			postId: out.posts[0].postIds[0] as string,
			deliveryId: out.posts[0].deliveries[0].deliveryId as string
		};
	}

	it('reschedules by post or delivery, idempotently, with before and after', async () => {
		const a = await scheduleOne('jobjob.linkedin', 30);
		const b = await scheduleOne('unbranded.bluesky', 31);
		const args = {
			items: [
				{
					postId: a.postId,
					runAt: { localTime: '2027-07-01T10:30', timeZone: 'America/New_York' }
				},
				{ deliveryId: b.deliveryId, runAt: '2027-07-02T08:00:00Z' }
			]
		};
		const out = data(await call('reschedule_posts', args));
		expect(out.status).toBe('rescheduled');
		expect(out.deliveries[0]).toMatchObject({
			channel: { key: 'jobjob.linkedin' },
			after: {
				utc: '2027-07-01T14:30:00.000Z',
				local: '2027-07-01T16:30:00+02:00',
				weekday: 'Thursday'
			}
		});
		expect(out.deliveries[0].before.utc).not.toBe(out.deliveries[0].after.utc);
		const again = data(await call('reschedule_posts', args));
		expect(again.deliveries[0].before.utc).toBe(again.deliveries[0].after.utc);
		const rows = await h.deliveries();
		expect(rows.find((r) => r.id === b.deliveryId)!.scheduledFor!.toISOString()).toBe(
			'2027-07-02T08:00:00.000Z'
		);
		const now = await call('reschedule_posts', { items: [{ postId: a.postId, runAt: 'now' }] });
		expect(text(now)).toContain('publish_now');
	});

	it('moves a post to another channel only with confirmation, cancelling the old one first', async () => {
		const a = await scheduleOne('jobjob.linkedin', 30);
		const preview = data(
			await call('move_post', {
				postId: a.postId,
				from: ['jobjob.linkedin'],
				to: ['unbranded.bluesky']
			})
		);
		expect(preview).toMatchObject({ status: 'confirmation_required', committed: false });
		expect(preview.before.map((d: { channel: { key: string } }) => d.channel.key)).toEqual([
			'jobjob.linkedin'
		]);
		expect(preview.after.map((d: { channel: { key: string } }) => d.channel.key)).toEqual([
			'unbranded.bluesky'
		]);
		expect((await h.deliveries()).filter((d) => d.status === 'scheduled')).toHaveLength(1);
		const moved = data(
			await call('move_post', {
				postId: a.postId,
				from: ['jobjob.linkedin'],
				to: ['unbranded.bluesky'],
				confirmToken: preview.confirmToken
			})
		);
		expect(moved.status).toBe('moved');
		const rows = await h.deliveries();
		expect(rows.find((r) => r.connectionId === ids.jobjobLinkedin)!.status).toBe('cancelled');
		const fresh = rows.find((r) => r.connectionId === ids.bluesky)!;
		expect(fresh.status).toBe('scheduled');
		expect(fresh.scheduledFor!.toISOString()).toBe(preview.before[0].runAt.utc);
		expect(moved.after[0]).toMatchObject({
			channel: { key: 'unbranded.bluesky' },
			status: 'scheduled'
		});
	});

	it('cancels by delivery and by channel, leaves cancelled ones alone, and refuses published ones', async () => {
		const a = await scheduleOne('jobjob.linkedin', 30);
		const out = data(
			await call('cancel_posts', { items: [{ postId: a.postId, channels: ['jobjob.linkedin'] }] })
		);
		expect(out.deliveries[0]).toMatchObject({
			status: 'cancelled',
			channel: { key: 'jobjob.linkedin' }
		});
		const again = data(await call('cancel_posts', { items: [{ deliveryId: a.deliveryId }] }));
		expect(again.deliveries[0].status).toBe('cancelled');
		const b = await scheduleOne('unbranded.bluesky', 31);
		await h.db
			.update(publishTargets)
			.set({ status: 'published', remotePostId: 'x' })
			.where(eq(publishTargets.id, b.deliveryId));
		const refused = await call('cancel_posts', { items: [{ deliveryId: b.deliveryId }] });
		expect(refused.isError).toBe(true);
		expect(data(refused).code).toBe('not_cancellable');
	});

	it('lists by brand, channel and day with cursor paging, and gets one post', async () => {
		for (let i = 0; i < 3; i++) await scheduleOne('jobjob.linkedin', 30 + i);
		await scheduleOne('unbranded.bluesky', 35);
		const page1 = data(await call('list_posts', { brand: 'jobjob', limit: 2 }));
		expect(page1.posts).toHaveLength(2);
		expect(page1.nextCursor).toBeTruthy();
		expect(page1.posts[0]).not.toHaveProperty('text');
		const page2 = data(
			await call('list_posts', { brand: 'jobjob', limit: 2, cursor: page1.nextCursor })
		);
		expect(page2.posts).toHaveLength(1);
		expect(page2.nextCursor).toBeNull();
		const times = [...page1.posts, ...page2.posts].map(
			(p: { when: { utc: string } }) => p.when.utc
		);
		expect([...times].sort()).toEqual(times);
		const bluesky = data(
			await call('list_posts', { channel: 'unbranded.bluesky', response_format: 'detailed' })
		);
		expect(bluesky.posts).toHaveLength(1);
		expect(bluesky.posts[0]).toMatchObject({
			channel: 'unbranded.bluesky',
			text: 'On unbranded.bluesky'
		});
		const none = data(await call('list_posts', { from: '2020-01-01', to: '2020-01-02' }));
		expect(none.posts).toEqual([]);
		const post = data(
			await call('get_post', { postId: bluesky.posts[0].postId, response_format: 'detailed' })
		);
		expect(post.post.deliveries[0].channel.key).toBe('unbranded.bluesky');
		expect(post.post.checks).toMatchObject({ ok: true });
	});

	it('refuses every write with a read-only key and writes nothing', async () => {
		const readOnly = await h.connect(['read']);
		for (const [name, args] of [
			[
				'schedule_posts',
				{ posts: [{ channels: ['jobjob.linkedin'], text: 'x', runAt: inHours(30) }] }
			],
			['reschedule_posts', { items: [{ postId: 'p', runAt: inHours(30) }] }],
			['move_post', { postId: 'p', to: ['jobjob.linkedin'] }],
			['cancel_posts', { items: [{ postId: 'p' }] }],
			['publish_now', { postId: 'p', channels: ['jobjob.linkedin'] }],
			['save_draft', { text: 'x' }]
		] as const) {
			const result = await readOnly.callTool({ name, arguments: args });
			expect(result.isError, name).toBe(true);
			expect(data(result).status, name).toBe(403);
		}
		expect((await readOnly.callTool({ name: 'list_posts', arguments: {} })).isError).toBeFalsy();
		expect(await h.deliveries()).toEqual([]);
	});
});
