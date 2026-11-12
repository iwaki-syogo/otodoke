import type { AdminClient } from "@/lib/supabase/admin";
import { readAll } from "@/lib/supabase/read-all";
import { extractEmail, type ExtractionResult } from "@/lib/extract/extract";
import { isPurchaseMail } from "@/lib/extract/triage";
import { ClaudeUnavailableError, claudeFailure } from "@/lib/extract/claude-error";
import { claimClaudeCall, type ClaudeClaim } from "@/lib/claude-usage";
import { AiReadingNotAllowedError, requireAiReadingConsent } from "@/lib/ai-consent";
import {
  isParcelRelevant,
  buildParcelInsert,
  buildParcelUpdate,
  chooseParcel,
  mergeIntoManual,
  parcelTotal,
  rebuildParcel,
  dismissedAfterMerge,
  receivedAfterMerge,
  splitOrders,
  startsParcel,
  twinsByTracking,
  type ParcelCandidate,
  type ParcelRow,
  type ParcelUpdate,
} from "@/lib/match";
import { categoryForTwins, type TwinCategory } from "@/lib/match/category";
import { forwardingConfirmUrl, isForwardingConfirmation as isGmailConfirmation } from "@/lib/forwarding";
import { closedBody, currentSealKey, domainOf } from "@/lib/mail-seal";
import type { MailPlaintext } from "@/lib/crypto/envelope";
import { PENDING_GRACE_MS } from "@/lib/unread";
import { withMailRun } from "@/lib/mail-run-db";
import { mailStorageLimits } from "@/lib/mail-storage";
import { screenMail, type ScreenResult } from "@/lib/screen";
import { isRememberableDomain } from "@/lib/screen-senders";
import { emailBodyText } from "@/lib/text/html-to-text";
import { withDefaults, type Extraction } from "@/lib/extract/schema";
import { hasUnverifiedUnrelatedVerdict, UNVERIFIED_UNRELATED_ERROR, verifyEvidence } from "@/lib/extract/verify-evidence";
import { beginMailGeneration } from "@/lib/sample-generation-db";
import type { Json } from "@/lib/db/database.types";

export interface InboundEmail {
  userId: string;
  providerEmailId: string | null;
  messageId: string | null;
  from: string;
  fromName: string | null;
  subject: string;
  /** ISO 8601 when the original mail was sent */
  sentAt: string | null;
  text: string | null;
  html: string | null;
  /** ISO 8601 when the delivery was created at the provider; read by the database for clear marks only. */
  deliveryCreatedAt?: string | null;
}

export type PipelineOutcome =
  | { kind: "duplicate"; emailId: string }
  | { kind: "storage_limit"; limit: string }
  | { kind: "forwarding_confirmation"; emailId: string }
  | { kind: "screened_out"; reason: string }
  | { kind: "over_limit"; emailId: string; limit: string }
  | { kind: "discarded"; reason: string }
  | { kind: "noted"; emailId: string }
  | { kind: "processed"; emailId: string; parcelId: string; created: boolean; extraction: Extraction };

export interface PipelineOptions {
  /** A Claude result computed earlier (the demo loader). Skips the API call. */
  precomputed?: ExtractionResult;
  /**
   * An anonymized sample mail from the repository (the demo loader). While the user has no key it
   * stays readable after it is read; a real mail is dropped instead. With a key it is sealed too.
   */
  publicSample?: boolean;
  /**
   * An explicit re-read targets exactly this stored row, including mails with a Message-ID.
   * A missing row was cleared; its cached body must never become a new incoming delivery.
   */
  replacesEmailId?: string;
  /** The version captured by the unread list, never refreshed from a later lookup. */
  replacesCreatedAt?: string;
}

/** The stored row of a mail, as far as deciding what to do with it goes. */
interface StoredRow {
  id: string;
  processing_status: string;
  created_at: string;
  processing_run_id: string | null;
  processing_lease_until: string | null;
  provider_email_id: string | null;
}

/** The row this mail already has: by its Message-ID, or the row being read again. Throws when it cannot tell. */
async function storedRow(db: AdminClient, mail: InboundEmail, rowId: string | null): Promise<StoredRow | null> {
  if (!mail.messageId && !rowId && !mail.providerEmailId) return null;
  const query = db.from("emails").select("id, processing_status, created_at, processing_run_id, processing_lease_until, provider_email_id").eq("user_id", mail.userId);
  const { data, error } = await (rowId ? query.eq("id", rowId) : mail.messageId ? query.eq("message_id", mail.messageId) : query.eq("provider_email_id", mail.providerEmailId!)).maybeSingle();
  if (error) throw new Error(`emails lookup failed: ${error.message}`);
  return data;
}

