"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AI_CONSENT_TEXT_VERSION } from "@/lib/ai-consent-text";
import { createClient, getUser } from "@/lib/supabase/server";

/** Store only the signed-in person's choice through the database's checked, server-timed RPC. */
export async function setAiReadingDecision(formData: FormData): Promise<void> {
  const user = await getUser();
  if (!user) redirect("/login");
  const decision = formData.get("decision");
  const after = formData.get("after");
  const suffix = after === "welcome" ? "&after=welcome" : after === "settings" ? "&after=settings" : "";
  if (decision !== "granted" && decision !== "declined") redirect(`/app/reading?error=save${suffix}`);

  let saved = false;
  try {
    const db = await createClient();
    const { data, error } = await db.rpc("set_ai_reading", { p_decision: decision, p_text_version: AI_CONSENT_TEXT_VERSION });
    saved = !error && data?.length === 1 && data[0].decision === decision && Number.isFinite(Date.parse(data[0].decided_at));
  } catch {
    console.error("reading permission: saving the choice failed");
  }
  if (!saved) redirect(`/app/reading?error=save${suffix}`);

  revalidatePath("/app", "layout");
  if (after === "settings") redirect("/app/settings/mail-handling");
  if (decision === "granted" && after === "welcome") redirect("/app/welcome");
  redirect("/app");
}
