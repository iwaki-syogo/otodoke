import type { LoginCode } from "@/lib/login-errors";

/**
 * What /signup's waiting screen hands to /login when it stops waiting (the sign-in was refused
 * with `credentials`: an account with another password has the address): the address to fill in
 * and the code whose words to show. Never the password.
 *
 * Kept in this module's memory, which a move inside the tab (the router) keeps and a reload or a new
 * tab does not: nothing goes into the URL, a cookie or storage. One shot: /login reads it when it
 * is drawn and lets it go once shown.
 *
 * Only the browser writes it (from a press or a tab shown again); on the server it stays empty.
 */
export type LoginHandoff = { email: string; code: LoginCode | typeof EXISTING_ACCOUNT };

/**
 * The reason for a refusal that came right after a sign-up: `credentials` there means the address
 * already has an account (Supabase answers a repeated sign-up as a success, with no mail and the
 * new one dropped). /login says so in its own words (EXISTING_ACCOUNT_NOTICE).
 */
export const EXISTING_ACCOUNT = "existing_account";

let handoff: LoginHandoff | null = null;

/** For /login to take on its next drawing in this tab. */
export function handOffToLogin(next: LoginHandoff): void {
  if (typeof window === "undefined") return;
  handoff = { email: next.email, code: next.code };
}

/** What was handed over, if anything. Reading it changes nothing (a drawing may run twice). */
export function peekLoginHandoff(): LoginHandoff | null {
  return handoff;
}

/** Lets it go: shown once, it does not come back on the next visit to /login. */
export function clearLoginHandoff(): void {
  handoff = null;
}