/**
 * Thrown only when another run of the same mail is storing or reading it right now (its row is
 * pending and young, the insert lost the unique-key race, or the take-over update lost to another
 * run). The sample load matches on this class and stops, leaving the rest to the run that is ahead;
 * every other failure stays a plain Error.
 */
export class MailBeingReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailBeingReadError";
  }
}

/**
 * Store one forwarded email, let Claude read it, and fold it into the user's parcels.
 *
 * Safe to call again for the same mail: a mail that finished is a no-op, and a mail
 * that failed or was cut off midway is processed again. Throws on failure so the
 * webhook answers 500 and Resend retries; the failed row stays visible until then.
 */
export async function processInboundEmail(db: AdminClient, mail: InboundEmail, options: PipelineOptions = {}): Promise<PipelineOutcome> {
  // A batch already carries its original generation. Never refresh it per mail after a clear.
  // Samples are explicitly scoped by their loader or by the stored sample row's generation.
  if (!options.publicSample) db = await beginMailGeneration(db, mail.userId);
  const isForwardingConfirmation = isGmailConfirmation(mail.from);

  // The row this mail already has, looked up before the screen: a mail that was read is never
  // screened, paid for or removed again when it is delivered a second time.
  const stored = await storedRow(db, mail, options.replacesEmailId ?? null);
  // A backlog snapshot is a retry of its existing row, never a new delivery after a sweep/clear.
  if (options.replacesEmailId && (!stored || stored.id !== options.replacesEmailId)) throw new MailBeingReadError("the stored mail is no longer available");
  if (stored?.processing_status === "processed") return { kind: "duplicate", emailId: stored.id };
  // Another delivery of this mail is being read right now. Taking its row over would break that
  // run and pay for a second read, so fail and let the webhook retry later.
  if (stored?.processing_status === "pending" && (stored.processing_lease_until ? Date.parse(stored.processing_lease_until) > Date.now() : Date.now() - new Date(stored.created_at).getTime() < PENDING_GRACE_MS)) {
    throw new MailBeingReadError("this mail is still being read");
  }

  // A clearly unrelated mail needs neither storage nor a key. Borderline and remembered senders
  // still acquire the owned lease before paid triage. A different delivery of a stored mail (not an
  // explicit re-read, not the same delivery again) is screened the same way before anything is
  // reserved, or taking the row over would overwrite its original and delete its readings before
  // the later screen removes the row.
  const otherDelivery = !!stored && !options.replacesEmailId && (stored.provider_email_id ?? null) !== (mail.providerEmailId ?? null);
  if ((!stored || otherDelivery) && !isForwardingConfirmation && !options.precomputed) {
    const screen = screenMail(mail);
    if (!screen.pass && !screen.borderline && !(await senderMarked(db, mail))) {
      await logScreenEvent(db, mail, "dropped", screen.reason);
      return { kind: "screened_out", reason: screen.reason };
    }
  }

  // Known before anything is stored or paid for: not knowing whether there is a key fails here,
  // with the stored row (a mail read again from 設定, say) as it was. The Gmail confirmation is
  // closed with it as it is stored; a mail that is read is closed with the key read again right
  // before that write (markRead), so a key put in use meanwhile counts.
  const key = await currentSealKey(db, mail.userId);

  // 1. Store the raw mail. A stored row is taken over in place, under its own id: it is never
  // removed and stored anew, so a failed write leaves it as it was and the only copy is not lost.
  const emailId = stored?.id ?? crypto.randomUUID();
  const columns = {
    provider_email_id: mail.providerEmailId,
    message_id: mail.messageId,
    from_address: mail.from,
    from_name: mail.fromName,
    subject: mail.subject,
    sent_at: mail.sentAt,
    text_body: mail.text,
    html_body: mail.html,
    from_domain: domainOf(mail.from),
    classification: isForwardingConfirmation ? "forwarding_confirmation" : null,
    processing_status: isForwardingConfirmation ? "processed" : "pending",
    error: null,
    forwarding_confirm_url: null,
    // Gmail's confirmation is done as it arrives: only its approval link stays in plaintext.
    ...(isForwardingConfirmation
      ? {
          forwarding_confirm_url: forwardingConfirmUrl(mail.text ?? "") ?? forwardingConfirmUrl(mail.html ?? ""),
          ...(await closedBody(key, mail.userId, emailId, plaintextOf(mail), false)),
        }
      : {}),
  };
  const runId = crypto.randomUUID();
  const limits = mailStorageLimits();
  const reserveCall = db.rpc("store_mail_run", {
    p_user_id: mail.userId, p_email_id: emailId, p_run_id: runId,
    p_columns: columns as unknown as Json, p_expected_created_at: options.replacesCreatedAt ?? stored?.created_at ?? null,
    p_limits: {
      user_count: limits.OTODOKE_UNREAD_USER_MAIL_LIMIT, global_count: limits.OTODOKE_UNREAD_GLOBAL_MAIL_LIMIT,
      user_bytes: limits.OTODOKE_UNREAD_USER_BYTE_LIMIT, global_bytes: limits.OTODOKE_UNREAD_GLOBAL_BYTE_LIMIT,
    },
  });
  // Only this call carries the delivery time; an older database ignores the header.
  const { data: reservation, error: reservationError } = await (mail.deliveryCreatedAt
    ? reserveCall.setHeader("x-otodoke-delivery-created-at", mail.deliveryCreatedAt)
    : reserveCall);

  if (reservationError) throw new Error(`mail reservation failed: ${reservationError.message}`);
  const reserved = Array.isArray(reservation) ? reservation[0] : null;
  if (!reserved) throw new Error("mail reservation returned no verdict");
  if (reserved.verdict === "busy") throw new MailBeingReadError("this mail is still being read");
  if (reserved.verdict === "duplicate") return { kind: "duplicate", emailId: reserved.email_id };
  if (reserved.verdict === "consent_wait_expired") return { kind: "discarded", reason: "ai_consent_wait_expired" };
  if (reserved.verdict === "user_storage_limit" || reserved.verdict === "global_storage_limit") return { kind: "storage_limit", limit: reserved.verdict };
  if (reserved.verdict !== "ok" || reserved.email_id !== emailId) throw new Error("mail reservation returned an unexpected verdict");
  const emailRow = { id: emailId };
  // Every subsequent mutation, including parcel and extraction writes, is fenced
  // by the same database row lock as takeover. A late old run cannot finish.
  db = withMailRun(db, emailId, runId);
  if (stored) {
    const { error: leftoverError } = await db.from("extractions").delete().eq("email_id", stored.id).eq("user_id", mail.userId);
    if (leftoverError) throw new Error(`extractions cleanup failed: ${leftoverError.message}`);
  }

  if (isForwardingConfirmation) return { kind: "forwarding_confirmation", emailId: emailRow.id };

  await requireAiReadingConsent(db, mail.userId, emailRow.id, options);

  // 0. Screen under the owned lease. A rejected mail is removed immediately.
  if (!isForwardingConfirmation && !options.precomputed) {
    const screen = screenMail(mail);
    if (!screen.pass) {
      let keep: boolean;
      try {
        keep = await secondLook(db, mail, screen);
      } catch (err) {
        if (err instanceof AiReadingNotAllowedError) {
          const { error } = await db.from("emails").update({ processing_status: "failed", error: err.code }).eq("id", emailId).eq("user_id", mail.userId);
          if (error) throw new Error("could not retain mail awaiting reading permission");
        }
        throw err;
      }
      if (keep) {
        await logScreenEvent(db, mail, "rescued", screen.reason);
      } else {
        // Re-reading a stored mail can land here too. Leave no row behind, or it would stay unread
        // forever. Only while the row is as it was read, as for the take-over below: a delivery that
        // took it over meanwhile is reading it, and its row is not removed from under it.
        await removeOwnedMail(db, mail.userId, emailId);
        // Logged as dropped (its subject in plaintext, for 14 days) only once its row is gone: a
        // delivery that took the row over may read and seal it (review R3-33). Removed first and
        // logged after, so a failure in between leaves no subject behind.
        await logScreenEvent(db, mail, "dropped", screen.reason);
        return { kind: "screened_out", reason: screen.reason };
      }
    }
  }


  // 1.5. Take one paid call from today's allowance. Over the limit, the mail is kept to read later.
  let claim: ClaudeClaim | null = null;
  if (!options.precomputed) {
    try {
      claim = await claimClaudeCall(db, mail.userId);
    } catch (err) {
      const { error } = await db.from("emails").update({ processing_status: "failed", error: err instanceof Error ? err.message : String(err) }).eq("id", emailRow.id);
      if (err instanceof AiReadingNotAllowedError && error) throw new Error("could not retain mail awaiting reading permission");
      throw err;
    }
    if (claim.verdict !== "ok") {
      const { error } = await db.from("emails").update({ processing_status: "over_limit", error: claim.verdict }).eq("id", emailRow.id);
      if (error) throw new Error(`emails update failed: ${error.message}`);
      return { kind: "over_limit", emailId: emailRow.id, limit: claim.verdict };
    }
  }

  try {
    return await understandAndFile(db, mail, emailRow.id, options);
  } catch (err) {
    const failure = claudeFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    // A failed Claude call leaves only a fixed code in the row; the raw message stays in the server log.
    if (failure) console.error("pipeline: claude call failed:", failure.code, message);
    // Claude refused the call (it answered with an error status): nothing was billed, so the allowance comes back.
    if (failure?.unbilled) await claim?.release();
    await db.from("emails").update({ processing_status: "failed", error: failure ? failure.code : message }).eq("id", emailRow.id);
    if (failure?.code === "claude_unavailable") throw new ClaudeUnavailableError("claude is unavailable");
    throw err;
  }
}

