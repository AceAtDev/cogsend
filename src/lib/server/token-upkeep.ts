import { and, eq, ne } from 'drizzle-orm';
import { isZernioConnection } from '#lib/domain/zernio.js';
import { parseJson, type AppDb } from './db/client';
import { connections } from './db/schema';
import { countingFetch, type SubrequestBudget } from './budget';
import { decryptJson, encryptJson } from './crypto';
import type { AppEnv } from './env';
import { getProvider } from './providers';
import { providerFetch } from './providers/timed-fetch';
import {
	classifyProviderError,
	type ConnectionCredentials,
	type FetchLike
} from './providers/types';
import { refreshWithStoredRetry } from './publish';

const DAY = 24 * 60 * 60_000;

/**
 * Platforms whose long-lived token is only refreshed when used. Without this
 * an account that posts less often than about every seven weeks (Instagram,
 * Threads) or two months (LinkedIn) expires between posts. X and TikTok are
 * left out on purpose: their access tokens last hours and every publish
 * refreshes them; what limits them is the refresh token, warned about below.
 */
export const REFRESH_AHEAD_PLATFORMS = new Set(['instagram', 'threads', 'linkedin']);
/** Refresh once the token has this little left (providers refresh inside their own skew). */
export const REFRESH_AHEAD_MS = 8 * DAY;
/** Warn this far ahead of a date only a reconnect can move. */
export const EXPIRY_WARNING_MS = 7 * DAY;
/** Refreshes per run: each costs a platform call and a write. */
const REFRESHES_PER_RUN = 3;
/** Calls a refresh needs, with room left for the write that follows. */
const REFRESH_CALLS = 3;

/** What the connection's metadata records about an upcoming forced reconnect. */
export type ExpiryMeta = {
	/** When the account stops working unless it is reconnected (epoch ms). */
	reconnectBy?: number;
	/** When the owner was told about `reconnectBy`; the alert source reads it. */
	expiryWarnedAt?: number;
};

/**
 * The moment only a reconnect can push back, or null while the platform will
 * keep extending the token on its own. Instagram and Threads extend with the
 * access token itself; others need a refresh token.
 */
export function reconnectDeadline(platform: string, creds: ConnectionCredentials): number | null {
	if (typeof creds.refreshExpiresAt === 'number') return creds.refreshExpiresAt;
	const selfRefreshing = platform === 'instagram' || platform === 'threads';
	if (selfRefreshing || creds.refreshToken) return null;
	return typeof creds.expiresAt === 'number' ? creds.expiresAt : null;
}

export type TokenUpkeepResult = { refreshed: number; expired: number; warned: number };

/**
 * Keep connections working between posts: refresh long-lived tokens before
 * they lapse, and record (for the "Account needs reconnecting" alert) any
 * account whose access will end within a week in a way only a reconnect can
 * fix. Runs with the hourly janitors, after publishing, on the calls the tick
 * has left. Never throws for one bad connection.
 */
export async function runTokenUpkeep(
	db: AppDb,
	env: AppEnv,
	opts: { fetchImpl?: FetchLike; budget?: SubrequestBudget | null; now?: number } = {}
): Promise<TokenUpkeepResult> {
	const now = opts.now ?? Date.now();
	const budget = opts.budget ?? null;
	const base = opts.fetchImpl ?? providerFetch;
	const fetchImpl = budget ? countingFetch(base, budget) : base;
	const result: TokenUpkeepResult = { refreshed: 0, expired: 0, warned: 0 };
	if (budget && budget.remaining < 2) return result;
	const rows = await db
		.select({
			id: connections.id,
			platform: connections.platform,
			credentialsEncrypted: connections.credentialsEncrypted,
			metaJson: connections.metaJson
		})
		.from(connections)
		.where(and(eq(connections.status, 'active'), ne(connections.credentialsEncrypted, '')));
	for (const row of rows) {
		if (isZernioConnection(row.metaJson)) continue;
		let creds: ConnectionCredentials;
		try {
			creds = await decryptJson<ConnectionCredentials>(
				row.credentialsEncrypted,
				env.APP_ENCRYPTION_KEY
			);
		} catch {
			continue;
		}
		const provider = getProvider(row.platform);
		const dueForRefresh =
			REFRESH_AHEAD_PLATFORMS.has(row.platform) &&
			provider.refreshIfNeeded &&
			typeof creds.expiresAt === 'number' &&
			creds.expiresAt - now <= REFRESH_AHEAD_MS &&
			!provider.refreshImpossibleReason?.(creds);
		if (
			dueForRefresh &&
			result.refreshed < REFRESHES_PER_RUN &&
			(!budget || budget.remaining >= REFRESH_CALLS)
		) {
			try {
				const refreshed = await refreshWithStoredRetry(
					db,
					env,
					row.id,
					row.credentialsEncrypted,
					creds,
					(c) => provider.refreshIfNeeded!(c, fetchImpl)
				);
				if (JSON.stringify(refreshed) !== JSON.stringify(creds)) {
					// Only over what was read: a publish that refreshed meanwhile wins.
					await db
						.update(connections)
						.set({
							credentialsEncrypted: await encryptJson(refreshed, env.APP_ENCRYPTION_KEY),
							updatedAt: new Date(now)
						})
						.where(
							and(
								eq(connections.id, row.id),
								eq(connections.credentialsEncrypted, row.credentialsEncrypted)
							)
						);
					creds = refreshed;
					result.refreshed++;
				}
			} catch (err) {
				if (classifyProviderError(err).code === 'auth') {
					// The platform refused the refresh: the account is gone until
					// reconnected. Expiring it raises the reconnect alert now,
					// rather than when the next post fails.
					await db
						.update(connections)
						.set({ status: 'expired', updatedAt: new Date(now) })
						.where(and(eq(connections.id, row.id), eq(connections.status, 'active')));
					result.expired++;
					continue;
				}
				// A platform outage or rate limit: try again next hour.
				console.error('[token-upkeep] refresh failed', row.platform, row.id, err);
			}
		}
		const deadline = reconnectDeadline(row.platform, creds);
		const meta = parseJson<Record<string, unknown> & ExpiryMeta>(row.metaJson, {});
		if (deadline != null && deadline > now && deadline - now <= EXPIRY_WARNING_MS) {
			if (meta.reconnectBy === deadline && typeof meta.expiryWarnedAt === 'number') continue;
			if (budget && budget.remaining < 1) continue;
			await db
				.update(connections)
				.set({
					metaJson: JSON.stringify({ ...meta, reconnectBy: deadline, expiryWarnedAt: now })
				})
				.where(eq(connections.id, row.id));
			result.warned++;
		} else if (
			meta.reconnectBy != null &&
			(deadline == null || deadline - now > EXPIRY_WARNING_MS)
		) {
			// Reconnected or extended since the warning: clear it.
			if (budget && budget.remaining < 1) continue;
			const { reconnectBy: _r, expiryWarnedAt: _w, ...rest } = meta;
			await db
				.update(connections)
				.set({ metaJson: JSON.stringify(rest) })
				.where(eq(connections.id, row.id));
		}
	}
	return result;
}
