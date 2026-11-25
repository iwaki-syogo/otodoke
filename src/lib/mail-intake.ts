import type { AdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/db/database.types";

/**
 * The per-day intake allowance of Gmail's forwarding confirmation and of the screen_events row a screened-out mail
 * leaves (supabase/migrations/20261125100000_mail_intake_window.sql). A JST day, per user and across all users,
 * by count and by bytes. Far above what one person's own mail needs: a forwarding setup sends one confirmation,
 * and a person's own shops send a handful of ads a day.
 */
export const MAIL_INTAKE_LIMITS = {
  forwarding_confirmation: { user_count: 10, user_bytes: 4 * 1024 * 1024, global_count: 2_000, global_bytes: 256 * 1024 * 1024 },
  screen_event: { user_count: 300, user_bytes: 512 * 1024, global_count: 30_000, global_bytes: 64 * 1024 * 1024 },
} as const;

export type IntakeKind = keyof typeof MAIL_INTAKE_LIMITS;

/** "missing": the database does not have the function yet (or again, after its rollback); the caller goes on as before. */
export type IntakeVerdict = "ok" | "user_intake_limit" | "global_intake_limit" | "missing";

/** PostgREST's answer for a function it does not know (and Postgres's own, through a proxy). */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/**
 * Takes one from today's allowance of this kind. Throws when the database could not tell.
 * `deliveryKey` names the mail (its Message-ID, or the provider's ID when it has none): the same mail claimed again,
 * after a failure before it was stored or an answer that did not come back, keeps the place it took and is not counted
 * again. Null: counted every time.
 */
export async function claimMailIntake(db: AdminClient, userId: string, kind: IntakeKind, bytes: number, deliveryKey: string | null): Promise<IntakeVerdict> {
  const { data, error } = await db.rpc("claim_mail_intake", {
    p_user_id: userId, p_kind: kind, p_bytes: Math.max(0, Math.ceil(bytes)), p_limits: MAIL_INTAKE_LIMITS[kind] as unknown as Json,
    p_delivery_key: deliveryKey,
  });
  if (isMissingFunction(error)) return "missing";
  if (error) throw new Error(`mail intake claim failed: ${(error as { message?: string }).message ?? "unknown"}`);
  if (data === "ok" || data === "user_intake_limit" || data === "global_intake_limit") return data;
  throw new Error("mail intake claim returned an unexpected verdict");
}

export type ScreenEvent = {
  decision: "dropped" | "rescued";
  fromDomain: string | null;
  subject: string | null;
  reason: string;
  /** The mail's Message-ID, or the provider's ID when it has none: the same delivery is logged once. */
  deliveryKey: string | null;
};

export type ScreenLogVerdict = "logged" | "duplicate" | "user_intake_limit" | "global_intake_limit" | "missing";

/** Logs one screen decision once per delivery, within today's allowance. Throws when the database could not tell. */
export async function logScreenEventOnce(db: AdminClient, userId: string, event: ScreenEvent): Promise<ScreenLogVerdict> {
  const { data, error } = await db.rpc("log_screen_event", {
    p_user_id: userId,
    p_event: {
      decision: event.decision,
      from_domain: event.fromDomain,
      subject: event.decision === "dropped" ? event.subject?.slice(0, 200) ?? null : null,
      reason: event.reason,
      delivery_key: event.deliveryKey,
    } as unknown as Json,
    p_limits: MAIL_INTAKE_LIMITS.screen_event as unknown as Json,
  });
  if (isMissingFunction(error)) return "missing";
  if (error) throw new Error(`screen event log failed: ${(error as { message?: string }).message ?? "unknown"}`);
  if (data === "logged" || data === "duplicate" || data === "user_intake_limit" || data === "global_intake_limit") return data;
  throw new Error("screen event log returned an unexpected verdict");
}

/** UTF-8 bytes of what came in, for the bytes part of the allowance. */
export function incomingBytes(parts: Array<string | null | undefined>): number {
  return parts.reduce((n, part) => n + (part ? Buffer.byteLength(part, "utf8") : 0), 0);
}
