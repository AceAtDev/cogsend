import type { AppDb } from './db/client';
import type { AppEnv } from './env';

/**
 * What review raises for someone to hear about, and who is listening.
 *
 * `review_waiting` fires when an agent's write is held for review (from the
 * request that held it), `review_overdue` once per delivery when the tick
 * first finds a held delivery's time has passed. Both carry one user's items;
 * a sweep that finds several users' items raises one alert per user.
 *
 * Notification senders subscribe with `onReviewAlert`, at module load of a
 * module the Worker always imports (the scheduler or hooks), and do their own
 * batching: an alert is raised every time, never debounced here. A listener
 * that throws is logged and does not stop the others or the write.
 */

export type ReviewAlertItem = {
	deliveryId: string;
	postId: string;
	connectionId: string;
	platform: string;
	handle: string | null;
	brandId: string | null;
	/** "Unbranded" for an account in no brand. */
	brandName: string;
	/** When it was meant to go out; null for a held "publish now". */
	scheduledFor: Date | null;
	excerpt: string;
};

export type ReviewAlert = {
	kind: 'review_waiting' | 'review_overdue';
	userId: string;
	items: ReviewAlertItem[];
	at: Date;
};

export type ReviewAlertContext = { db: AppDb; env: AppEnv };

export type ReviewAlertListener = (
	alert: ReviewAlert,
	ctx: ReviewAlertContext
) => void | Promise<void>;

const listeners = new Set<ReviewAlertListener>();

/** Returns a function that removes the listener again. */
export function onReviewAlert(listener: ReviewAlertListener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function hasReviewAlertListeners(): boolean {
	return listeners.size > 0;
}

export async function emitReviewAlerts(alerts: ReviewAlert[], ctx: ReviewAlertContext) {
	for (const alert of alerts) {
		if (!alert.items.length) continue;
		for (const listener of [...listeners]) {
			try {
				await listener(alert, ctx);
			} catch (err) {
				console.error('[review] alert listener failed', alert.kind, err);
			}
		}
	}
}