/** Zero returned rows is a failed owned write, not proof that the target was already absent. */
async function removeOwnedMail(db: AdminClient, userId: string, emailId: string): Promise<void> {
  const { data, error } = await db.from("emails").delete().eq("user_id", userId).eq("id", emailId).select("id");
  if (error) throw new Error(`emails cleanup failed: ${error.message}`);
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.id !== emailId) {
    throw new Error("emails cleanup did not remove the expected row");
  }
}

function plaintextOf(mail: InboundEmail): MailPlaintext {
  return { subject: mail.subject, from_name: mail.fromName, from_address: mail.from, text: mail.text, html: mail.html };
}

/**
 * A mail the free rules would drop still goes on when a cheap Claude check (Haiku) says it is a
 * purchase notice. The check runs for a mail the rules were unsure about, and for every mail from
 * a sender the user marked 「これは荷物」. A mark never skips the check: anyone can write a From
 * line, and a shop sends its ads from the same domain as its notices.
 */
async function secondLook(db: AdminClient, mail: InboundEmail, screen: ScreenResult): Promise<boolean> {
  if (!screen.borderline && !(await senderMarked(db, mail))) return false;

  // Over the limit or unable to tell: keep it. The next step stores it as unread instead of losing it.
  let claim: ClaudeClaim;
  try {
    claim = await claimClaudeCall(db, mail.userId);
  } catch (err) {
    if (err instanceof AiReadingNotAllowedError) throw err;
    return true;
  }
  if (claim.verdict !== "ok") return true;

  try {
    return await isPurchaseMail(mail);
  } catch (err) {
    // A failed check keeps the mail: losing a parcel is worse, and the reading goes on (the cheap
    // model alone may be gone or refused while the reading's model works; if Claude is really
    // stopped, the reading stops there). A call Claude refused for good gives its allowance back.
    const failure = claudeFailure(err);
    console.error("triage failed, keeping the mail:", failure ? failure.code : err instanceof Error ? err.message : err);
    if (failure?.unbilled) await claim.release();
    return true;
  }
}

