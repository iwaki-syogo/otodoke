"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { loadDemoEntries } from "@/lib/demo";
import { processInboundEmail } from "@/lib/pipeline";
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

/** The user says a dropped mail was a parcel notice. Later mail from the same sender is read. */
export async function markWronglyDropped(formData: FormData): Promise<void> {
  const user = await getUser();
  if (!user) redirect("/login");
  const id = String(formData.get("id") ?? "");
  const { error } = await createAdminClient()
    .from("screen_events")
    .update({ flagged_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id);
  revalidatePath("/app/settings");
  if (error) {
    console.error("markWronglyDropped:", error.message);
    redirect(settingsErrorPath("flag_failed"));
  }
  redirect("/app/settings?flagged=1");
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
