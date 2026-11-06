"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/env";
import { loginErrorPath, loginSendErrorCode } from "@/lib/login-errors";
import { turnstileToken } from "@/lib/turnstile";
import { claimLoginMail, clientIp, releaseLoginMail } from "@/lib/login-mail-limit";
import { rememberLogin } from "@/lib/login-email-cookie";

/** Send a magic link. The link lands on /auth/confirm with a token_hash (works in any browser). */
export async function sendMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const next = String(formData.get("next") ?? "/app");
  // Whatever happens next, the field shows this address again (also one the check below refuses,
  // so a typo can be fixed in place). In a cookie for this browser, never in the URL.
  await rememberLogin({ email });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    redirect(loginErrorPath("invalid_email"));
  }
  let origin: string;
  try {
    origin = appUrl();
  } catch (error) {
    // Do not send a link that points somewhere the user cannot open (e.g. localhost on a preview).
    console.error("[login] app URL is not configured", error);
    redirect(loginErrorPath("not_configured"));
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
    redirect(loginErrorPath(claim.verdict));
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
    redirect(loginErrorPath(loginSendErrorCode(error, captchaToken !== undefined)));
  }
  redirect(`/login?sent=${encodeURIComponent(email)}`);
}
