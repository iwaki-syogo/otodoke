"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { loadDemoEntries } from "@/lib/demo";
import { processInboundEmail } from "@/lib/pipeline";
import { isRememberableDomain } from "@/lib/screen-senders";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUser } from "@/lib/supabase/server";
import { settingsErrorPath } from "@/lib/settings-errors";
import { UNREAD_FILTER } from "@/lib/unread";

/**
 * Feed the anonymized demo mails through the real pipeline for the signed-in user.
 * Uses precomputed Claude results, so this never calls the API.
 */
export async function loadDemo(): Promise<void> {
  const user = await getUser();
  if (!user) redirect("/login");

  let processed = 0;
  let failure: string | null = null;
  try {
    const db = createAdminClient();
    for (const { mail, extraction } of await loadDemoEntries()) {
      const outcome = await processInboundEmail(
        db,
        {
          userId: user.id,
          providerEmailId: `demo:${mail.file}`,
          messageId: `demo:${mail.file}`,
          from: mail.from,
          fromName: mail.from_name,
          subject: mail.subject,
          sentAt: mail.date,
          text: mail.text,
          html: mail.html,
        },
        {
          publicSample: true,
          precomputed: {
            data: extraction,
            model: "precomputed",
            truncated: false,
            usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
      );
      if (outcome.kind === "processed" || outcome.kind === "noted" || outcome.kind === "duplicate") processed++;
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  revalidatePath("/app", "layout");
  if (failure) {
    // The message stays in the server log; the page shows fixed words for the code.
    console.error("loadDemo failed:", failure);
    redirect(settingsErrorPath("demo_failed", `&demo=${processed}`));
  }
  redirect("/app");
}

/** Read mail that arrived after the daily limit. Stops when today's allowance runs out again. */
export async function readWaitingMail(): Promise<void> {
  const user = await getUser();
  if (!user) redirect("/login");

  const db = createAdminClient();
  const { data, error } = await db
    .from("emails")
    .select("id, provider_email_id, message_id, from_address, from_name, subject, sent_at, text_body, html_body")
    .eq("user_id", user.id)
    .eq("body_state", "plain")
    .or(UNREAD_FILTER())
    .order("sent_at", { ascending: true })
    .limit(20);
  if (error) {
    console.error("readWaitingMail (lookup):", error.message);
    redirect(settingsErrorPath("read_failed"));
  }

  let failure: string | null = null;
  for (const m of data) {
    try {
      const outcome = await processInboundEmail(
        db,
        {
          userId: user.id,
          providerEmailId: m.provider_email_id,
          messageId: m.message_id,
          from: m.from_address ?? "",
          fromName: m.from_name,
          subject: m.subject ?? "",
          sentAt: m.sent_at,
          text: m.text_body,
          html: m.html_body,
        },
        // Without a Message-ID the pipeline cannot find this row again, so it would be duplicated:
        // it replaces this row instead, removed only once nothing can fail before the new one is stored.
        m.message_id ? {} : { replacesEmailId: m.id },
      );
      if (outcome.kind === "over_limit") break;
    } catch (err) {
      // One unreadable mail must not hold back the ones after it.
      failure = err instanceof Error ? err.message : String(err);
    }
  }

  revalidatePath("/app", "layout");
  if (failure) {
    console.error("readWaitingMail:", failure);
    redirect(settingsErrorPath("read_failed"));
  }
  redirect("/app/settings");
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The user says a dropped mail was a parcel notice. Later mail from the same sender's domain is
 * no longer dropped by the free rules alone: the cheap Claude check decides (src/lib/pipeline.ts).
 * A domain many people have their own address on (gmail.com, ...) is not remembered at all
 * (src/lib/screen-senders.ts); the page says so. The mail itself was not kept either way, so the
 * page offers to register the parcel by hand.
 */
export async function markWronglyDropped(formData: FormData): Promise<void> {
  const user = await getUser();
  if (!user) redirect("/login");
  const id = String(formData.get("id") ?? "");
  let outcome: "remembered" | "shared" | "failed" = "failed";
  if (UUID.test(id)) {
    const db = createAdminClient();
    const { data: row, error: readError } = await db.from("screen_events").select("from_domain").eq("id", id).eq("user_id", user.id).eq("decision", "dropped").maybeSingle();
    if (readError) console.error("markWronglyDropped (lookup):", readError.message);
    else if (row && !isRememberableDomain(row.from_domain)) outcome = "shared";
    else if (row) {
      const { error } = await db.from("screen_events").update({ flagged_at: new Date().toISOString() }).eq("id", id).eq("user_id", user.id);
      if (error) console.error("markWronglyDropped:", error.message);
      else outcome = "remembered";
    }
  }
  revalidatePath("/app/settings");
  redirect(`/app/settings?flagged=${outcome}`);
}

/**
 * 「外す」 on a remembered sender: its mail goes through the free rules again, and its marked rows
 * fall back to the 14-day rule like any dropped mail (they are removed once that old).
 */
export async function forgetSender(formData: FormData): Promise<void> {
  const user = await getUser();
  if (!user) redirect("/login");
  const domain = String(formData.get("domain") ?? "");
  let ok = false;
  if (domain && domain.length <= 255) {
    const { error } = await createAdminClient().from("screen_events").update({ flagged_at: null }).eq("user_id", user.id).eq("from_domain", domain).not("flagged_at", "is", null);
    if (error) console.error("forgetSender:", error.message);
    else ok = true;
  }
  revalidatePath("/app/settings");
  redirect(`/app/settings?unflagged=${ok ? "done" : "failed"}`);
}

/** Remove everything this user has (used to reset a demo account). */
export async function clearAllParcels(formData: FormData): Promise<void> {
  const user = await getUser();
  if (!user) redirect("/login");
  if (formData.get("confirm") !== "yes") redirect(settingsErrorPath("clear_confirm"));

  const db = createAdminClient();
  // extractions and parcel_items cascade from parcels / emails.
  const { error: e1 } = await db.from("parcels").delete().eq("user_id", user.id);
  const { error: e2 } = await db.from("emails").delete().eq("user_id", user.id);
  const failure = e1?.message ?? e2?.message ?? null;

  revalidatePath("/app", "layout");
  if (failure) {
    console.error("clearAllParcels:", failure);
    redirect(settingsErrorPath("clear_failed"));
  }
  redirect("/app/settings?cleared=1");
}
