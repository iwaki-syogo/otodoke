import { z } from "zod";
import type { AdminClient } from "@/lib/supabase/admin";

export type SettingsMailActionResult = { ok: true } | { ok: false; code: "invalid_input" | "forget_failed" | "dismiss_failed" };

/** Old marks must remain removable, including shared domains no longer accepted for remembering. */
export function isRememberedSenderDomain(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 255;
}

const INTAKE_TIMESTAMP = z.iso.datetime({ offset: true }).refine((value) => {
  // PostgreSQL has no year zero and its numeric timezone offsets must be below 16 hours.
  const offsetHour = value.match(/[+-](\d{2}):\d{2}$/)?.[1];
  return !value.startsWith("0000-") && (offsetHour === undefined || Number(offsetHour) < 16);
});

/** Validate the wire value without rounding its fractional seconds or changing its timezone. */
export function isIntakeNoticeTimestamp(value: unknown): value is string {
  return INTAKE_TIMESTAMP.safeParse(value).success;
}

/** Both the Web Action and native API remove only this verified owner's existing marks. */
export async function runForgetSender(db: AdminClient, userId: string, domain: unknown): Promise<SettingsMailActionResult> {
  if (!isRememberedSenderDomain(domain)) return { ok: false, code: "invalid_input" };
  try {
    const { error } = await db.from("screen_events").update({ flagged_at: null }).eq("user_id", userId).eq("from_domain", domain).not("flagged_at", "is", null);
    return error ? { ok: false, code: "forget_failed" } : { ok: true };
  } catch {
    return { ok: false, code: "forget_failed" };
  }
}

/** A stale acknowledgement must not remove a newer notice, even a microsecond later. */
export async function runDismissIntakeNotice(db: AdminClient, userId: string, limitedAt: unknown): Promise<SettingsMailActionResult> {
  if (!isIntakeNoticeTimestamp(limitedAt)) return { ok: false, code: "invalid_input" };
  try {
    const { error } = await db.from("mail_intake_notices").delete().eq("user_id", userId).eq("limited_at", limitedAt);
    return error ? { ok: false, code: "dismiss_failed" } : { ok: true };
  } catch {
    return { ok: false, code: "dismiss_failed" };
  }
}
