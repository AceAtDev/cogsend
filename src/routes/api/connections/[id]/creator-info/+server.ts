import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { isZernioConnection } from '#lib/domain/zernio.js';
import { decryptJson, encryptJson } from '#lib/server/crypto.js';
import { first, parseJson } from '#lib/server/db/client.js';
import { connections } from '#lib/server/db/schema.js';
import { fail, handleError } from '#lib/server/http.js';
import {
	getProvider,
	ProviderError,
	tiktokCannotPostReason,
	tiktokCreatorInfo,
	tiktokCreatorMeta,
	type ConnectionCredentials
} from '#lib/server/providers/index.js';
import { requireSession } from '#lib/server/require.js';
import { json } from '@sveltejs/kit';

// The guidelines want creator_info read when the post screen renders, and the
// avatar URL it returns lives two hours: nothing may keep a copy.
const NO_STORE = { 'cache-control': 'private, no-store' };

/**
 * A TikTok account's creator_info, read now, for the composer's TikTok panel:
 * who the post goes to, the privacy levels it may pick from, the interactions
 * the creator turned off, and the longest video it may post. A creator TikTok
 * is not letting post at the moment answers 200 with `canPost: false` and the
 * reason, so the composer can stop there. What it learns is kept on the
 * account for the checks a schedule makes.
 *
 * Session-only, like Verify: it may refresh and store the account's token.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const owned = and(eq(connections.id, params.id), eq(connections.userId, user.id));
		const conn = await first(locals.db.select().from(connections).where(owned));
		if (!conn) return fail('Not found', 404);
		if (conn.platform !== 'tiktok') return fail('Not a TikTok account', 400);
		if (isZernioConnection(conn.metaJson)) {
			return fail('Only a TikTok account connected directly has creator info', 400);
		}
		if (conn.status === 'disconnected') return fail('Account disconnected — reconnect it', 409);

		let creds = await decryptJson<ConnectionCredentials>(
			conn.credentialsEncrypted,
			locals.env.APP_ENCRYPTION_KEY
		);
		try {
			const refreshed = await getProvider('tiktok').refreshIfNeeded!(creds);
			if (refreshed.accessToken && refreshed.accessToken !== creds.accessToken) {
				creds = refreshed;
				await locals.db
					.update(connections)
					.set({
						credentialsEncrypted: await encryptJson(refreshed, locals.env.APP_ENCRYPTION_KEY),
						updatedAt: new Date()
					})
					.where(owned);
			}
		} catch (err) {
			if (err instanceof ProviderError && err.code === 'auth') {
				return json({ error: err.message, reconnect: true }, { status: 401, headers: NO_STORE });
			}
		}
		if (!creds.accessToken) {
			return json(
				{ error: 'TikTok credentials are missing a token — reconnect', reconnect: true },
				{ status: 401, headers: NO_STORE }
			);
		}

		let creator;
		try {
			creator = await tiktokCreatorInfo(creds.accessToken);
		} catch (err) {
			const reason = tiktokCannotPostReason(err);
			if (reason) return json({ creator: null, canPost: false, reason }, { headers: NO_STORE });
			if (err instanceof ProviderError && err.code === 'auth') {
				return json({ error: err.message, reconnect: true }, { status: 401, headers: NO_STORE });
			}
			const message = err instanceof Error ? err.message : 'TikTok did not answer';
			return json({ error: message }, { status: 502, headers: NO_STORE });
		}

		const meta = parseJson<Record<string, unknown>>(conn.metaJson, {});
		await locals.db
			.update(connections)
			.set({
				metaJson: JSON.stringify({ ...meta, ...tiktokCreatorMeta(creator) }),
				updatedAt: new Date()
			})
			.where(owned);
		return json(
			{
				canPost: true,
				creator: {
					nickname: creator.nickname ?? null,
					username: creator.username ?? null,
					avatarUrl: creator.avatarUrl ?? null,
					privacyOptions: creator.privacyOptions,
					commentDisabled: creator.commentDisabled,
					duetDisabled: creator.duetDisabled,
					stitchDisabled: creator.stitchDisabled,
					maxVideoSec: creator.maxVideoSec ?? null
				}
			},
			{ headers: NO_STORE }
		);
	} catch (err) {
		return handleError(err);
	}
};
