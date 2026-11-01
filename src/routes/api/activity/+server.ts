import type { RequestHandler } from './$types';
import { listActivity, type ActorType } from '#lib/server/activity.js';
import { handleError, ok } from '#lib/server/http.js';
import { requireScope, requireUser } from '#lib/server/require.js';

const ACTOR_TYPES = new Set<ActorType>(['session', 'api_key', 'api_token', 'system']);

export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const actor = url.searchParams.get('actor');
		return ok(
			await listActivity(locals.db, user.id, {
				actorType: actor && ACTOR_TYPES.has(actor as ActorType) ? (actor as ActorType) : null,
				action: url.searchParams.get('action'),
				targetId: url.searchParams.get('target'),
				cursor: url.searchParams.get('cursor'),
				limit: Number(url.searchParams.get('limit')) || undefined
			})
		);
	} catch (err) {
		return handleError(err);
	}
};
