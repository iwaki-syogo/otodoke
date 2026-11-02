/** How long a mail may stay "pending" before it counts as stuck. Longer than the webhook's own time limit. */
export const PENDING_GRACE_MS = 3 * 60 * 1000;

/** PostgREST filter for stored mail nobody has read yet: over the limit, failed, or stuck midway. */
export function UNREAD_FILTER(now: Date = new Date()): string {
  const stuckBefore = new Date(now.getTime() - PENDING_GRACE_MS).toISOString();
  return `processing_status.in.(over_limit,failed),and(processing_status.eq.pending,created_at.lt.${stuckBefore})`;
}
