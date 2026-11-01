import type { RequestHandler } from './$types';
import { normalizeAddress } from '#lib/domain/notifications.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { requireSession } from '#lib/server/require.js';
import { sendTestEmail, TEST_EMAIL_COOLDOWN_MS } from '#lib/server/notify/run.js';
import { listRecipients, readSettings } from '#lib/server/notify/store.js';
import { SendError } from '#lib/server/notify/transport.js';

/**
 * Send one test email now. It goes to an address the account already trusts
 * (its sender, a recipient on the list, or its login), never to an arbitrary
 * one: a session-only route is still not meant to be a way to mail strangers.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	try {
		const user = requireSession(locals.user, locals.authMethod);
		const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null;
		const [row, recipients] = await Promise.all([
			readSettings(locals.db, user.id),
			listRecipients(locals.db, user.id)
		]);
		const now = new Date();
		if (row?.lastTestAt && now.getTime() - row.lastTestAt.getTime() < TEST_EMAIL_COOLDOWN_MS) {
			return fail('Wait a few seconds before sending another test email', 429);
		}
		if ((row?.provider ?? 'gmail') === 'gmail' && !(row?.senderEmail && row.senderSecretEnc)) {
			return fail('Add the Gmail address and its app password first.', 400, { kind: 'config' });
		}
		const allowed = new Set(
			[row?.senderEmail, user.email, ...recipients.map((r) => r.email)]
				.map((e) => normalizeAddress(e))
				.filter((e): e is string => Boolean(e))
		);
		let to: string[];
		if (body && 'to' in body && body.to !== undefined && body.to !== null && body.to !== '') {
			const one = normalizeAddress(body.to);
			if (!one || !allowed.has(one)) {
				return fail('Send the test to the sender, your login or an address on the list', 400);
			}
			to = [one];
		} else {
			to = recipients.length ? recipients.map((r) => r.email) : [...allowed].slice(0, 1);
		}
		if (!to.length) return fail('Add a recipient first', 400);
		try {
			await sendTestEmail(locals.db, locals.env, { userId: user.id, role: user.role }, to, { now });
		} catch (err) {
			if (err instanceof SendError) {
				const status = err.kind === 'config' ? 400 : 502;
				return fail(err.message, status, { kind: err.kind });
			}
			throw err;
		}
		return ok({ sentTo: to });
	} catch (err) {
		return handleError(err);
	}
};
