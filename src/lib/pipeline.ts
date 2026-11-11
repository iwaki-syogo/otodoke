import type { AdminClient } from "@/lib/supabase/admin";
import { readAll } from "@/lib/supabase/read-all";
import { extractEmail, type ExtractionResult } from "@/lib/extract/extract";
import { isPurchaseMail } from "@/lib/extract/triage";
import { ClaudeUnavailableError, claudeFailure } from "@/lib/extract/claude-error";
import { claimClaudeCall, type ClaudeClaim } from "@/lib/claude-usage";
import {
  isParcelRelevant,
  buildParcelInsert,
  buildParcelUpdate,
  chooseParcel,
  mergeIntoManual,
  parcelTotal,
  rebuildParcel,
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
import { screenMail, type ScreenResult } from "@/lib/screen";
import { isRememberableDomain } from "@/lib/screen-senders";
import { emailBodyText } from "@/lib/text/html-to-text";
import { withDefaults, type Extraction } from "@/lib/extract/schema";
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
}

export type PipelineOutcome =
  | { kind: "duplicate"; emailId: string }
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
   * The stored row of this mail, when it has no Message-ID to be found again by (re-reading a
   * stored mail from 設定). The mail is read again in that row, in place, like a row found by its
   * Message-ID: the row is never removed and stored anew, so a failure never loses the only copy.
   */
  replacesEmailId?: string;
}

/** The stored row of a mail, as far as deciding what to do with it goes. */
interface StoredRow {
  id: string;
  processing_status: string;
  created_at: string;
}

