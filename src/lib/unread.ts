/** Legacy display/rows shared with older iOS clients. New executions always have an explicit lease. */
export const PENDING_GRACE_MS = 3 * 60 * 1000;
/** A read request runs for at most 300 seconds, plus a minute for termination. */
export const MAIL_LEASE_MS = 6 * 60 * 1000;
export const TRIAGE_TIMEOUT_MS = 15_000;
export const EXTRACT_TIMEOUT_MS = 90_000;
/** A complete mail needs room for both paid calls and its database writes. */
export const MAIL_READ_BUDGET_MS = 120_000;
export const MAIL_REQUEST_BUDGET_MS = 270_000;

/** PostgREST filter for stored mail nobody has read yet: over the limit, failed, or stuck midway. */
export function UNREAD_FILTER(now: Date = new Date()): string {
  // Kept for older iOS fixture consumers; live server readers use WAITING_MAIL_FILTER.
  const stuckBefore = new Date(now.getTime() - PENDING_GRACE_MS).toISOString();
  return `processing_status.in.(over_limit,failed),and(processing_status.eq.pending,created_at.lt.${stuckBefore})`;
}

/** Server-side recovery uses the explicit lease, with the legacy fallback only for rows created before leases existed. */
export function WAITING_MAIL_FILTER(now: Date = new Date()): string {
  const at = now.toISOString();
  const legacyBefore = new Date(now.getTime() - PENDING_GRACE_MS).toISOString();
  return `processing_status.in.(over_limit,failed),and(processing_status.eq.pending,processing_lease_until.lte.${at}),and(processing_status.eq.pending,processing_lease_until.is.null,created_at.lt.${legacyBefore})`;
}
