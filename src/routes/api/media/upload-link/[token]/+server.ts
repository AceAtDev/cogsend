import { and, eq, isNull } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { first } from '#lib/server/db/client.js';
import { apiKeys } from '#lib/server/db/schema.js';
import { actorOf, recordActivity } from '#lib/server/activity.js';
import { attachFromUploadLink, uploadLinkMaxBytes } from '#lib/server/api/media-operations.js';
import { fail, handleError, ok } from '#lib/server/http.js';
import { verifyUploadLink } from '#lib/server/media-uploads.js';

/**
 * One file into the draft and place an upload link names (media_upload action
 * "links"). Possession of a fresh signed link is the authorization, as with
 * the public media URLs: it reaches one slot on one draft for an hour, and an
 * agent's link stops working once its API key is revoked.
 */
export const PUT: RequestHandler = async ({ params, request, locals }) => {
	try {
		const checked = await verifyUploadLink(locals.env.APP_ENCRYPTION_KEY, params.token);
		if (!checked.ok) return fail(checked.error, 403);
		const { claim } = checked;
		const declared = Number(request.headers.get('content-length') ?? '');
		if (!Number.isInteger(declared) || declared <= 0) {
			return fail(
				'Send the file as the request body with its Content-Length (curl -T file url)',
				411
			);
		}
		const max = uploadLinkMaxBytes();
		if (declared > max)
			return fail(`File too large for an upload link (max ${max / 1_000_000}MB)`, 413);
		let apiKey: { id: string; prefix: string } | null = null;
		if (claim.credential === 'personal_api_key') {
			const key = claim.apiKeyId
				? await first(
						locals.db
							.select({ id: apiKeys.id, prefix: apiKeys.prefix })
							.from(apiKeys)
							.where(
								and(
									eq(apiKeys.id, claim.apiKeyId),
									eq(apiKeys.userId, claim.userId),
									isNull(apiKeys.revokedAt)
								)
							)
					)
				: null;
			if (!key) return fail('The API key that made this link was revoked', 403);
			apiKey = key;
		}
		const bytes = new Uint8Array(await request.arrayBuffer());
		if (bytes.length !== declared) return fail('The upload did not arrive whole', 400);
		const ctx = {
			db: locals.db,
			env: locals.env,
			media: locals.media,
			bindings: locals.bindings,
			budget: locals.budget,
			authCredential: claim.credential,
			apiKey
		};
		const result = await attachFromUploadLink(ctx, claim, bytes);
		await recordActivity(locals.db, claim.userId, actorOf(ctx), {
			action: 'media.upload_link',
			targetType: 'post',
			targetId: claim.draftId,
			summary: `Uploaded ${result.media.mime} to place ${claim.sortOrder + 1} of draft ${claim.draftId}`
		});
		return ok(
			{
				postId: claim.draftId,
				mediaId: result.media.id,
				mime: result.media.mime,
				size: result.media.size,
				segmentIndex: claim.segmentIndex,
				position: claim.sortOrder + 1
			},
			201
		);
	} catch (err) {
		return handleError(err);
	}
};
