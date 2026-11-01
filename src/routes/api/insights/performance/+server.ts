import type { RequestHandler } from './$types';
import { handleError, ok } from '#lib/server/http.js';
import { parseInsightRange } from '#lib/domain/insights.js';
import { performanceReport } from '#lib/server/metrics-report.js';
import { requireScope, requireUser } from '#lib/server/require.js';

/** Totals per brand and channel and the top posts over the last 7, 30 or 90 days. */
export const GET: RequestHandler = async ({ locals, url }) => {
	try {
		const user = requireUser(locals.user);
		requireScope(locals, 'read');
		const days = parseInsightRange(url.searchParams.get('days'));
		const to = new Date();
		const from = new Date(to.getTime() - days * 86_400_000);
		return ok({ days, ...(await performanceReport(locals.db, user.id, { from, to, limit: 10 })) });
	} catch (err) {
		return handleError(err);
	}
};
