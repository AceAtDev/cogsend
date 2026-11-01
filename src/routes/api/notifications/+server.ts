import type { RequestHandler } from './$types';
import {
	normalizeAddress,
	normalizeAppPassword,
	parseDigestTime,
	parseSmtpPort,
	SENDER_PROVIDERS,
	type SenderProvider
} from '#lib/domain/notifications.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import {
	ensureAlertCursors,
	forgetSender,
	listRecipients,
	publicSettings,
	readSettings,
	resendAvailable,
	saveSettings,
	type SettingsPatch
} from '#lib/server/notify/store.js';

// Session-only, like the API key routes: the settings hold a mailbox password
// and decide where account news is emailed, so a leaked API key must not be
// able to read the list or redirect it.

export const GET: RequestHandler = async ({ locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const [row, recipients] = await Promise.all([
			readSettings(locals.db, user.id),
			listRecipients(locals.db, user.id)
		]);
		return ok({
			settings: publicSettings(row, locals.env, user.role),
			recipients,
			timezone: user.timezone
		});
	} catch (err) {
		return handleError(err);
	}
};

export const PATCH: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
		if (!body || typeof body !== 'object' || Array.isArray(body)) {
			return fail('Invalid payload', 400);
		}
		const patch: SettingsPatch = {};
		if ('enabled' in body) {
			if (typeof body.enabled !== 'boolean') return fail('enabled must be true or false', 400);
			patch.enabled = body.enabled;
		}
		if ('provider' in body) {
			if (!(SENDER_PROVIDERS as readonly unknown[]).includes(body.provider)) {
				return fail('provider must be gmail or resend', 400);
			}
			patch.provider = body.provider as SenderProvider;
			if (patch.provider === 'resend' && !resendAvailable(locals.env, user.role)) {
				return fail(
					'Resend is not set up on this instance (RESEND_API_KEY and NOTIFY_FROM), or is reserved for admins',
					400
				);
			}
		}
		if ('senderEmail' in body) {
			if (body.senderEmail === null || body.senderEmail === '') {
				patch.senderEmail = null;
			} else {
				const email = normalizeAddress(body.senderEmail);
				if (!email) return fail('Enter a valid sender address', 400);
				patch.senderEmail = email;
			}
		}
		if ('appPassword' in body) {
			const password = normalizeAppPassword(body.appPassword);
			if (!password) return fail('Paste the 16-letter app password Google showed you', 400);
			patch.appPassword = password;
		}
		if ('smtpPort' in body) {
			const port = parseSmtpPort(body.smtpPort);
			if (!port) return fail('smtpPort must be 465 or 587', 400);
			patch.smtpPort = port;
		}
		if ('digestTime' in body) {
			const minute = parseDigestTime(body.digestTime);
			if (minute === null) return fail('digestTime must be HH:MM', 400);
			patch.digestMinute = minute;
		}
		const row = await saveSettings(locals.db, locals.env, user.id, patch);
		await ensureAlertCursors(locals.db, user.id);
		return ok({ settings: publicSettings(row, locals.env, user.role) });
	} catch (err) {
		return handleError(err);
	}
};

/** Forget the Gmail address and app password; recipients and the schedule stay. */
export const DELETE: RequestHandler = async ({ locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		await forgetSender(locals.db, user.id);
		return ok({
			settings: publicSettings(await readSettings(locals.db, user.id), locals.env, user.role)
		});
	} catch (err) {
		return handleError(err);
	}
};