/**
 * The user marked mail from this sender's domain 「これは荷物」. A domain many people have their
 * own address on is never taken as marked (src/lib/screen-senders.ts), even by a mark made before
 * that rule. Unable to tell counts as marked: the cheap check then decides, not a database error.
 */
async function senderMarked(db: AdminClient, mail: InboundEmail): Promise<boolean> {
  const domain = domainOf(mail.from);
  if (!isRememberableDomain(domain)) return false;
  const { count, error } = await db
    .from("screen_events")
    .select("id", { count: "exact", head: true })
    .eq("user_id", mail.userId)
    .eq("from_domain", domain)
    .not("flagged_at", "is", null);
  if (error) {
    console.error("screen_events lookup failed:", error.message);
    return true;
  }
  return Boolean(count);
}

/**
 * Bookkeeping must never cost a mail, so a failure here is only logged.
 *
 * The subject is kept only for a dropped mail (disclosed: the settings list shows it so a wrong
 * drop can be noticed). A rescued mail goes on to be read and sealed, so its subject must not
 * stay here in plaintext.
 */
async function logScreenEvent(db: AdminClient, mail: InboundEmail, decision: "dropped" | "rescued", reason: string) {
  const { error } = await db.from("screen_events").insert({
    user_id: mail.userId,
    from_domain: domainOf(mail.from),
    subject: decision === "dropped" ? mail.subject.slice(0, 200) : null,
    decision,
    reason,
  });
  if (error) console.error("screen_events insert failed:", error.message);
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { error: cleanupError } = await db.from("screen_events").delete().eq("user_id", mail.userId).lt("created_at", cutoff).is("flagged_at", null);
  if (cleanupError) console.error("screen_events cleanup failed:", cleanupError.message);
}

/**
 * Mark the mail read and close it (sealed / dropped / a sample kept plain) in one write, with the
 * key in use right now: reading it at the start would miss a key put in use or replaced while
 * Claude was reading. If a key still appears between this read and the write, the database
 * refuses a plain row (23514, supabase/pending/20261106130000); then it is read once more and
 * written again, so a sample loaded at that moment is sealed instead of failing.
 */
async function markRead(db: AdminClient, mail: InboundEmail, emailId: string, classification: string, publicSample: boolean): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const key = await currentSealKey(db, mail.userId);
    const closed = await closedBody(key, mail.userId, emailId, plaintextOf(mail), publicSample);
    const { error } = await db.from("emails").update({ classification, processing_status: "processed", ...closed }).eq("id", emailId);
    if (!error) return;
    if (error.code === "23514" && attempt === 0) continue;
    throw new Error(`emails update failed: ${error.message}`);
  }
}

