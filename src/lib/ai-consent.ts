import type { AdminClient } from "@/lib/supabase/admin";

export type AiReadingConsent = "granted" | "declined" | "undecided" | "unknown";
export type ReadingPermission = "granted" | "not_granted" | "unknown";

/** A missing row is an unanswered choice; a failed read never stands in for that choice. */
export async function readAiReadingConsent(db: AdminClient, userId: string): Promise<AiReadingConsent> {
  try {
    const { data, error } = await db.from("ai_reading_consents").select("decision, decided_at, text_version").eq("user_id", userId).maybeSingle();
    if (error) return "unknown";
    if (!data) return "undecided";
    return data.decision === "granted" || data.decision === "declined" ? data.decision : "unknown";
  } catch {
    return "unknown";
  }
}

export async function readingAllowed(db: AdminClient, userId: string): Promise<ReadingPermission> {
  const consent = await readAiReadingConsent(db, userId);
  return consent === "granted" ? "granted" : consent === "unknown" ? "unknown" : "not_granted";
}

export class AiReadingNotAllowedError extends Error {
  constructor(readonly code: "ai_consent_required" | "ai_consent_unknown") {
    super(code);
    this.name = "AiReadingNotAllowedError";
  }
}

/**
 * Called after storing the mail, before either paid reading. Waiting mail stays in the existing
 * unread set and can be read in place after consent or recovery. Only the repository sample's
 * precomputed reading is exempt: it sends no mail to Claude.
 */
export async function requireAiReadingConsent(
  db: AdminClient,
  userId: string,
  emailId: string,
  options: { publicSample?: boolean; precomputed?: unknown } = {},
): Promise<void> {
  if (options.publicSample === true && options.precomputed !== undefined) return;
  const allowed = await readingAllowed(db, userId);
  if (allowed === "granted") return;
  const code = allowed === "unknown" ? "ai_consent_unknown" : "ai_consent_required";
  const { error } = await db.from("emails").update({ processing_status: "failed", error: code }).eq("id", emailId).eq("user_id", userId);
  if (error) throw new Error("could not retain mail awaiting reading permission");
  throw new AiReadingNotAllowedError(code);
}
