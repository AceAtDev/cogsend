import type { PageServerLoad } from './$types';
import { parseInsightRange } from '#lib/domain/insights.js';
import { loadInsights } from '#lib/server/insights-report.js';
import { performanceReport } from '#lib/server/metrics-report.js';
import { requireUser } from '#lib/server/require.js';

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = requireUser(locals.user);
	const days = url.searchParams.get('days');
	const [insights, performance] = await Promise.all([
		loadInsights(locals.db, user.id, days, user.timezone).catch((err) => {
			console.error('[insights] load failed', err);
			return null;
		}),
		(async () => {
			const span = parseInsightRange(days);
			const to = new Date();
			return performanceReport(locals.db, user.id, {
				from: new Date(to.getTime() - span * 86_400_000),
				to,
				limit: 10
			});
		})().catch((err) => {
			console.error('[insights] performance failed', err);
			return null;
		})
	]);
	return { insights, performance };
};