async function understandAndFile(db: AdminClient, mail: InboundEmail, emailId: string, options: PipelineOptions): Promise<PipelineOutcome> {
  // 2. Understand it.
  const extraction =
    options.precomputed ??
    (await extractEmail({
      from: mail.fromName ? `${mail.fromName} <${mail.from}>` : mail.from,
      subject: mail.subject,
      sentAt: mail.sentAt,
      body: emailBodyText(mail.text, mail.html),
    }));
  const x = verifyEvidence(withDefaults(extraction.data), mail);

  // A refusal says nothing about the mail, so it is kept as unread rather than dropped as unrelated.
  if (extraction.refused) {
    const { error } = await db.from("emails").update({ processing_status: "failed", error: "model refused" }).eq("id", emailId);
    if (error) throw new Error(`emails update failed: ${error.message}`);
    return { kind: "discarded", reason: "model refused" };
  }

  // An ungrounded unrelated verdict is retryable mail, not evidence for an empty parcel.
  if (hasUnverifiedUnrelatedVerdict(x)) {
    const { error } = await db.from("emails").update({ processing_status: "failed", error: UNVERIFIED_UNRELATED_ERROR }).eq("id", emailId);
    if (error) throw new Error(`emails update failed: ${error.message}`);
    return { kind: "noted", emailId };
  }

  // 3. Unrelated mail is not kept at all.
  if (!isParcelRelevant(x.relevance)) {
    await removeOwnedMail(db, mail.userId, emailId);
    return { kind: "discarded", reason: x.relevance_evidence ?? "unrelated" };
  }

  // 4. One reading per order: a mail listing several orders files each into its own parcel.
  const [main, ...others] = splitOrders(x);
  const meta = { model: extraction.model, usage: extraction.usage, truncated: extraction.truncated };
  const filed = await fileReading(db, mail, emailId, main, meta);
  if (!filed) {
    const { error } = await db.from("extractions").insert({
      user_id: mail.userId,
      email_id: emailId,
      parcel_id: null,
      model: extraction.model,
      result: { ...main, _usage: extraction.usage, _truncated: extraction.truncated } as unknown as Json,
      confidence: Math.max(0, Math.min(1, main.overall_confidence)),
    });
    if (error) throw new Error(`extractions insert failed: ${error.message}`);
    // Marked read and closed in one write: a read mail never stays in plaintext.
    await markRead(db, mail, emailId, x.relevance, options.publicSample === true);
    return { kind: "noted", emailId };
  }
  // The usage belongs to the one API call, so only the first reading carries it.
  for (const other of others) await fileReading(db, mail, emailId, other, { ...meta, usage: null });

  // 5. A carrier mail that came before the shop mail opened a parcel of its own: fold it in.
  const parcelId = await absorbTwins(db, mail.userId, filed.parcelId);

  // Marked read and closed in one write: a read mail never stays in plaintext.
  await markRead(db, mail, emailId, x.relevance, options.publicSample === true);

  return { kind: "processed", emailId, parcelId, created: filed.created, extraction: x };
}

interface ReadingMeta {
  model: string;
  usage: ExtractionResult["usage"] | null;
  truncated: boolean;
}

