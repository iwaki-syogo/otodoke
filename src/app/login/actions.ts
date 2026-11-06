"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/env";
import { loginCodeErrorCode, loginErrorPath, loginSendErrorCode, loginSentPath } from "@/lib/login-errors";
import { turnstileToken } from "@/lib/turnstile";
import { claimLoginMail, clientIp, releaseLoginMail } from "@/lib/login-mail-limit";
import { forgetLogin, readRememberedLogin, rememberLogin } from "@/lib/login-email-cookie";
import { isLoginAddress, normalizeLoginAddress, normalizeLoginCode } from "@/lib/login-form";
import { safeNextPath } from "@/lib/safe-next";

/** Supabase sends to one address at most this often (max_frequency = "1m0s" in config.toml). */
const SUPABASE_MAIL_INTERVAL_MS = 60_000;

/**
 * Send a magic link. The mail carries the link, which lands on /auth/confirm with a token_hash
 * (works in any browser), and the same token as a code, which the "sent" screen takes.
 */
export async function sendMagicLink(formData: FormData): Promise<void> {
  const email = normalizeLoginAddress(formData.get("email"));
  const next = String(formData.get("next") ?? "/app");
  // When a mail last went to this address from this browser (Supabase sends once a minute).
  const before = await readRememberedLogin();
  const lastSentAt = before?.email === email ? before.sentAt : undefined;
  // Whatever happens next, the field shows this address again (also one the check below refuses,
  // so a typo can be fixed in place), and the code form checks the code with it. In a cookie for
  // this browser, never in the URL.
  await rememberLogin({ email, sentAt: lastSentAt });
  if (!isLoginAddress(email)) {
    redirect(loginErrorPath("invalid_email", next));
  }
  let origin: string;
  try {
    origin = appUrl();
  } catch (error) {
    // Do not send a link that points somewhere the user cannot open (e.g. localhost on a preview).
    console.error("[login] app URL is not configured", error);
    redirect(loginErrorPath("not_configured", next));
  }

  let ip: string | null = null;
  try {
    ip = clientIp(await headers());
  } catch {
    // No request headers (not inside a request): only the per-address limits apply.
  }
  const claim = await claimLoginMail(email, ip);
  if (claim.verdict !== "ok") {
    console.warn("[login] login mail limited:", claim.verdict);
    redirect(loginErrorPath(claim.verdict, next));
  }

  // Supabase checks it with Cloudflare when CAPTCHA protection is on, and ignores it while it is
  // off. Absent (the check did not finish, script blocked) is sent as absent. Never logged.
  const captchaToken = turnstileToken(formData);
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${origin}/auth/confirm?next=${encodeURIComponent(next)}`,
      captchaToken,
    },
  });
  if (error) {
    // The message goes to the log only; the page shows fixed wording for the code.
    console.warn("[login] signInWithOtp failed:", error.status, error.code, error.message);
    // No mail went out, so this press does not count against the limit (never throws).
    await releaseLoginMail(email, claim.claimId);
    // A refused token and a missing one need different advice: this press sent one or it did not.
    const code = loginSendErrorCode(error, captchaToken !== undefined);
    // Refused within a minute of the last mail to this address: the wait is known.
    const recent = code === "busy" && lastSentAt !== undefined && Date.now() - lastSentAt < SUPABASE_MAIL_INTERVAL_MS;
    redirect(loginErrorPath(recent ? "busy_recent" : code, next));
  }
  await rememberLogin({ email, sentAt: Date.now() });
  redirect(loginSentPath(next));
}


/**
 * Sign in with the code from the mail (the same token as its link), on the page that asked for
 * it: a home-screen web app on iPhone keeps its own cookies apart from Safari, where the link
 * would open, and a mail read on another device signs that device in by the link.
 *
 * The address is the one this browser sent to (its cookie). No CAPTCHA: Supabase does not check
 * one on /verify; it limits verifications per IP instead (login-errors.ts, verifyFailure).
 */
export async function verifyLoginCode(formData: FormData): Promise<void> {
  const next = String(formData.get("next") ?? "/app");
  const email = (await readRememberedLogin())?.email ?? "";
  if (!isLoginAddress(email)) {
    redirect(loginErrorPath("code_no_address", next));
  }
  const code = normalizeLoginCode(formData.get("code"));
  if (!code) {
    redirect(loginSentPath(next, "code_format"));
  }

  let error: { status?: number; code?: string; message?: string } | null;
  try {
    const supabase = await createClient();
    ({ error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" }));
  } catch (thrown) {
    // Not an AuthError (supabase-js returns those): nothing says the code was refused.
    console.warn("[login] verifyOtp threw:", thrown instanceof Error ? thrown.message : String(thrown));
    redirect(loginSentPath(next, loginCodeErrorCode(null)));
  }
  if (error) {
    // Status and code only reach the page; the code itself and the address are never logged.
    console.warn("[login] verifyOtp failed:", error.status, error.code, error.message);
    redirect(loginSentPath(next, loginCodeErrorCode(error)));
  }
  // Signed in (the session cookies are set): the address has done its job.
  await forgetLogin();
  redirect(safeNextPath(next));
}
