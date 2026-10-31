import { createOAuthCallback } from '#lib/server/oauth-callback.js';
import { decryptSecret } from '#lib/server/crypto.js';
import { tiktokExchangeCode } from '#lib/server/providers/index.js';

/** What the operator chose on the Accounts page, which a reconnect keeps. */
const SETTINGS = ['tiktokPrivacy', 'tiktokAllowComment', 'tiktokAllowDuet', 'tiktokAllowStitch'];

export const GET = createOAuthCallback({
	platform: 'tiktok',
	pendingMarker: 'tiktok',
	accountIdKey: 'tiktokOpenId',
	reconcileMeta(incoming, existing) {
		const kept = Object.fromEntries(
			SETTINGS.filter((key) => existing[key] !== undefined).map((key) => [key, existing[key]])
		);
		return { ...incoming, ...kept };
	},
	async complete({ pending, code, env }) {
		const clientSecret = await decryptSecret(pending.clientSecretEnc, env.APP_ENCRYPTION_KEY);
		const exchanged = await tiktokExchangeCode({
			clientKey: pending.clientId,
			clientSecret,
			code,
			appUrl: env.APP_URL
		});
		return {
			// Unlike Instagram the secret stays: TikTok's refresh needs it, and the
			// access token lasts only a day.
			credentials: {
				accessToken: exchanged.accessToken,
				refreshToken: exchanged.refreshToken,
				expiresAt: exchanged.expiresAt,
				refreshExpiresAt: exchanged.refreshExpiresAt,
				tokenType: exchanged.tokenType,
				scopes: exchanged.scopes,
				clientId: pending.clientId,
				clientSecret,
				tiktokOpenId: exchanged.tiktokOpenId,
				tiktokUsername: exchanged.tiktokUsername
			},
			displayName: exchanged.displayName,
			handle: exchanged.handle,
			avatarUrl: exchanged.avatarUrl,
			meta: {
				tiktokOpenId: exchanged.tiktokOpenId,
				maxCharacters: exchanged.maxCharacters,
				...(exchanged.tiktokPrivacyOptions
					? { tiktokPrivacyOptions: exchanged.tiktokPrivacyOptions }
					: {}),
				...(exchanged.tiktokMaxVideoSec ? { tiktokMaxVideoSec: exchanged.tiktokMaxVideoSec } : {}),
				...(exchanged.tiktokCommentDisabled !== undefined
					? {
							tiktokCommentDisabled: exchanged.tiktokCommentDisabled,
							tiktokDuetDisabled: exchanged.tiktokDuetDisabled,
							tiktokStitchDisabled: exchanged.tiktokStitchDisabled
						}
					: {})
			}
		};
	}
});
