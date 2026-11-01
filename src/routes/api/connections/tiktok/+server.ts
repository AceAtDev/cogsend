import type { RequestHandler } from './$types';
import { randomHex } from '#lib/domain/bytes.js';
import { OAUTH_PENDING_TTL_MS } from '#lib/domain/oauth-pending.js';
import { encryptSecret } from '#lib/server/crypto.js';
import { oauthPending } from '#lib/server/db/schema.js';
import { handleError, ok } from '#lib/server/http.js';
import { resolvePlatformCredentials } from '#lib/server/platform-credentials.js';
import { platformNotConfigured } from '#lib/server/platform-setup.js';
import { tiktokAuthorizeUrl, tiktokScopes } from '#lib/server/providers/index.js';
import { tiktokMetricsEnabled } from '#lib/server/legal.js';
import { SESSION_COOKIE } from '#lib/server/auth.js';
import { bindOAuthState } from '#lib/server/oauth-state.js';
import { requireSession } from '#lib/server/require.js';

// TikTok documents PKCE only for desktop and mobile apps; a web app proves
// itself with the client secret at the token exchange.
export const POST: RequestHandler = async ({ locals, cookies }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const credentials = await resolvePlatformCredentials(locals.db, locals.env, 'tiktok');
		const clientKey = credentials?.values.TIKTOK_CLIENT_KEY;
		const clientSecret = credentials?.values.TIKTOK_CLIENT_SECRET;
		if (!clientKey || !clientSecret) return platformNotConfigured('tiktok');
		const state = randomHex(16);
		const sessionId = cookies.get(SESSION_COOKIE) ?? `machine:${user.id}`;
		const bound = await bindOAuthState({
			secret: locals.env.AUTH_SECRET,
			pendingId: state,
			sessionId
		});
		await locals.db.insert(oauthPending).values({
			id: state,
			userId: user.id,
			instanceUrl: 'tiktok',
			clientId: clientKey,
			clientSecretEnc: await encryptSecret(clientSecret, locals.env.APP_ENCRYPTION_KEY),
			expiresAt: new Date(Date.now() + OAUTH_PENDING_TTL_MS),
			createdAt: new Date()
		});
		return ok({
			authorizeUrl: tiktokAuthorizeUrl(
				clientKey,
				locals.env.APP_URL,
				bound,
				tiktokScopes(tiktokMetricsEnabled(locals.env))
			)
		});
	} catch (err) {
		return handleError(err);
	}
};
