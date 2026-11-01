import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CLIENT_CAPABILITIES_META_KEY,
	PROTOCOL_VERSION_META_KEY
} from '@modelcontextprotocol/server';
import { createTestAdmin, createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { newId } from '#lib/server/db/client.js';
import { connections, draftMedia, drafts, publishTargets } from '#lib/server/db/schema.js';
import { memoryMediaStore, thumbCacheKey } from '#lib/server/media.js';
import * as publish from '#lib/server/publish.js';
import { DELETE, GET, POST } from '../src/routes/api/mcp/+server';

type McpTool = {
	name: string;
	annotations: Record<string, unknown>;
	inputSchema: { properties?: Record<string, unknown>; required?: string[] };
};
type ToolCallResult = {
	isError?: boolean;
	structuredContent?: Record<string, unknown>;
	content?: Array<{ text: string }>;
};
type McpPayload = {
	result?: ToolCallResult & { tools?: McpTool[] };
	error?: unknown;
};

let db: Awaited<ReturnType<typeof createTestDb>>['db'];
let closeDb: (() => void) | undefined;
let user: {
	id: string;
	email: string;
	timezone: string;
	totpEnabled: boolean;
	mfaVerified: boolean;
};

beforeEach(async () => {
	const testDb = await createTestDb();
	db = testDb.db;
	closeDb = testDb.close;
	const row = await createTestAdmin(db, { totpEnabled: true });
	user = {
		id: row.id,
		email: row.email,
		timezone: row.timezone,
		totpEnabled: true,
		mfaVerified: true
	};
});

afterEach(() => {
	closeDb?.();
	closeDb = undefined;
	vi.restoreAllMocks();
});

function requestEvent(
	request: Request,
	overrides: Record<string, unknown> = {},
	waitUntil?: (promise: Promise<unknown>) => void
) {
	const locals = {
		user,
		apiKeyScopes: ['read', 'write'],
		db,
		env: TEST_ENV,
		media: createTestMedia(),
		...(waitUntil && { waitUntil }),
		...overrides
	};
	return { request, locals, url: new URL(request.url) } as never;
}

async function seedDraft(ownerId = user.id) {
	const id = newId();
	const now = new Date();
	await db.insert(drafts).values({
		id,
		userId: ownerId,
		title: 'MCP test draft',
		baseBody: 'Test body',
		status: 'draft',
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function seedConnection(ownerId = user.id) {
	const id = newId();
	const now = new Date();
	await db.insert(connections).values({
		id,
		userId: ownerId,
		platform: 'mastodon',
		handle: 'test@mastodon.example',
		instanceUrl: 'https://mastodon.example',
		credentialsEncrypted: '{}',
		metaJson: '{}',
		status: 'active',
		createdAt: now,
		updatedAt: now
	});
	return id;
}

async function postMcp(
	method: string,
	params: Record<string, unknown> = {},
	overrides: Record<string, unknown> = {},
	{
		includeProtocolVersion = true,
		waitUntil
	}: {
		includeProtocolVersion?: boolean;
		waitUntil?: (promise: Promise<unknown>) => void;
	} = {}
) {
	const headers = new Headers({
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream',
		'mcp-method': method
	});
	const wireParams = includeProtocolVersion
		? {
				...params,
				_meta: {
					[PROTOCOL_VERSION_META_KEY]: '2026-07-28',
					[CLIENT_CAPABILITIES_META_KEY]: {}
				}
			}
		: params;
	if (includeProtocolVersion) headers.set('mcp-protocol-version', '2026-07-28');
	if (method === 'tools/call' && typeof params.name === 'string') {
		headers.set('mcp-name', params.name);
	}
	const request = new Request('https://cogsend.example/api/mcp', {
		method: 'POST',
		headers,
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: wireParams })
	});
	const response = await POST(requestEvent(request, overrides, waitUntil));
	return { response, payload: (await response.json()) as McpPayload };
}

describe('MCP route', () => {
	it('returns JSON, not an SSE stream, for a legacy-classified POST', async () => {
		const { response } = await postMcp('tools/list', {}, {}, { includeProtocolVersion: false });
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('content-type')).not.toContain('text/event-stream');
		expect(response.headers.get('mcp-session-id')).toBeNull();
	});

	it('serves a 2025-era client: initialize, then tools/list', async () => {
		const legacyPost = (body: unknown, version?: string) =>
			POST(
				requestEvent(
					new Request('https://cogsend.example/api/mcp', {
						method: 'POST',
						headers: {
							authorization: 'Bearer test',
							'content-type': 'application/json',
							accept: 'application/json, text/event-stream',
							...(version ? { 'mcp-protocol-version': version } : {})
						},
						body: JSON.stringify(body)
					})
				)
			);
		const init = await legacyPost({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'legacy-client', version: '1.0.0' }
			}
		});
		expect(init.status).toBe(200);
		const initPayload = (await init.json()) as { result?: { protocolVersion: string } };
		expect(initPayload.result?.protocolVersion).toBe('2025-06-18');

		const list = await legacyPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, '2025-06-18');
		expect(list.status).toBe(200);
		const listPayload = (await list.json()) as { result?: { tools: { name: string }[] } };
		expect(listPayload.result?.tools.map((t) => t.name)).toContain('schedule_posts');
	});

	it('rejects subscription streams instead of opening SSE', async () => {
		const { response, payload } = await postMcp('subscriptions/listen');
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('content-type')).not.toContain('text/event-stream');
		expect(payload.error).toEqual({ code: -32601, message: 'Method not found' });
	});

	it('enforces JSON content type before the subscription-stream guard', async () => {
		const request = new Request('https://cogsend.example/api/mcp', {
			method: 'POST',
			headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'subscriptions/listen' })
		});
		const response = await POST(requestEvent(request));
		const payload = (await response.json()) as { error: { message: string } };
		expect(response.status).toBe(415);
		expect(payload.error.message).toContain('Unsupported Media Type');
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(response.headers.get('content-type')).not.toContain('text/event-stream');
	});

	it('returns structured tool results with the same JSON as text, and enforces write scope', async () => {
		const success = await postMcp('tools/call', {
			name: 'save_draft',
			arguments: { title: 'From MCP', text: 'Hello from the tool.' }
		});
		const result = success.payload.result!;
		expect(result.isError).not.toBe(true);
		expect(result.structuredContent).toMatchObject({ status: 'created' });
		const text = result.content![0].text;
		expect(text).toContain('Created draft');
		expect(JSON.parse(text.slice(text.indexOf('\n\n') + 2))).toEqual(result.structuredContent);

		const denied = await postMcp(
			'tools/call',
			{ name: 'save_draft', arguments: { title: 'Nope' } },
			{ apiKeyScopes: ['read'] }
		);
		expect(denied.payload.result!.isError).toBe(true);
		expect(denied.payload.result!.structuredContent).toMatchObject({
			error: 'This API key is read-only; this tool needs a Read + write key.',
			status: 403
		});
		expect(await db.select().from(drafts)).toHaveLength(1);
	});

	it('requires read scope and an authenticated user for read tools', async () => {
		const scopeDenied = await postMcp(
			'tools/call',
			{ name: 'list_channels', arguments: {} },
			{ apiKeyScopes: [] }
		);
		expect(scopeDenied.payload.result!.structuredContent).toMatchObject({
			error: 'This API key has no read access.',
			status: 403
		});
		const unauthenticated = await postMcp(
			'tools/call',
			{ name: 'list_channels', arguments: {} },
			{ user: null }
		);
		expect(unauthenticated.payload.result!.structuredContent).toMatchObject({
			error: 'Unauthorized',
			status: 401
		});
	});

	it('preserves ownership checks for fetched posts', async () => {
		const otherUser = await createTestAdmin(db, {
			email: `other-${newId()}@localhost`,
			totpEnabled: true
		});
		const draftId = await seedDraft(otherUser.id);
		const { payload } = await postMcp('tools/call', {
			name: 'get_post',
			arguments: { postId: draftId }
		});
		expect(payload.result!.isError).toBe(true);
		expect(payload.result!.structuredContent).toMatchObject({ status: 404, code: 'not_found' });
	});

	it('deletes a post with its media and cached thumbnails, like the REST route', async () => {
		const draftId = await seedDraft();
		const storageKey = `${Date.now()}-abcdef0123456789.png`;
		const store = new Map<string, { bytes: Uint8Array; mime: string }>();
		store.set(storageKey, { bytes: new Uint8Array([1]), mime: 'image/png' });
		store.set(thumbCacheKey(storageKey), { bytes: new Uint8Array([2]), mime: 'image/webp' });
		await db.insert(draftMedia).values({
			id: newId(),
			draftId,
			storageKey,
			mime: 'image/png',
			size: 1,
			sortOrder: 0,
			segmentIndex: 0,
			createdAt: new Date()
		});
		const { payload } = await postMcp(
			'tools/call',
			{ name: 'cancel_posts', arguments: { items: [{ postId: draftId }], deletePost: true } },
			{ media: memoryMediaStore(store) }
		);
		expect(payload.result!.structuredContent).toMatchObject({
			status: 'deleted',
			deleted: [draftId]
		});
		expect(store.size).toBe(0);
		expect(await db.select().from(drafts).where(eq(drafts.id, draftId))).toEqual([]);
	});

	async function confirmed(name: string, args: Record<string, unknown>, extra = {}) {
		const preview = await postMcp('tools/call', { name, arguments: args }, extra);
		const token = preview.payload.result!.structuredContent!.confirmToken as string;
		expect(token).toMatch(/^cfm_/);
		return postMcp('tools/call', { name, arguments: { ...args, confirmToken: token } }, extra);
	}

	it('skips channels already published and refuses to schedule them again', async () => {
		const draftId = await seedDraft();
		const connectionId = await seedConnection();
		const now = new Date();
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId,
			status: 'published',
			remotePostId: 'remote-post-1',
			remoteUrl: 'https://mastodon.example/@test/1',
			attemptCount: 1,
			createdAt: now,
			updatedAt: now
		});
		const published = await confirmed('publish_now', {
			postId: draftId,
			channels: ['unbranded.mastodon']
		});
		expect(published.payload.result!.structuredContent!.deliveries).toMatchObject([
			{ status: 'published', channel: { key: 'unbranded.mastodon' } }
		]);
		const scheduled = await postMcp('tools/call', {
			name: 'schedule_posts',
			arguments: {
				posts: [
					{
						draftId,
						channels: ['unbranded.mastodon'],
						runAt: new Date(Date.now() + 60 * 60 * 1000).toISOString()
					}
				]
			}
		});
		expect(scheduled.payload.result!.isError).toBe(true);
		expect(scheduled.payload.result!.structuredContent).toMatchObject({ status: 409 });
	});

	it('preserves partial publish stop metadata without leaking internal errors', async () => {
		const draftId = await seedDraft();
		await seedConnection();
		const publishTarget = vi
			.spyOn(publish, 'publishTarget')
			.mockRejectedValueOnce(new Error('private database connection string'));
		const { payload } = await confirmed('publish_now', {
			postId: draftId,
			channels: ['unbranded.mastodon']
		});
		const structured = payload.result!.structuredContent!;
		expect(publishTarget).toHaveBeenCalledOnce();
		expect(structured).toMatchObject({
			status: 'partial',
			error: 'Publishing stopped early — try again for the rest'
		});
		expect(JSON.stringify(payload)).not.toContain('private database connection string');
	});

	it('redacts unknown server errors from tool content and structured output', async () => {
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { payload } = await postMcp(
			'tools/call',
			{ name: 'get_post', arguments: { postId: 'draft-1' } },
			{
				db: {
					select: () => {
						throw new Error('private database connection string');
					}
				}
			}
		);
		const result = payload.result!;
		expect(result.isError).toBe(true);
		expect(result.content![0].text).toBe('Something went wrong on the server');
		expect(JSON.stringify(result.structuredContent)).not.toContain(
			'private database connection string'
		);
		expect(result.structuredContent!.status).toBe(500);
		expect(log).toHaveBeenCalledOnce();
	});

	it('keeps a retried publish alive with waitUntil, like the REST route', async () => {
		const draftId = await seedDraft();
		const connectionId = await seedConnection();
		const now = new Date();
		await db.insert(publishTargets).values({
			id: newId(),
			draftId,
			connectionId,
			status: 'failed',
			attemptCount: 5,
			createdAt: now,
			updatedAt: now
		});
		vi.spyOn(publish, 'publishTarget').mockResolvedValueOnce({ status: 'published' } as never);
		const background: Promise<unknown>[] = [];
		const waitUntil = (promise: Promise<unknown>) => background.push(promise);
		const args = { postId: draftId, channels: ['unbranded.mastodon'] };
		const preview = await postMcp(
			'tools/call',
			{ name: 'publish_now', arguments: args },
			{},
			{ waitUntil }
		);
		const token = preview.payload.result!.structuredContent!.confirmToken;
		const { payload } = await postMcp(
			'tools/call',
			{ name: 'publish_now', arguments: { ...args, confirmToken: token } },
			{},
			{ waitUntil }
		);
		expect(payload.result!.isError).toBeFalsy();
		expect(background).toHaveLength(1);
		await expect(background[0]).resolves.toBeUndefined();
	});

	it('returns 405 for GET and DELETE without issuing session IDs', async () => {
		for (const handler of [GET, DELETE]) {
			const response = await handler(requestEvent(new Request('https://cogsend.example/api/mcp')));
			expect(response.status).toBe(405);
			expect(response.headers.get('allow')).toBe('POST');
			expect(response.headers.get('mcp-session-id')).toBeNull();
		}
	});
});
