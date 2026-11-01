/**
 * Review before publishing. A delivery an agent creates on a brand that
 * requires approval waits as `awaiting_review`; the operator approves it
 * (it becomes `scheduled`) or rejects it with a note (`rejected`), which the
 * agent reads and answers by revising and resubmitting. Neither state is ever
 * claimed by the scheduler, so nothing in them can go out.
 *
 *   agent write ──► awaiting_review ──approve──► scheduled ──tick──► published
 *                      │   ▲   │
 *               reject │   │   └─ time passes: still held, flagged overdue once
 *                      ▼   │ resubmit / agent reschedule or edit
 *                    rejected
 *
 * A session write (the operator in the app) never lands in either state, and
 * an agent's edit of a post already approved on a reviewed brand sends its
 * waiting deliveries back to `awaiting_review`.
 */

export const AWAITING_REVIEW = 'awaiting_review';
export const REJECTED = 'rejected';

/** Statuses the scheduler never claims and the publish claim never matches. */
export const HELD_STATUSES = [AWAITING_REVIEW, REJECTED] as const;

export const MAX_REVIEW_NOTE = 2000;

export function isHeldForReview(status: string | null | undefined): boolean {
	return status === AWAITING_REVIEW;
}

export type ReviewTiming = 'waiting' | 'overdue';

/**
 * A held delivery whose time has passed is overdue: it stays held, and on
 * approval it goes out on the next tick. A held "publish now" has no future
 * time to wait for, so it is overdue from the start.
 */
export function reviewTiming(
	scheduledFor: Date | number | null | undefined,
	now: Date = new Date()
): ReviewTiming {
	if (scheduledFor === null || scheduledFor === undefined) return 'overdue';
	const at = scheduledFor instanceof Date ? scheduledFor.getTime() : scheduledFor;
	return at <= now.getTime() ? 'overdue' : 'waiting';
}

/** A note as stored: trimmed, at most MAX_REVIEW_NOTE characters, or null. */
export function parseReviewNote(raw: unknown): { ok: true; note: string | null } | { ok: false } {
	if (raw === undefined || raw === null) return { ok: true, note: null };
	if (typeof raw !== 'string') return { ok: false };
	const note = raw.trim();
	if (note.length > MAX_REVIEW_NOTE) return { ok: false };
	return { ok: true, note: note || null };
}

/** The line agents read in every write that held something. */
export function heldForReviewLine(count: number): string {
	return `HELD FOR REVIEW: ${count} deliver${count === 1 ? 'y waits' : 'ies wait'} for the operator, who approves in the Review inbox. Nothing is published until then; do not resend or publish_now it.`;
}
