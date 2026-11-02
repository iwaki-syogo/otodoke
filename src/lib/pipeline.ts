import type { AdminClient } from "@/lib/supabase/admin";
import { extractEmail, type ExtractionResult } from "@/lib/extract/extract";
import { isParcelRelevant, buildParcelInsert, buildParcelUpdate, normalizeOrderNumber } from "@/lib/match";
import { normalizeTracking } from "@/lib/carriers";
import { env } from "@/lib/env";
import { screenMail } from "@/lib/screen";
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
  | { kind: "processed"; emailId: string; parcelId: string; created: boolean; extraction: Extraction };

const FORWARDING_CONFIRMATION =
  /forwarding-noreply@google\.com|転送の確認|Forwarding Confirmation|Gmail の転送|メール転送の確認/i;

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
  const isForwardingConfirmation = FORWARDING_CONFIRMATION.test(`${mail.from} ${mail.subject}`);

  // 0. Ads and newsletters stop here: nothing is stored and Claude is not called.
  if (!isForwardingConfirmation && !options.precomputed) {
    const screen = screenMail(mail);
    if (!screen.pass) return { kind: "screened_out", reason: screen.reason };
  }

  // 1. Store the raw mail (dedupe by Message-ID).
  if (mail.messageId) {
    const { data: existing, error } = await db
      .from("emails")
      .select("id, processing_status")
      .eq("user_id", mail.userId)
      .eq("message_id", mail.messageId)
      .maybeSingle();
    if (error) throw new Error(`emails lookup failed: ${error.message}`);
    if (existing?.processing_status === "processed") return { kind: "duplicate", emailId: existing.id };
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

  // 3. Unrelated mail is not kept at all.
  if (!isParcelRelevant(x.relevance)) {
    await db.from("emails").delete().eq("id", emailId);
    return { kind: "discarded", reason: x.relevance_evidence ?? "unrelated" };
  }

  // 4. Find the parcel this mail belongs to.
  const parcel = await findParcel(db, mail.userId, x);
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

  const { error: statusError } = await db.from("emails").update({ classification: x.relevance, processing_status: "processed" }).eq("id", emailId);
  if (statusError) throw new Error(`emails update failed: ${statusError.message}`);

  return { kind: "processed", emailId, parcelId, created, extraction: x };
}

/** Match by order number first, then tracking number, then a recent parcel with the same first item. */
async function findParcel(db: AdminClient, userId: string, x: Extraction) {
  const shopKey = x.shop_key ?? "other";
  const orderNumber = x.order_number.value ? normalizeOrderNumber(x.order_number.value) : null;
  if (orderNumber) {
    const { data, error } = await db.from("parcels").select("*").eq("user_id", userId).not("order_number", "is", null);
    if (error) throw new Error(`parcels lookup failed: ${error.message}`);
    const hit = data.find((p) => p.order_number && normalizeOrderNumber(p.order_number) === orderNumber);
    if (hit) return hit;
  }
  const tracking = x.tracking_number.value ? normalizeTracking(x.tracking_number.value) : null;
  if (tracking) {
    const { data, error } = await db
      .from("parcels")
      .select("*")
      .eq("user_id", userId)
      .eq("tracking_number", tracking)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw new Error(`parcels lookup failed: ${error.message}`);
    if (data[0]) return data[0];
  }
  if (x.items.length > 0 && x.relevance !== "order") {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await db
      .from("parcels")
      .select("*, parcel_items(name)")
      .eq("user_id", userId)
      .eq("shop_key", shopKey)
      .gte("created_at", since)
      .neq("status", "delivered")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(`parcels lookup failed: ${error.message}`);
    const first = x.items[0].name.replace(/\.{3}|…/g, "").trim();
    const hit = data.find((p) =>
      p.parcel_items?.some((it: { name: string }) => {
        const name = it.name.replace(/\.{3}|…/g, "").trim();
        return name.startsWith(first) || first.startsWith(name);
      }),
    );
    if (hit) {
      // Drop the embedded relation before returning a plain ParcelRow.
      const { parcel_items: _items, ...row } = hit;
      void _items;
      return row;
    }
  }
  return null;
}
