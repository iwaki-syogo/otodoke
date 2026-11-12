import { runReadWaitingMail, type ReadWaitingResult } from "@/lib/mail-run";
import type { AdminClient } from "@/lib/supabase/admin";
import * as mailTiming from "@/lib/unread";
import { beginMailGeneration } from "@/lib/sample-generation-db";

interface BoundedMailTiming {
  TRIAGE_TIMEOUT_MS: number;
  EXTRACT_TIMEOUT_MS: number;
  MAIL_READ_BUDGET_MS: number;
  MAIL_REQUEST_BUDGET_MS: number;
}

/** Older code has neither bounded Claude clients nor these exports: it cannot start auto reads. */
function boundedTiming(): BoundedMailTiming | null {
  const timing = mailTiming as unknown as Partial<BoundedMailTiming>;
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  if (!positive(timing.TRIAGE_TIMEOUT_MS) || !positive(timing.EXTRACT_TIMEOUT_MS)
    || !positive(timing.MAIL_READ_BUDGET_MS) || !positive(timing.MAIL_REQUEST_BUDGET_MS)) return null;
  // The shared mail budget includes both bounded paid calls and positive room for DB work.
  // Leave the allocation to its owner; no copied timeout or fallback to an unbounded client.
  if (timing.MAIL_READ_BUDGET_MS <= timing.TRIAGE_TIMEOUT_MS + timing.EXTRACT_TIMEOUT_MS
    || timing.MAIL_REQUEST_BUDGET_MS >= 300_000
    || timing.MAIL_REQUEST_BUDGET_MS < timing.MAIL_READ_BUDGET_MS) return null;
  return timing as BoundedMailTiming;
}

const empty = (): ReadWaitingResult => ({ ok: true, read: 0, overLimit: false, unavailable: false });
const failed = (message: string, read = 0): ReadWaitingResult => ({ ok: false, stage: "read", message, read, overLimit: false, unavailable: false, onlyBusy: false });

/**
 * Start the pre-consent backlog once per server-issued choice timestamp, on Web and iOS alike.
 * A claim is never released after failure: the normal manual reader is the explicit retry path.
 * Each batch uses the real pipeline's current-consent check and daily allowance for every mail.
 */
export async function runReadAfterConsent(db: AdminClient, userId: string, decidedAt: string, requestStartedAt: number = Date.now()): Promise<ReadWaitingResult> {
  const timing = boundedTiming();
  if (!timing) return failed("ai_consent_backlog_timing_unavailable");
  // Authentication and the consent write are part of this same request's runtime too.
  const deadlineAt = requestStartedAt + timing.MAIL_REQUEST_BUDGET_MS;
  if (Date.now() + timing.MAIL_READ_BUDGET_MS > deadlineAt) return failed("ai_consent_backlog_time_limit");
  try {
    const { data, error } = await db.rpc("claim_ai_reading_backlog", { p_user_id: userId, p_decided_at: decidedAt });
    if (error || (data !== true && data !== false)) return failed("ai_consent_backlog_claim_failed");
    if (!data) return empty();
  } catch {
    return failed("ai_consent_backlog_claim_failed");
  }

  try {
    db = await beginMailGeneration(db, userId);
  } catch {
    return failed("ai_consent_backlog_read_failed");
  }

  let read = 0;
  for (;;) {
    if (Date.now() >= deadlineAt) return failed("ai_consent_backlog_time_limit", read);
    let batch: ReadWaitingResult;
    try {
      batch = await runReadWaitingMail(db, userId, { consentDecidedAt: decidedAt, deadlineAt, minimumMailBudgetMs: timing.MAIL_READ_BUDGET_MS });
    } catch {
      return failed("ai_consent_backlog_read_failed", read);
    }
    read += batch.read;
    if (!batch.ok || batch.overLimit || batch.unavailable || batch.read === 0) return { ...batch, read };
    // No fixed number of batches: the snapshot is drained, or an explicit limit/failure stops it.
  }
}