/** The row this mail already has: by its Message-ID, or the row being read again. Throws when it cannot tell. */
async function storedRow(db: AdminClient, mail: InboundEmail, rowId: string | null): Promise<StoredRow | null> {
  if (!mail.messageId && !rowId) return null;
  const query = db.from("emails").select("id, processing_status, created_at").eq("user_id", mail.userId);
  const { data, error } = await (mail.messageId ? query.eq("message_id", mail.messageId) : query.eq("id", rowId!)).maybeSingle();
  if (error) throw new Error(`emails lookup failed: ${error.message}`);
  // A row found by its Message-ID wins; the row named for re-reading is the fallback.
  if (!data && mail.messageId && rowId) return storedRow(db, { ...mail, messageId: null }, rowId);
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
  const isForwardingConfirmation = isGmailConfirmation(mail.from);

  // The row this mail already has, looked up before the screen: a mail that was read is never
  // screened, paid for or removed again when it is delivered a second time.
  const stored = await storedRow(db, mail, options.replacesEmailId ?? null);
  if (stored?.processing_status === "processed") return { kind: "duplicate", emailId: stored.id };
  // Another delivery of this mail is being read right now. Taking its row over would break that
  // run and pay for a second read, so fail and let the webhook retry later.
  if (stored?.processing_status === "pending" && Date.now() - new Date(stored.created_at).getTime() < PENDING_GRACE_MS) {
    throw new MailBeingReadError("this mail is still being read");
  }

  // 0. Ads and newsletters stop here: nothing is stored and Claude is not called.
  if (!isForwardingConfirmation && !options.precomputed) {
    const screen = screenMail(mail);
    if (!screen.pass) {
      const keep = await secondLook(db, mail, screen);
      if (keep) {
        await logScreenEvent(db, mail, "rescued", screen.reason);
      } else {
        // Re-reading a stored mail can land here too. Leave no row behind, or it would stay unread
        // forever. Only while the row is as it was read, as for the take-over below: a delivery that
        // took it over meanwhile is reading it, and its row is not removed from under it.
        let removed = true;
        if (stored) {
          const { data, error } = await db
            .from("emails")
            .delete()
            .eq("user_id", mail.userId)
            .eq("id", stored.id)
            .eq("processing_status", stored.processing_status)
            .eq("created_at", stored.created_at)
            .select("id");
          if (error) throw new Error(`emails cleanup failed: ${error.message}`);
          removed = (data ?? []).length > 0;
        }
        // Logged as dropped (its subject in plaintext, for 14 days) only once its row is gone: a
        // delivery that took the row over may read and seal it (review R3-33). Removed first and
        // logged after, so a failure in between leaves no subject behind.
        if (removed) await logScreenEvent(db, mail, "dropped", screen.reason);
        return { kind: "screened_out", reason: screen.reason };
      }
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
  let emailRow: { id: string };
  if (stored) {
    // Only while the row is as it was read: two deliveries never both take it over and pay twice.
    // created_at starts the pending grace again, as a new row would.
    const { data, error } = await db
      .from("emails")
      .update({ ...columns, created_at: new Date().toISOString() })
      .eq("id", stored.id)
      .eq("user_id", mail.userId)
      .eq("processing_status", stored.processing_status)
      .eq("created_at", stored.created_at)
      .select("id")
      .maybeSingle();
    if (error) throw new Error(`emails update failed: ${error.message}`);
    // Another run took the row over first (two presses at once): not a failure of this mail.
    if (!data) throw new MailBeingReadError("this mail changed while it was being stored; it is read on the next try");
    // What an earlier, unfinished read of this row left: read again from the start, as for a new row.
    const { error: leftoverError } = await db.from("extractions").delete().eq("email_id", stored.id).eq("user_id", mail.userId);
    if (leftoverError) throw new Error(`extractions cleanup failed: ${leftoverError.message}`);
    emailRow = data;
  } else {
    const { data, error } = await db
      .from("emails")
      .insert({ id: emailId, user_id: mail.userId, ...columns })
      .select("id")
      .single();
    // 23505: another run stored the same mail between the lookup above and this insert.
    if (error?.code === "23505") throw new MailBeingReadError(`emails insert failed: ${error.message}`);
    if (error || !data) throw new Error(`emails insert failed: ${error?.message}`);
    emailRow = data;
  }

  if (isForwardingConfirmation) return { kind: "forwarding_confirmation", emailId: emailRow.id };

  // 1.5. Take one paid call from today's allowance. Over the limit, the mail is kept to read later.
  let claim: ClaudeClaim | null = null;
  if (!options.precomputed) {
    try {
      claim = await claimClaudeCall(db, mail.userId);
    } catch (err) {
      await db.from("emails").update({ processing_status: "failed", error: err instanceof Error ? err.message : String(err) }).eq("id", emailRow.id);
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
  } catch {
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
  const x = withDefaults(extraction.data);

  // A refusal says nothing about the mail, so it is kept as unread rather than dropped as unrelated.
  if (extraction.refused) {
    const { error } = await db.from("emails").update({ processing_status: "failed", error: "model refused" }).eq("id", emailId);
    if (error) throw new Error(`emails update failed: ${error.message}`);
    return { kind: "discarded", reason: "model refused" };
  }

  // 3. Unrelated mail is not kept at all.
  if (!isParcelRelevant(x.relevance)) {
    await db.from("emails").delete().eq("id", emailId);
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
  const parcel = await findParcel(db, mail.userId, x);
  if (!parcel && !startsParcel(x)) return null;

  let parcelId: string;
  let created = false;
  if (parcel) {
    if (parcel.source === "manual") {
      await fillManual(db, mail.userId, parcel, x, mail.sentAt);
    } else {
      const { rest, category } = splitCategory(buildParcelUpdate(parcel, x, mail.sentAt));
      if (Object.keys(rest).length > 0) {
        const { error } = await db.from("parcels").update(rest).eq("id", parcel.id).eq("user_id", mail.userId);
        if (error) throw new Error(`parcels update failed: ${error.message}`);
      }
      if (category) await writeAutoCategory(db, mail.userId, parcel.id, category);
    }
    parcelId = parcel.id;
  } else {
    const { data: inserted, error } = await db.from("parcels").insert(buildParcelInsert(mail.userId, x, mail.sentAt)).select("id").single();
    if (error || !inserted) throw new Error(`parcels insert failed: ${error?.message}`);
    parcelId = inserted.id;
    created = true;
  }

  // Items: only when the parcel has none yet (order mails carry the full list).
  if (x.items.length > 0) {
    const { count, error: countError } = await db
      .from("parcel_items")
      .select("id", { count: "exact", head: true })
      .eq("parcel_id", parcelId)
      .eq("user_id", mail.userId);
    if (countError) throw new Error(`parcel_items count failed: ${countError.message}`);
    if (!count) {
      const { error } = await db.from("parcel_items").insert(
        x.items.map((it) => ({
          parcel_id: parcelId,
          user_id: mail.userId,
          name: it.name,
          quantity: it.quantity,
          unit_price: it.unit_price,
          evidence: it.evidence,
        })),
      );
      if (error) throw new Error(`parcel_items insert failed: ${error.message}`);
    }
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

/** The category columns go in a write of their own, so their guard never holds back the rest. */
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

/**
 * A mail fills the gaps of a parcel the person typed in. The write holds only while the row is
 * as it was read (updated_at), so a value they save in between is kept: the row is read again
 * and merged once more, and a second miss fails the mail so it can be read again.
 */
async function fillManual(db: AdminClient, userId: string, read: ParcelRow, x: Extraction, sentAt: string | null) {
  let row: ParcelRow | null = read;
  for (let attempt = 0; attempt < 2 && row; attempt++) {
    const { rest, category } = splitCategory(mergeIntoManual(row, x, sentAt));
    if (Object.keys(rest).length > 0) {
      const { data, error } = await db.from("parcels").update(rest).eq("id", row.id).eq("user_id", userId).eq("updated_at", row.updated_at).select("id");
      if (error) throw new Error(`parcels update failed: ${error.message}`);
      if (!data || data.length === 0) {
        row = await readParcel(db, userId, row.id);
        continue;
      }
    }
    if (category) await writeAutoCategory(db, userId, row.id, category);
    return;
  }
  // Not merged: the mail must not be marked processed, or a redelivery would skip it. Failing
  // leaves it as failed for the webhook's retry, which merges again into what the person saved.
  throw new Error(`parcel ${read.id}: changed by the user while a mail was merged; not merged yet`);
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
async function findParcel(db: AdminClient, userId: string, x: Extraction): Promise<ParcelCandidate | null> {
  // The embedded items are filtered too: the service role sees every account's rows.
  // Read past the 1000-row cap: a parcel cut off here would be missed and opened a second time.
  let data: Array<ParcelRow & { parcel_items: Array<{ name: string }> }>;
  try {
    data = await readAll(() => db.from("parcels").select("*, parcel_items(name)", { count: "exact" }).eq("user_id", userId).eq("parcel_items.user_id", userId));
  } catch (err) {
    throw new Error(`parcels lookup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const candidates = data.map(({ parcel_items, ...row }) => ({ ...row, itemNames: parcel_items.map((it) => it.name) }));
  return chooseParcel(candidates, x);
}

/**
 * The total depends on every mail read for the parcel, including the one just stored.
 * A typed-in parcel's amount is the person's: it is only filled while empty, checked by the write itself.
 */
async function refreshTotal(db: AdminClient, userId: string, parcelId: string) {
  const { data, error } = await db.from("extractions").select("result").eq("parcel_id", parcelId).eq("user_id", userId);
  if (error) throw new Error(`extractions lookup failed: ${error.message}`);
  const total = parcelTotal(data.map((row) => row.result as unknown as Extraction));
  const { error: updateError } = await db
    .from("parcels")
    .update({ total_amount: total })
    .eq("id", parcelId)
    .eq("user_id", userId)
    .or("source.neq.manual,total_amount.is.null");
  if (updateError) throw new Error(`parcels total update failed: ${updateError.message}`);
}
