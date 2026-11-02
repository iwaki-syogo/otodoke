import type { AdminClient } from "@/lib/supabase/admin";
import { extractEmail, type ExtractionResult } from "@/lib/extract/extract";
import { isPurchaseMail } from "@/lib/extract/triage";
import { isParcelRelevant, buildParcelInsert, buildParcelUpdate, chooseParcel, parcelTotal, startsParcel } from "@/lib/match";
import { env } from "@/lib/env";
import { isForwardingConfirmation as isGmailConfirmation } from "@/lib/forwarding";
import { PENDING_GRACE_MS } from "@/lib/unread";
import { screenMail, type ScreenResult } from "@/lib/screen";
import { emailBodyText } from "@/lib/text/html-to-text";
import type { Extraction } from "@/lib/extract/schema";
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

  // 0. Ads and newsletters stop here: nothing is stored and Claude is not called.
  if (!isForwardingConfirmation && !options.precomputed) {
    const screen = screenMail(mail);
    if (!screen.pass) {
      const keep = await secondLook(db, mail, screen);
      await logScreenEvent(db, mail, keep ? "rescued" : "dropped", screen.reason);
      if (!keep) {
        // Re-reading a stored mail can land here too. Leave no row behind, or it would stay unread forever.
        if (mail.messageId) {
          const { error } = await db.from("emails").delete().eq("user_id", mail.userId).eq("message_id", mail.messageId);
          if (error) throw new Error(`emails cleanup failed: ${error.message}`);
        }
        return { kind: "screened_out", reason: screen.reason };
      }
    }
  }

  // 1. Store the raw mail (dedupe by Message-ID).
  if (mail.messageId) {
    const { data: existing, error } = await db
      .from("emails")
      .select("id, processing_status, created_at")
      .eq("user_id", mail.userId)
      .eq("message_id", mail.messageId)
      .maybeSingle();
    if (error) throw new Error(`emails lookup failed: ${error.message}`);
    if (existing?.processing_status === "processed") return { kind: "duplicate", emailId: existing.id };
    // Another delivery of this mail is being read right now. Removing its row would break that run
    // and pay for a second read, so fail and let the webhook retry later.
    if (existing?.processing_status === "pending" && Date.now() - new Date(existing.created_at).getTime() < PENDING_GRACE_MS) {
      throw new Error("this mail is still being read");
    }
    if (existing) {
      const { error: deleteError } = await db.from("emails").delete().eq("id", existing.id);
      if (deleteError) throw new Error(`emails cleanup failed: ${deleteError.message}`);
    }
  }

  const { data: emailRow, error: insertError } = await db
    .from("emails")
    .insert({
      user_id: mail.userId,
      provider_email_id: mail.providerEmailId,
      message_id: mail.messageId,
      from_address: mail.from,
      from_name: mail.fromName,
      subject: mail.subject,
      sent_at: mail.sentAt,
      text_body: mail.text,
      html_body: mail.html,
      classification: isForwardingConfirmation ? "forwarding_confirmation" : null,
      processing_status: isForwardingConfirmation ? "processed" : "pending",
    })
    .select("id")
    .single();
  if (insertError || !emailRow) throw new Error(`emails insert failed: ${insertError?.message}`);

  if (isForwardingConfirmation) return { kind: "forwarding_confirmation", emailId: emailRow.id };

  // 1.5. Take one paid call from today's allowance. Over the limit, the mail is kept to read later.
  if (!options.precomputed) {
    const { OTODOKE_USER_DAILY_LIMIT, OTODOKE_GLOBAL_DAILY_LIMIT } = env();
    const { data: claim, error: claimError } = await db.rpc("claim_claude_call", {
      p_user_id: mail.userId,
      p_user_limit: OTODOKE_USER_DAILY_LIMIT,
      p_global_limit: OTODOKE_GLOBAL_DAILY_LIMIT,
    });
    if (claimError) {
      await db.from("emails").update({ processing_status: "failed", error: claimError.message }).eq("id", emailRow.id);
      throw new Error(`claim_claude_call failed: ${claimError.message}`);
    }
    if (claim !== "ok") {
      const { error } = await db.from("emails").update({ processing_status: "over_limit", error: claim }).eq("id", emailRow.id);
      if (error) throw new Error(`emails update failed: ${error.message}`);
      return { kind: "over_limit", emailId: emailRow.id, limit: claim };
    }
  }

  try {
    return await understandAndFile(db, mail, emailRow.id, options);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.from("emails").update({ processing_status: "failed", error: message }).eq("id", emailRow.id);
    throw err;
  }
}

function domainOf(address: string): string | null {
  return address.split("@")[1]?.trim().toLowerCase() || null;
}

/**
 * A dropped mail still goes on when the user has marked this sender as wrongly dropped,
 * or when a cheap Claude check says it is a purchase notice.
 */
