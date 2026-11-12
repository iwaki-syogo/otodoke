"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { runClearAllParcels, runLoadDemo } from "@/lib/demo-run";
import { isScreenEventId, runMarkWronglyDropped, runReadWaitingMail } from "@/lib/mail-run";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getUser } from "@/lib/supabase/server";
import { settingsErrorPath } from "@/lib/settings-errors";
import { readAiReadingConsent } from "@/lib/ai-consent";
import { requireDisplayedUser } from "@/lib/action-identity";
import { isIntakeNoticeTimestamp, isRememberedSenderDomain, runDismissIntakeNotice, runForgetSender } from "@/lib/settings-mail-actions";

/**
 * Feed the anonymized demo mails through the real pipeline for the signed-in user.
 * Uses precomputed Claude results, so this never calls the API.
 */
export async function loadDemo(formData: FormData): Promise<void> {
  const user = await getUser();
  requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/demo");

  const loaded = await runLoadDemo(createAdminClient, user.id);

  revalidatePath("/app", "layout");
  if (!loaded.ok) {
    // The message stays in the server log; the page shows fixed words for the code.
    console.error("loadDemo failed:", loaded.message);
    redirect(settingsErrorPath("demo_failed", `&demo=${loaded.processed}`));
  }
  // The list shows a one-line note for this; the other load is still going.
  const consent = await readAiReadingConsent(await createClient(), user.id);
  // The sample's saved readings send no mail to Claude and never record a permission choice.
  if (consent !== "granted") redirect(loaded.busy ? "/app?sample=1&demo=busy" : "/app?sample=1");
  redirect(loaded.busy ? "/app?demo=busy" : "/app");
}

/** Read mail that arrived after the daily limit. Stops when today's allowance runs out again. */
export async function readWaitingMail(formData: FormData): Promise<void> {
  const user = await getUser();
  requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/trouble");

  // Check before taking over any stored mail: the permission screen also has a recovery exit
  // when the choice cannot be read. The pipeline still checks again before each paid read.
  const consent = await readAiReadingConsent(await createClient(), user.id);
  if (consent !== "granted") redirect("/app/reading?after=settings");

  const done = await runReadWaitingMail(createAdminClient(), user.id);
  if (!done.ok && done.stage === "lookup") {
    console.error("readWaitingMail (lookup):", done.message);
    redirect(settingsErrorPath("read_failed"));
  }

  revalidatePath("/app", "layout");
  // Stopped first (nothing to retry), then a real failure, then the daily limit; else all was read.
  if (done.unavailable) {
    // A real failure in the same run is not shown (the stop is), but it stays in the server log.
    if (!done.ok) console.error("readWaitingMail:", done.message);
    redirect(settingsErrorPath("read_unavailable"));
  }
  if (!done.ok) {
    console.error("readWaitingMail:", done.message);
    redirect(settingsErrorPath("read_failed"));
  }
  if (done.overLimit) redirect(settingsErrorPath("read_over_limit"));
  redirect("/app/settings/trouble");
}

/**
 * The user says a dropped mail was a parcel notice. Later mail from the same sender's domain is
 * no longer dropped by the free rules alone: the cheap Claude check decides (src/lib/pipeline.ts).
 * A domain many people have their own address on (gmail.com, ...) is not remembered at all
 * (src/lib/screen-senders.ts); the page says so. The mail itself was not kept either way, so the
 * page offers to register the parcel by hand.
 */
export async function markWronglyDropped(formData: FormData): Promise<void> {
  const user = await getUser();
  requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/dropped");
  const id = String(formData.get("id") ?? "");
  let outcome: "remembered" | "shared" | "forwarded" | "own" | "failed" = "failed";
  if (isScreenEventId(id)) {
    const marked = await runMarkWronglyDropped(createAdminClient(), user.id, user.email, id);
    if (marked.ok) outcome = marked.outcome;
    else if (marked.code === "lookup_failed") console.error("markWronglyDropped (lookup):", marked.message);
    else if (marked.code === "mark_failed") console.error("markWronglyDropped:", marked.message);
  }
  revalidatePath("/app/settings");
  revalidatePath("/app/settings/dropped");
  redirect(`/app/settings/dropped?flagged=${outcome}`);
}

/**
 * 「外す」 on a remembered sender: its mail goes through the free rules again, and its marked rows
 * fall back to the 14-day rule like any dropped mail (they are removed once that old).
 */
export async function forgetSender(formData: FormData): Promise<void> {
  const user = await getUser();
  requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/dropped");
  const domain = String(formData.get("domain") ?? "");
  let ok = false;
  if (isRememberedSenderDomain(domain)) {
    try {
      const done = await runForgetSender(createAdminClient(), user.id, domain);
      ok = done.ok;
      if (!done.ok) console.error("forgetSender:", done.code);
    } catch {
      console.error("forgetSender: database unavailable");
    }
  }
  revalidatePath("/app/settings");
  revalidatePath("/app/settings/dropped");
  redirect(`/app/settings/dropped?unflagged=${ok ? "done" : "failed"}`);
}

/** Remove everything this user has (used to reset a demo account). */
export async function clearAllParcels(formData: FormData): Promise<void> {
  const user = await getUser();
  requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/demo");
  if (formData.get("confirm") !== "yes") redirect(settingsErrorPath("clear_confirm"));

  const failure = await runClearAllParcels(createAdminClient(), user.id);

  revalidatePath("/app", "layout");
  if (failure) {
    console.error("clearAllParcels:", failure);
    redirect(settingsErrorPath("clear_failed"));
  }
  redirect("/app/settings/demo?cleared=1");
}

/** Dismiss only the notice the person saw; a newer rejection stays visible. */
export async function dismissIntakeNotice(formData: FormData): Promise<void> {
  const user = await getUser();
  requireDisplayedUser(user, formData.get("expectedUserId"), "/app/settings/trouble");
  const at = String(formData.get("limited_at") ?? "");
  if (!isIntakeNoticeTimestamp(at)) redirect(settingsErrorPath("notice_confirm_failed"));
  let ok = false;
  try {
    const done = await runDismissIntakeNotice(createAdminClient(), user.id, at);
    ok = done.ok;
    if (!done.ok) console.error("dismissIntakeNotice:", done.code);
  } catch {
    console.error("dismissIntakeNotice: database unavailable");
  }
  if (!ok) redirect(settingsErrorPath("notice_confirm_failed"));
  revalidatePath("/app", "layout");
  redirect("/app/settings/trouble");
}