/** File one reading into its parcel, or answer null when it describes no parcel. */
async function fileReading(db: AdminClient, mail: InboundEmail, emailId: string, x: Extraction, meta: ReadingMeta): Promise<{ parcelId: string; created: boolean } | null> {
  let parcelId: string | null = null;
  let created = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    // A conflict reruns the same local match against every current candidate. It
    // never asks Claude again, nor assumes that the old id is still a match.
    const { parcel, snapshot } = await findParcel(db, mail.userId, x);
    if (!parcel && !startsParcel(x)) return null;
    if (parcel) {
      const update = parcel.source === "manual" ? mergeIntoManual(parcel, x, mail.sentAt) : buildParcelUpdate(parcel, x, mail.sentAt);
      const { rest, category } = splitCategory(update);
      const saved = await db.rpc("update_mail_parcel", {
        p_snapshot: snapshot as unknown as Json, p_parcel_id: parcel.id, p_expected_updated_at: parcel.updated_at,
        p_values: rest as unknown as Json, p_category: category as unknown as Json, p_items: itemValues(x) as unknown as Json,
      });
      if (saved.error) throw new Error(`parcels update failed: ${saved.error.message}`);
      const row = Array.isArray(saved.data) ? saved.data[0] : null;
      if (row?.verdict === "retry") continue;
      if (row?.verdict !== "ok" || row.parcel_id !== parcel.id || !row.parcel_row || typeof row.parcel_row !== "object" || Array.isArray(row.parcel_row)) throw new Error("parcels update returned no saved row");
      assertParcelWrite(rest, row.parcel_row as unknown as ParcelRow);
      parcelId = parcel.id;
      break;
    }
    const inserted = await db.rpc("create_mail_parcel", {
      p_snapshot: snapshot as unknown as Json, p_values: buildParcelInsert(mail.userId, x, mail.sentAt) as unknown as Json,
      p_items: itemValues(x) as unknown as Json,
    });
    if (inserted.error) throw new Error(`parcels insert failed: ${inserted.error.message}`);
    const row = Array.isArray(inserted.data) ? inserted.data[0] : null;
    if (row?.verdict === "retry") continue;
    if (row?.verdict !== "ok" || typeof row.parcel_id !== "string") throw new Error("parcels insert returned no verdict or id");
    parcelId = row.parcel_id;
    created = true;
    break;
  }
  if (parcelId === null) {
    // Keep the paid evidence even when contention outlasts this request. The mail
    // stays failed/plain for a later read instead of being marked processed.
    const { error } = await db.from("extractions").insert({ user_id: mail.userId, email_id: emailId, parcel_id: null, model: meta.model,
      result: { ...x, _usage: meta.usage, _truncated: meta.truncated } as unknown as Json, confidence: Math.max(0, Math.min(1, x.overall_confidence)) });
    if (error) throw new Error(`extractions insert failed: ${error.message}`);
    throw new Error("parcel changed while a mail was merged; not merged yet");
  }

  // Keep the evidence trail.
  const { error: extractionError } = await db.from("extractions").insert({
    user_id: mail.userId,
    email_id: emailId,
    parcel_id: parcelId,
    model: meta.model,
    result: { ...x, _usage: meta.usage, _truncated: meta.truncated } as unknown as Json,
    confidence: Math.max(0, Math.min(1, x.overall_confidence)),
  });
  if (extractionError) throw new Error(`extractions insert failed: ${extractionError.message}`);
  await refreshTotal(db, mail.userId, parcelId);
  return { parcelId, created };
}

/** `category_source is distinct from 'user'`, in PostgREST's words. */
const NOT_USER_CATEGORY = "category_source.is.null,category_source.neq.user";

type CategoryColumns = Pick<ParcelUpdate, "category" | "category_source">;

/** Normal filing passes a separate category patch to the atomic RPC; twins keep their guarded write. */
function splitCategory(update: ParcelUpdate): { rest: ParcelUpdate; category: CategoryColumns | null } {
  const { category, category_source, ...rest } = update;
  const has = category !== undefined || category_source !== undefined;
  return { rest, category: has ? { category, category_source } : null };
}

/** An automatic category, written only while the person has not chosen one (also when they chose after the read). */
async function writeAutoCategory(db: AdminClient, userId: string, parcelId: string, category: CategoryColumns) {
  const { error } = await db.from("parcels").update(category).eq("id", parcelId).eq("user_id", userId).or(NOT_USER_CATEGORY);
  if (error) throw new Error(`parcels category update failed: ${error.message}`);
}

async function readParcel(db: AdminClient, userId: string, parcelId: string): Promise<ParcelRow | null> {
  const { data, error } = await db.from("parcels").select("*").eq("id", parcelId).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(`parcels lookup failed: ${error.message}`);
  return data;
}

/** Initial items are seeded atomically with creation, or ensured once on an existing parcel. */
function itemValues(x: Extraction) {
  return x.items.map((it) => ({ name: it.name, quantity: it.quantity, unit_price: it.unit_price, evidence: it.evidence }));
}

/** Returned rows must actually contain the requested change, including when a trigger runs. */
function assertParcelWrite(expected: ParcelUpdate, actual: ParcelRow) {
  for (const [key, value] of Object.entries(expected)) {
    if (value === undefined) continue;
    const stored = actual[key as keyof ParcelRow];
    const timestamps = ["ordered_at", "last_email_at", "received_at", "check_dismissed_at"];
    const clockTime = (text: string) => { const [h,m,sec="0"] = text.split(":"); return Number(h)*3600+Number(m)*60+Number(sec); };
    const equal = value !== null && typeof value === "string" && typeof stored === "string"
      ? timestamps.includes(key) ? Date.parse(value) === Date.parse(stored)
        : ["expected_window_start","expected_window_end"].includes(key) ? clockTime(value) === clockTime(stored) : value === stored
      : value === stored;
    if (!equal) throw new Error(`parcels update did not store ${key} as requested`);
  }
}

/**
 * Merge parcels that share this parcel's tracking number into one. Returns the id of the parcel
 * that remains. Every write holds only while the rows are as they were read; when one changed
 * in between, everything is read again and tried once more, then left apart and logged.
 */
