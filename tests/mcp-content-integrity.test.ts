import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createMcpHarness, data, inHours } from './mcp-harness';
import { draftMedia, drafts, draftVariants } from '#lib/server/db/schema.js';

let h: Awaited<ReturnType<typeof createMcpHarness>>;
let client: Awaited<ReturnType<typeof h.connect>>;
beforeEach(async () => {
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.reject(new Error('NETWORK BLOCKED BY TEST')))
	);
	h = await createMcpHarness();
	const brand = await h.brand('QA', 'qa', '#2563eb', { requireApproval: true });
	await h.channel('linkedin', 'qa', brand);
	client = await h.connect();
});
afterEach(async () => {
	await h.close();
	vi.unstubAllGlobals();
});
const call = (name: string, args: Record<string, unknown>) =>
	client.callTool({ name, arguments: args });

it.each(['schedule_posts', 'publish_now', 'move_post'])(
	'%s refuses stale saved content and accepts a fresh preview',
	async (tool) => {
		const postId = data(await call('save_draft', { text: 'Approved text' })).postId;
		const args =
			tool === 'schedule_posts'
				? { posts: [{ draftId: postId, channels: ['qa.linkedin'], runAt: inHours(30) }] }
				: tool === 'publish_now'
					? { postId, channels: ['qa.linkedin'] }
					: { postId, to: ['qa.linkedin'], runAt: inHours(30) };
		const preview = data(await call(tool, { ...args, dryRun: true }));
		expect(preview.confirmToken).toBeTruthy();
		await call('save_draft', { draftId: postId, text: 'Changed text' });
		const stale = await call(tool, { ...args, confirmToken: preview.confirmToken });
		expect(stale.isError).toBe(true);
		expect(data(stale).code).toBe('confirm_payload_mismatch');
		expect(await h.deliveries()).toHaveLength(0);
		const fresh = data(await call(tool, { ...args, dryRun: true }));
		const result = data(await call(tool, { ...args, confirmToken: fresh.confirmToken }));
		expect(result.committed).toBe(true);
	}
);

it.each(['variant', 'media'])('schedule confirmations bind saved %s content', async (kind) => {
	const postId = data(
		await call('save_draft', {
			text: 'Approved',
			variants: [{ platform: 'linkedin', text: 'Approved variant' }]
		})
	).postId;
	if (kind === 'media')
		await h.db.insert(draftMedia).values({
			id: 'test-media',
			draftId: postId,
			storageKey: 'test.jpg',
			mime: 'image/jpeg',
			size: 100,
			width: 100,
			height: 100,
			altText: 'Approved alt',
			createdAt: new Date()
		});
	const posts = [{ draftId: postId, channels: ['qa.linkedin'], runAt: inHours(30) }];
	const preview = data(await call('schedule_posts', { posts, dryRun: true }));
	expect(preview.confirmToken).toBeTruthy();
	if (kind === 'variant')
		await h.db
			.update(draftVariants)
			.set({ body: 'Changed variant' })
			.where(eq(draftVariants.draftId, postId));
	else
		await h.db
			.update(draftMedia)
			.set({ altText: 'Changed alt' })
			.where(eq(draftMedia.draftId, postId));
	const result = await call('schedule_posts', { posts, confirmToken: preview.confirmToken });
	expect(result.isError).toBe(true);
	expect(data(result).code).toBe('confirm_payload_mismatch');
});

it('rejects repeated draft IDs before mutating any entry', async () => {
	const postId = data(await call('save_draft', { text: 'Original' })).postId;
	const result = await call('schedule_posts', {
		posts: [
			{ draftId: postId, channels: ['qa.linkedin'], text: 'First', runAt: inHours(30) },
			{ draftId: postId, channels: ['qa.linkedin'], text: 'Second', runAt: inHours(33) }
		]
	});
	expect(result.isError).toBe(true);
	expect(data(result).code).toBe('duplicate_draft');
	expect(await h.deliveries()).toHaveLength(0);
	expect((await h.db.select().from(drafts))[0].baseBody).toBe('Original');
});

it.each([false, true])(
	'preflights all variant sizes without partial writes (existing=%s)',
	async (existing) => {
		const postId = existing
			? data(await call('save_draft', { text: 'Original' })).postId
			: undefined;
		const before = await h.db.select().from(drafts);
		const result = await call('save_draft', {
			draftId: postId,
			text: 'Should not save',
			variants: [
				{ platform: 'bluesky', text: 'Should not save either' },
				{ platform: 'linkedin', options: { spoilerText: '\\'.repeat(50_000) } }
			]
		});
		expect(result.isError).toBe(true);
		expect(data(result).error).toContain('too large');
		expect(await h.db.select().from(drafts)).toEqual(before);
		expect(await h.db.select().from(draftVariants)).toHaveLength(0);
	}
);

it('generic validation aggregates platform text failures truthfully', async () => {
	const invalid = data(await call('validate_post', { text: 'x'.repeat(10_000) }));
	expect(invalid.ok).toBe(false);
	expect(invalid.issues).toHaveLength(7);
	expect(data(await call('validate_post', { text: 'Short text' })).ok).toBe(true);
	expect(
		data(await call('validate_post', { text: 'x'.repeat(600), platform: 'linkedin' })).ok
	).toBe(true);
});