async function secondLook(db: AdminClient, mail: InboundEmail, screen: ScreenResult): Promise<boolean> {
  const domain = domainOf(mail.from);
  if (domain) {
    const { count } = await db
      .from("screen_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", mail.userId)
      .eq("from_domain", domain)
      .not("flagged_at", "is", null);
    if (count) return true;
  }
  if (!screen.borderline) return false;

  const { OTODOKE_USER_DAILY_LIMIT, OTODOKE_GLOBAL_DAILY_LIMIT } = env();
  const { data: claim, error } = await db.rpc("claim_claude_call", {
    p_user_id: mail.userId,
    p_user_limit: OTODOKE_USER_DAILY_LIMIT,
    p_global_limit: OTODOKE_GLOBAL_DAILY_LIMIT,
  });
  // Over the limit or unable to tell: keep it. The next step stores it as unread instead of losing it.
  if (error || claim !== "ok") return true;
  return isPurchaseMail(mail);
}

/** Bookkeeping must never cost a mail, so a failure here is only logged. */
async function logScreenEvent(db: AdminClient, mail: InboundEmail, decision: "dropped" | "rescued", reason: string) {
  const { error } = await db.from("screen_events").insert({
    user_id: mail.userId,
    from_domain: domainOf(mail.from),
    subject: mail.subject.slice(0, 200),
    decision,
    reason,
  });
  if (error) console.error("screen_events insert failed:", error.message);
  const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { error: cleanupError } = await db.from("screen_events").delete().eq("user_id", mail.userId).lt("created_at", cutoff).is("flagged_at", null);
  if (cleanupError) console.error("screen_events cleanup failed:", cleanupError.message);
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
  const x = extraction.data;

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

  // 4. Find the parcel this mail belongs to.
  const parcel = await findParcel(db, mail.userId, x);
  if (!parcel && !startsParcel(x)) {
    const { error } = await db.from("extractions").insert({
      user_id: mail.userId,
      email_id: emailId,
      parcel_id: null,
      model: extraction.model,
      result: { ...x, _usage: extraction.usage, _truncated: extraction.truncated } as unknown as Json,
      confidence: Math.max(0, Math.min(1, x.overall_confidence)),
    });
    if (error) throw new Error(`extractions insert failed: ${error.message}`);
    const { error: statusError } = await db.from("emails").update({ classification: x.relevance, processing_status: "processed" }).eq("id", emailId);
    if (statusError) throw new Error(`emails update failed: ${statusError.message}`);
    return { kind: "noted", emailId };
  }

  let parcelId: string;
  let created = false;
  if (parcel) {
    const update = buildParcelUpdate(parcel, x, mail.sentAt);
    if (Object.keys(update).length > 0) {
      const { error } = await db.from("parcels").update(update).eq("id", parcel.id);
      if (error) throw new Error(`parcels update failed: ${error.message}`);
    }
    parcelId = parcel.id;
  } else {
    const { data: inserted, error } = await db
      .from("parcels")
      .insert(buildParcelInsert(mail.userId, x, mail.sentAt))
      .select("id")
      .single();
    if (error || !inserted) throw new Error(`parcels insert failed: ${error?.message}`);
    parcelId = inserted.id;
    created = true;
  }

  // 5. Items: only when the parcel has none yet (order mails carry the full list).
  if (x.items.length > 0) {
    const { count, error: countError } = await db.from("parcel_items").select("id", { count: "exact", head: true }).eq("parcel_id", parcelId);
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

  // 6. Keep the evidence trail.
  const { error: extractionError } = await db.from("extractions").insert({
    user_id: mail.userId,
    email_id: emailId,
    parcel_id: parcelId,
    model: extraction.model,
    result: { ...x, _usage: extraction.usage, _truncated: extraction.truncated } as unknown as Json,
    confidence: Math.max(0, Math.min(1, x.overall_confidence)),
  });
  if (extractionError) throw new Error(`extractions insert failed: ${extractionError.message}`);
  await refreshTotal(db, parcelId);

  const { error: statusError } = await db.from("emails").update({ classification: x.relevance, processing_status: "processed" }).eq("id", emailId);
  if (statusError) throw new Error(`emails update failed: ${statusError.message}`);

  return { kind: "processed", emailId, parcelId, created, extraction: x };
}

/** Every parcel of this user, with item names, so the rules in chooseParcel see the same data everywhere. */
async function findParcel(db: AdminClient, userId: string, x: Extraction) {
  const { data, error } = await db.from("parcels").select("*, parcel_items(name)").eq("user_id", userId);
  if (error) throw new Error(`parcels lookup failed: ${error.message}`);
  const candidates = data.map(({ parcel_items, ...row }) => ({ ...row, itemNames: parcel_items.map((it: { name: string }) => it.name) }));
  return chooseParcel(candidates, x);
}

/** The total depends on every mail read for the parcel, including the one just stored. */
async function refreshTotal(db: AdminClient, parcelId: string) {
  const { data, error } = await db.from("extractions").select("result").eq("parcel_id", parcelId);
  if (error) throw new Error(`extractions lookup failed: ${error.message}`);
  const total = parcelTotal(data.map((row) => row.result as unknown as Extraction));
  const { error: updateError } = await db.from("parcels").update({ total_amount: total }).eq("id", parcelId);
  if (updateError) throw new Error(`parcels total update failed: ${updateError.message}`);
}
