import { redirect } from "next/navigation";
import type { SessionRead } from "@/lib/auth-session";
import { safeNextPath } from "@/lib/safe-next";

export const KEY_SETTINGS_PATH = "/app/settings/password";

/** Only app GET pages can be a recovery destination; never replay an old form or auth request. */
export function actionReturnPath(value: unknown): string {
  if (typeof value !== "string") return "/app";
  const safe = safeNextPath(value);
  const path = new URL(safe, "https://otodoke.invalid").pathname;
  return path === "/app" || path.startsWith("/app/") ? path : "/app";
}

export function accountChangedPath(returnTo: string, notice?: "logout"): string {
  return `/account-changed?next=${encodeURIComponent(actionReturnPath(returnTo))}${notice === "logout" ? "&notice=logout" : ""}`;
}

export function displayedUserMatches(user: { id: string } | null, expectedUserId: unknown): boolean {
  return Boolean(user && typeof expectedUserId === "string" && expectedUserId.length > 0 && expectedUserId === user.id);
}

/**
 * `user` must already have been checked by Supabase Auth on this request. expectedUserId only
 * identifies the account the person saw; it never selects an account or authorizes a write.
 * Missing fields from an old client need a fresh GET too, rather than acting on the new cookie.
 */
export function requireDisplayedUser<T extends { id: string }>(user: T | null, expectedUserId: unknown, returnTo: string): asserts user is T {
  if (!user) redirect("/login");
  if (!displayedUserMatches(user, expectedUserId)) {
    redirect(accountChangedPath(returnTo));
  }
}

/** The verified user of a SessionRead, or null when signed out. Stops at the account-check page when Auth could not be asked. */
export function sessionUserOrStop(read: SessionRead, returnTo: string): { id: string; email: string | null } | null {
  if (read.state === "unknown") redirect(accountChangedPath(returnTo));
  if (read.state === "signed_out") return null;
  return { id: read.session.userId, email: read.session.email };
}
