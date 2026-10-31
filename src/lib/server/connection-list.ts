import { and, desc, eq, ne } from 'drizzle-orm';
import type { AppEnv } from './env';
import type { AppDb } from './db/client';
import { connections } from './db/schema';
import { platformCredentialStatus } from './platform-credentials';
import { serializeConnection } from './serialize';
import { assignChannelKeys } from '#lib/domain/channel-keys.js';
import { listBrandRows, serializeBrand } from './brands';

/** Accounts the UI and `GET /api/connections` both show. Same payload either way. */
export async function listConnections(db: AppDb, env: AppEnv, userId: string) {
	const rows = await db
		.select({
			id: connections.id,
			platform: connections.platform,
			displayName: connections.displayName,
			handle: connections.handle,
			avatarUrl: connections.avatarUrl,
			instanceUrl: connections.instanceUrl,
			status: connections.status,
			metaJson: connections.metaJson,
			createdAt: connections.createdAt,
			brandId: connections.brandId
		})
		.from(connections)
		.where(and(eq(connections.userId, userId), ne(connections.status, 'disconnected')))
		.orderBy(desc(connections.createdAt));
	const [{ configured, secrets, sources, savedClientIds }, brandRows] = await Promise.all([
		platformCredentialStatus(db, env),
		listBrandRows(db, userId)
	]);
	const channels = assignChannelKeys(brandRows, rows);
	const channelById = new Map(channels.map((c) => [c.connectionId, c]));
	return {
		connections: rows.map((row) => ({
			...serializeConnection(row),
			brandId: row.brandId ?? null,
			channelKey: channelById.get(row.id)?.key ?? null,
			channelKeys: channelById.get(row.id)?.keys ?? []
		})),
		brands: brandRows.map(serializeBrand),
		configured,
		secrets,
		sources,
		savedClientIds,
		appUrl: env.APP_URL
	};
}
