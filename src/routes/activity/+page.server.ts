import type { PageServerLoad } from './$types';
import { safeTimeZone } from '#lib/domain/calendar.js';
import { listActivity, type ActorType } from '#lib/server/activity.js';
import { requireUser } from '#lib/server/require.js';

const ACTORS = new Set<ActorType>(['session', 'api_key', 'api_token', 'system']);
/** The families the page offers as filters; the API takes any action. */
const ACTION_FILTERS = ['review', 'post', 'delivery', 'brand', 'mcp'] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const actorParam = url.searchParams.get('actor');
	const actionParam = url.searchParams.get('action');
	const actor =
		actorParam && ACTORS.has(actorParam as ActorType) ? (actorParam as ActorType) : null;
	const action =
		actionParam && (ACTION_FILTERS as readonly string[]).includes(actionParam) ? actionParam : null;
	const filter = { actor, action, cursor: url.searchParams.get('cursor') };
	try {
		const page = await listActivity(locals.db, user.id, {
			actorType: actor,
			action,
			cursor: filter.cursor
		});
		return { timeZone: safeTimeZone(user.timezone), filter, ...page, loadFailed: false };
	} catch (err) {
		console.error('[activity] load failed', err);
		return {
			timeZone: safeTimeZone(user.timezone),
			filter,
			entries: [],
			next: null,
			loadFailed: true
		};
	}
};