async function absorbTwins(db: AdminClient, userId: string, parcelId: string): Promise<string> {
  // Each row's category as the merge last knew it, so a retry can tell whose category changed meanwhile.
  const seen = new Map<string, TwinCategory>();
  for (let attempt = 0; attempt < 2; attempt++) {
    const kept = await tryAbsorbTwins(db, userId, parcelId, seen, attempt > 0);
    if (kept !== null) return kept;
  }
  // No throw here: the webhook's retry would read the mail with Claude again and pay twice.
  console.error(`parcel ${parcelId}: its twins changed while being merged; left apart`);
  return parcelId;
}

/**
 * One go at absorbTwins. Answers null when a row changed since it was read. Records in `seen`
 * each row's category as read, and the kept row's after its own category write.
 */
async function tryAbsorbTwins(db: AdminClient, userId: string, parcelId: string, seen: Map<string, TwinCategory>, retry: boolean): Promise<string | null> {
  const target = await readParcel(db, userId, parcelId);
  if (!target?.tracking_number) return parcelId;
  // Only parcels with this number: the lookup is not cut off by the 1000-row cap.
  const { data: rows, error } = await db.from("parcels").select("*").eq("user_id", userId).eq("tracking_number", target.tracking_number);
  if (error) throw new Error(`parcels lookup failed: ${error.message}`);
  const twins = twinsByTracking(rows, parcelId);
  if (!twins) return parcelId;
  const { keep, absorb } = twins;
  const absorbIds = absorb.map((p) => p.id);
  const seenBefore = retry ? new Map(seen) : undefined;
  for (const p of [keep, ...absorb]) seen.set(p.id, { category: p.category, category_source: p.category_source });

  // Every mail of the parcels being joined, read before anything moves.
  const { data: mails, error: mailsError } = await db
    .from("extractions")
    .select("result, emails(sent_at)")
    .in("parcel_id", [keep.id, ...absorbIds])
    .eq("user_id", userId)
    .eq("emails.user_id", userId);
  if (mailsError) throw new Error(`extractions lookup failed: ${mailsError.message}`);
  const readings = mails.map((m) => ({ x: withDefaults(m.result as unknown as Extraction), sentAt: (m.emails as { sent_at: string | null } | null)?.sent_at ?? null }));

  // A typed-in parcel keeps what the person typed: the mails only fill its gaps, oldest first.
  // Twins from mails are built again from all their mails.
  let fields: ParcelUpdate;
  let merged: { category: string | null; category_source: string | null };
  if (keep.source === "manual") {
    const row: ParcelRow = { ...keep };
    fields = {};
    for (const m of [...readings].sort((a, b) => (a.sentAt ?? "").localeCompare(b.sentAt ?? ""))) {
      const update = mergeIntoManual(row, m.x, m.sentAt);
      Object.assign(row, update);
      Object.assign(fields, update);
    }
    merged = row;
  } else {
    const { user_id: _owner, ...rebuilt } = rebuildParcel(userId, readings);
    void _owner;
    fields = rebuilt;
    merged = { category: rebuilt.category ?? null, category_source: rebuilt.category_source ?? null };
  }
  // 受け取り済み is the person's word, never the mails': either parcel having it is enough, and the merged
  // parcel keeps it (with the status it goes with). The mail processing never sets it by itself.
  const carried = receivedAfterMerge(keep, absorb, fields.status ?? keep.status);
  if (carried && (carried.received_at !== keep.received_at || (fields.status ?? keep.status) !== carried.status)) {
    fields.received_at = carried.received_at;
    fields.status = carried.status;
  }
  // 「まだ」 is the person's word too: either parcel having it is kept, while the merged parcel is delivered.
  const dismissed = dismissedAfterMerge(keep, absorb, fields.status ?? keep.status);
  if (dismissed !== null && dismissed !== keep.check_dismissed_at) fields.check_dismissed_at = dismissed;
  const { rest } = splitCategory(fields);
  const category = categoryForTwins(keep, absorb, merged, seenBefore);

  let keepVersion = keep.updated_at;
  if (Object.keys(rest).length > 0) {
    const { data, error: updateError } = await db.from("parcels").update(rest).eq("id", keep.id).eq("user_id", userId).eq("updated_at", keep.updated_at).select("id, updated_at");
    if (updateError) throw new Error(`parcels rebuild failed: ${updateError.message}`);
    if (!data || data.length === 0) return null;
    keepVersion = data[0].updated_at;
  }
  if (category.category !== keep.category || category.category_source !== keep.category_source) {
    if (category.category_source === "user") {
      // The person's choice on a parcel being folded in must land before that parcel goes.
      const { data, error: carryError } = await db.from("parcels").update(category).eq("id", keep.id).eq("user_id", userId).eq("updated_at", keepVersion).select("id");
      if (carryError) throw new Error(`parcels category carry-over failed: ${carryError.message}`);
      if (!data || data.length !== 1) return null;
      seen.set(keep.id, category);
    } else {
      await writeAutoCategory(db, userId, keep.id, category);
      seen.set(keep.id, category);
    }
  }

  // The survivor keeps its own item list, and borrows one only when it has none.
  const { count, error: countError } = await db
    .from("parcel_items")
    .select("id", { count: "exact", head: true })
    .eq("parcel_id", keep.id)
    .eq("user_id", userId);
  if (countError) throw new Error(`parcel_items count failed: ${countError.message}`);
  if (!count) {
    const { data: donor, error: donorError } = await db.from("parcel_items").select("parcel_id").in("parcel_id", absorbIds).eq("user_id", userId).limit(1);
    if (donorError) throw new Error(`parcel_items lookup failed: ${donorError.message}`);
    if (donor?.[0]) {
      const { error: moveItemsError } = await db
        .from("parcel_items")
        .update({ parcel_id: keep.id })
        .eq("parcel_id", donor[0].parcel_id)
        .eq("user_id", userId);
      if (moveItemsError) throw new Error(`parcel_items move failed: ${moveItemsError.message}`);
    }
  }
  const { error: moveError } = await db.from("extractions").update({ parcel_id: keep.id }).in("parcel_id", absorbIds).eq("user_id", userId);
  if (moveError) throw new Error(`extractions move failed: ${moveError.message}`);

  // Last, so a failure above leaves the twin in place and the next delivery of this mail merges again.
  // A twin the person changed since it was read stays until it is read again.
  for (const twin of absorb) {
    const { data, error: deleteError } = await db.from("parcels").delete().eq("id", twin.id).eq("user_id", userId).eq("updated_at", twin.updated_at).select("id");
    if (deleteError) throw new Error(`parcels delete failed: ${deleteError.message}`);
    if (!data || data.length === 0) return null;
  }
  // A typed-in amount stays; an empty one is filled from the mails.
  if (keep.source === "manual") await refreshTotal(db, userId, keep.id);
  return keep.id;
}

