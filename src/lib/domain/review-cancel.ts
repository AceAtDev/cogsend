import { MAX_TARGET_CONNECTION_IDS } from './request-limits';

type CancelResult = { id: string; ok: boolean; error?: string };

/** Bulk API limits apply per request, never to the number of deliveries in a review card. */
export async function cancelReviewDeliveries(
	ids: string[],
	send: (ids: string[]) => Promise<{ results?: CancelResult[] }>
) {
	let cancelled = 0;
	const failures: string[] = [];
	const unique = [...new Set(ids)];
	for (let i = 0; i < unique.length; i += MAX_TARGET_CONNECTION_IDS) {
		const chunk = unique.slice(i, i + MAX_TARGET_CONNECTION_IDS);
		try {
			const out = await send(chunk);
			for (const id of chunk) {
				const result = out.results?.find((r) => r.id === id);
				if (result?.ok === true) cancelled++;
				else failures.push(result?.error || 'Cancellation was not confirmed');
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : 'Could not cancel';
			failures.push(...chunk.map(() => message));
		}
	}
	return { cancelled, failures };
}
