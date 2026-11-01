import type { PageServerLoad } from './$types';
import { loadDraftSummaries, loadQueueList } from '#lib/server/post-list.js';
import { requireUser } from '#lib/server/require.js';
import { latestMetricsFor, type DeliveryMetricsView } from '#lib/server/metrics.js';

export const load: PageServerLoad = async ({ locals }) => {
	const user = requireUser(locals.user);
	try {
		const [drafts, queue] = await Promise.all([
			loadDraftSummaries(locals.db, user.id),
			loadQueueList(locals.db, user.id)
		]);
		const published = queue.targets
			.filter((t: { status: string }) => t.status === 'published')
			.map((t: { id: string }) => t.id);
		// Metrics are a garnish: the list still loads when they cannot be read.
		const metrics: Record<string, DeliveryMetricsView> = {};
		try {
			for (const [id, view] of await latestMetricsFor(locals.db, user.id, published))
				metrics[id] = view;
		} catch (err) {
			console.error('[posts] metrics failed', err);
		}
		return {
			metrics,
			drafts: drafts.drafts,
			draftsHasMore: drafts.hasMore,
			targets: queue.targets,
			queueHasMore: queue.hasMore,
			loadFailed: false
		};
	} catch (err) {
		console.error('[posts] list failed', err);
		return {
			metrics: {} as Record<string, DeliveryMetricsView>,
			drafts: [],
			draftsHasMore: false,
			targets: [],
			queueHasMore: false,
			loadFailed: true
		};
	}
};
