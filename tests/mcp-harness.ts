import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestAdmin, createTestDb, createTestMedia, TEST_ENV } from '#lib/server/db/test.js';
import { newId } from '#lib/server/db/client.js';
import { brands, connections, publishTargets } from '#lib/server/db/schema.js';
import { rotateApiKey, verifyApiKey } from '#lib/server/api-keys.js';
import { POST } from '../src/routes/api/mcp/+server';

/**
 * The MCP route driven by the official client, in process, as an agent would
 * use it: a real key, real scopes, a real (in-memory) database.
 */
export async function createMcpHarness({ timezone = 'UTC' }: { timezone?: string } = {}) {
	const testDb = await createTestDb();
	const db = testDb.db;
	const row = await createTestAdmin(db, { totpEnabled: true });
	const user = {
		id: row.id,
		email: row.email,
		timezone,
		totpEnabled: true,
		mfaVerified: true
	};
	const clients: Client[] = [];
	const media = createTestMedia();
	const extraLocals: Record<string, unknown> = {};

	async function connect(scopes: Array<'read' | 'write'> = ['read', 'write']) {
		const raw = (await rotateApiKey(db, user.id, scopes)).raw;
		const transport = new StreamableHTTPClientTransport(
			new URL('https://cogsend.example/api/mcp'),
			{
				requestInit: { headers: { Authorization: `Bearer ${raw}` } },
				fetch: async (input, init) => {
					const request = new Request(input, init);
					const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
					const verified = token ? await verifyApiKey(db, token) : null;
					if (!verified) return Response.json({ error: 'Unauthorized' }, { status: 401 });
					return POST({
						request,
						url: new URL(request.url),
						locals: {
							user,
							apiKeyScopes: verified.scopes,
							authMethod: 'bearer',
							authCredential: 'personal_api_key',
							db,
							env: TEST_ENV,
							media,
							...extraLocals
						}
					} as never);
				}
			}
		);
		const client = new Client(
			{ name: 'cogsend-agent-test', version: '1.0.0' },
			{ versionNegotiation: { mode: { pin: '2026-07-28' } } }
		);
		await client.connect(transport);
		clients.push(client);
		return client;
	}

	/**
	 * Trusted unless asked otherwise: most suites exercise what scheduling does
	 * once a write is allowed through, and review has its own (mcp-review).
	 * The app's own default is the opposite.
	 */
	async function brand(
		name: string,
		slug: string,
		color = '#2563eb',
		{ requireApproval = false }: { requireApproval?: boolean } = {}
	) {
		const id = newId();
		const now = new Date();
		await db.insert(brands).values({
			id,
			userId: user.id,
			name,
			slug,
			color,
			requireApproval,
			createdAt: now,
			updatedAt: now
		});
		return id;
	}

	let created = 0;
	async function channel(
		platform: string,
		handle: string,
		brandId: string | null,
		overrides: Partial<typeof connections.$inferInsert> = {}
	) {
		const id = newId();
		// Distinct, increasing creation times keep key disambiguation deterministic.
		const at = new Date(Date.UTC(2026, 0, 1) + created++ * 1000);
		await db.insert(connections).values({
			id,
			userId: user.id,
			platform,
			handle,
			credentialsEncrypted: '{}',
			metaJson: '{}',
			status: 'active',
			brandId,
			createdAt: at,
			updatedAt: at,
			...overrides
		});
		return id;
	}

	async function deliveries() {
		return db.select().from(publishTargets);
	}

	return {
		db,
		user,
		media,
		extraLocals,
		connect,
		brand,
		channel,
		deliveries,
		close: async () => {
			for (const client of clients) await client.close();
			testDb.close();
		}
	};
}

export type McpResult = {
	isError?: boolean;
	structuredContent?: unknown;
	content?: unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read deep into loosely typed tool output
type Loose = any;
export const data = (result: McpResult) => result.structuredContent as Loose;
export const text = (result: McpResult) =>
	(result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n');

/** A time an hour or more ahead, as ISO 8601 UTC. */
export function inHours(hours: number): string {
	return new Date(Date.now() + hours * 3_600_000).toISOString();
}
