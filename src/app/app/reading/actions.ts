"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AI_CONSENT_TEXT_VERSION } from "@/lib/ai-consent-text";
import { runReadAfterConsent } from "@/lib/ai-consent-run";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getUser } from "@/lib/supabase/server";
import { settingsErrorPath, type SettingsErrorCode } from "@/lib/settings-errors";

/** Store only the signed-in person's choice through the database's checked, server-timed RPC. */
export async function setAiReadingDecision(formData: FormData): Promise<void> {
  const requestStartedAt = Date.now();
  const user = await getUser();
  if (!user) redirect("/login");
  const decision = formData.get("decision");
  const after = formData.get("after");
  const suffix = after === "welcome" ? "&after=welcome" : after === "settings" ? "&after=settings" : "";
  if (decision !== "granted" && decision !== "declined") redirect(`/app/reading?error=save${suffix}`);

  let decidedAt: string | null = null;
  try {
    const db = await createClient();
    const { data, error } = await db.rpc("set_ai_reading", { p_decision: decision, p_text_version: AI_CONSENT_TEXT_VERSION });
    if (!error && data?.length === 1 && data[0].decision === decision && Number.isFinite(Date.parse(data[0].decided_at))) decidedAt = data[0].decided_at;
  } catch {
    console.error("reading permission: saving the choice failed");
  }
  if (decidedAt === null) redirect(`/app/reading?error=save${suffix}`);

  // The choice is already saved. A failed backlog read must never undo or misreport that save.
  let readError: SettingsErrorCode | null = null;
  if (decision === "granted") {
    try {
      const read = await runReadAfterConsent(createAdminClient(), user.id, decidedAt, requestStartedAt);
      if (read.unavailable) readError = "read_unavailable";
      else if (!read.ok && !(read.stage === "read" && read.onlyBusy)) readError = "read_failed";
      else if (read.overLimit) readError = "read_over_limit";
    } catch {
      console.error("reading permission: reading the waiting mail failed after saving the choice");
      readError = "read_failed";
    }
  }

  revalidatePath("/app", "layout");
  if (readError) redirect(settingsErrorPath(readError));
  if (after === "settings") redirect("/app/settings/mail-handling");
  if (decision === "granted" && after === "welcome") redirect("/app/welcome");
  redirect("/app");
}