/** Every parcel of this user, with item names, so the rules in chooseParcel see the same data everywhere. */
interface ParcelSnapshotRow { id: string; updated_at: string; item_names: string[] }
async function findParcel(db: AdminClient, userId: string, x: Extraction): Promise<{ parcel: ParcelCandidate | null; snapshot: ParcelSnapshotRow[] }> {
  let data: ParcelRow[];
  let items: Array<{ id: string; parcel_id: string; name: string }>;
  try {
    data = await readAll(() => db.from("parcels").select("*", { count: "exact" }).eq("user_id", userId));
    // Embedded to-many relations have their own row cap. Read every item separately
    // so matching and the SQL snapshot both see the complete names multiset.
    items = data.length === 0 ? [] : await readAll(() => db.from("parcel_items").select("id, parcel_id, name", { count: "exact" }).eq("user_id", userId));
  } catch (err) {
    throw new Error(`parcels lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const names = new Map<string, string[]>();
  for (const item of items) {
    const list = names.get(item.parcel_id) ?? [];
    list.push(item.name);
    names.set(item.parcel_id, list);
  }
  const candidates = data.map((row) => ({ ...row, itemNames: names.get(row.id) ?? [] }));
  const snapshot = candidates.map((row) => ({ id: row.id, updated_at: row.updated_at, item_names: row.itemNames }));
  return { parcel: chooseParcel(candidates, x), snapshot };
}

/**
 * The total depends on every mail read for the parcel, including the one just stored.
 * A typed-in parcel's amount is the person's: it is only filled while empty, checked by the write itself.
 */
async function refreshTotal(db: AdminClient, userId: string, parcelId: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await readParcel(db, userId, parcelId);
    if (!row) throw new Error("parcel disappeared while its total was being saved");
    // A typed-in amount remains the person's value, including a concurrent edit.
    if (row.source === "manual" && row.total_amount !== null) return;
    let data: Array<{ result: Json }>;
    try {
      data = await readAll(() => db.from("extractions").select("id, result", { count: "exact" }).eq("parcel_id", parcelId).eq("user_id", userId));
    } catch (error) {
      throw new Error(`extractions lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const total = parcelTotal(data.map((reading) => reading.result as unknown as Extraction));
    const { data: saved, error: updateError } = await db.from("parcels").update({ total_amount: total }).eq("id", parcelId).eq("user_id", userId)
      .eq("updated_at", row.updated_at).or("source.neq.manual,total_amount.is.null").select("id, total_amount");
    if (updateError) throw new Error(`parcels total update failed: ${updateError.message}`);
    if (!Array.isArray(saved)) throw new Error("parcels total update returned no result");
    if (saved.length === 0) continue;
    if (saved.length !== 1 || saved[0].total_amount !== total) throw new Error("parcels total was not stored as requested");
    return;
  }
  throw new Error("parcel changed while its total was being saved; not saved yet");
}
