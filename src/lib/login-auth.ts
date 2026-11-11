/**
 * The login, sign-up, reset and change steps, server side. The Server Actions
 * (src/app/login/actions.ts, src/app/reset-password/actions.ts,
 * src/app/app/settings/password-actions.ts) only call these.
 *
 * What reaches here is a login secret of password-v1, never the password: the browser derives it
 * (docs/crypto/password-v1.md) and the input schemas (login-input.ts) take nothing else. Supabase
 * Auth keeps the login secret as the account's password.
 *
 * Every answer is a result code (login-errors.ts); Supabase's text only goes to the log, with its
 * status and code, never with the address or a secret.
 */
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { readCookieSession, isFresh, throwawayAuthClient, type ServerClient } from "@/lib/auth-session";
import { appUrl } from "@/lib/env";
import {
  isOutage,
  keyStepCode,
  signInFailureCode,
  type ChangeSecretResult,
  type FinishResetResult,
  type MailRequestFailure,
  type ResendResult,
  type ResetMailResult,
  type SignInResult,
  type SignUpResult,
} from "@/lib/login-errors";
import { isAsciiAddress, isLoginAddress, normalizeLoginAddress } from "@/lib/login-form";
import { ChangeSecretInputSchema, FinishResetInputSchema, MailRequestInputSchema, SignInInputSchema, SignUpInputSchema } from "@/lib/login-input";
import { claimLoginAttempt, claimLoginMail, claimLoginTry, clientIp, releaseLoginAttempt, releaseLoginMail } from "@/lib/login-mail-limit";
import { scheduleSealRemaining } from "@/lib/seal-later";
import { activateKey, readStoredKey, rewrapKey, type KeyRestore, type KeyResult } from "@/lib/mail-keys";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { TURNSTILE_TOKEN_MAX_LENGTH } from "@/lib/turnstile";
import { checkResetKey } from "@/lib/crypto/reset-key-check";

/** The path a confirmation or reset mail leads to; /auth/confirm decides by the link's type. */
const CONFIRM_LANDING = "/auth/confirm?next=%2Fapp";

/** The visitor's IP for the app's own limits; null outside a request or without one. */
async function requestIp(): Promise<string | null> {
  try {
    return clientIp(await headers());
  } catch {
    return null;
  }
}

/** The Turnstile token to pass on; undefined when there is none (Supabase decides, as before). */
function captchaOf(token: string | null | undefined): string | undefined {
  const value = token?.trim();
  return value && value.length <= TURNSTILE_TOKEN_MAX_LENGTH ? value : undefined;
}

/** Where a mail's link leads; null when this deployment does not know its own URL. */
function landing(): string | null {
  try {
    return `${appUrl()}${CONFIRM_LANDING}`;
  } catch (error) {
    console.error("[login] app URL is not configured:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

type AuthError = { status?: number; code?: string; name?: string };

function logRefusal(step: string, error: AuthError): void {
  // Status and code only: Supabase's text can name the address.
  console.warn(`[login] ${step} refused:`, error.status ?? 0, error.code ?? error.name ?? "unknown");
}

function logThrown(step: string, thrown: unknown): void {
  console.warn(`[login] ${step} threw:`, thrown instanceof Error ? thrown.name : typeof thrown);
}

/**
 * The app's own limits before a sign-in with the login secret: every sign-in from this IP
 * (LOGIN_TRY_LIMITS, never given back), then the failures for this address (LOGIN_ATTEMPT_LIMITS,
 * kept for wrong credentials or pending confirmation). Null when either says no.
 */
async function claimSignIn(email: string): Promise<{ claimId: number | null } | null> {
  const ip = await requestIp();
  const tries = await claimLoginTry(ip);
  if (tries !== "ok") {
    console.warn("[login] sign-in limited:", `try_${tries}`);
    return null;
  }
  const attempt = await claimLoginAttempt(email, ip);
  if (attempt.verdict !== "ok") {
    console.warn("[login] sign-in limited:", attempt.verdict);
    return null;
  }
  return { claimId: attempt.claimId };
}

/**
 * Sign in with the login secret, on this browser's cookies. Wrong credentials and a pending
 * confirmation share one response and consume the same allowance. No redirect: the browser
 * opens the key next, with the userId.
 */
export async function signIn(input: unknown): Promise<SignInResult> {
  const parsed = SignInInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "other" };
  const email = normalizeLoginAddress(parsed.data.email);
  if (!isLoginAddress(email)) return { ok: false, code: "invalid_email" };

  const attempt = await claimSignIn(email);
  if (!attempt) return { ok: false, code: "rate" };
  let answer: Awaited<ReturnType<ServerClient["auth"]["signInWithPassword"]>>;
  try {
    const supabase = await createClient();
    answer = await supabase.auth.signInWithPassword({ email, password: parsed.data.authSecret, options: { captchaToken: captchaOf(parsed.data.captchaToken) } });
  } catch (thrown) {
    logThrown("sign-in", thrown);
    await releaseLoginAttempt(email, attempt.claimId);
    return { ok: false, code: "network" };
  }
  const { data, error } = answer;
  if (error) {
    logRefusal("sign-in", error);
    const failure = signInFailureCode(error);
    const code = failure === "not_confirmed" ? "credentials" : failure;
    if (code !== "credentials") await releaseLoginAttempt(email, attempt.claimId);
    return { ok: false, code };
  }
  await releaseLoginAttempt(email, attempt.claimId);
  return data.user?.id ? { ok: true, userId: data.user.id } : { ok: false, code: "other" };
}

/**
 * What a refused mail request says. The answers that depend on whether the address has an account
 * (it exists already; a mail went to it within the minute) say "sent", like a mail that went out.
 */
function mailRefusal(error: AuthError): MailRequestFailure | "sent" {
  if (error.code === "captcha_failed") return "captcha";
  // Supabase's per-IP limit: the same for every address.
  if (error.code === "over_request_rate_limit") return "rate";
  if (error.code === "email_address_invalid" || error.code === "validation_failed") return "invalid_email";
  if (["user_already_exists", "email_exists", "user_not_found", "over_email_send_rate_limit"].includes(error.code ?? "") || error.status === 429) return "sent";
  if (isOutage(error)) return "network";
  return "other";
}

type MailSend = (client: ReturnType<typeof throwawayAuthClient>, email: string, redirectTo: string, captchaToken: string | undefined) => Promise<{ error: AuthError | null; accessToken?: string }>;

/**
 * A mail Supabase sends to an address (confirmation, again, reset), through a client that keeps no
 * session: this browser's cookies are not touched. Counted against the app's mail limit; given
 * back for failures, except hidden sign-up outcomes which keep the same claim as a sent mail.
 */
async function requestMail(step: string, input: unknown, send: MailSend, asciiOnly: boolean): Promise<{ ok: true } | { ok: false; code: MailRequestFailure | "email_not_ascii" }> {
  const email = normalizeLoginAddress((input as { email?: unknown } | null)?.email);
  if (!isLoginAddress(email)) return { ok: false, code: "invalid_email" };
  if (asciiOnly && !isAsciiAddress(email)) return { ok: false, code: "email_not_ascii" };
  const redirectTo = landing();
  if (!redirectTo) return { ok: false, code: "not_configured" };

  const claim = await claimLoginMail(email, await requestIp());
  if (claim.verdict !== "ok") {
    console.warn(`[login] ${step} mail limited:`, claim.verdict);
    return { ok: false, code: "rate" };
  }
  const client = throwawayAuthClient();
  let result: Awaited<ReturnType<MailSend>>;
  try {
    result = await send(client, email, redirectTo, captchaOf((input as { captchaToken?: string | null }).captchaToken));
  } catch (thrown) {
    logThrown(step, thrown);
    await releaseLoginMail(email, claim.claimId);
    return { ok: false, code: "network" };
  }
  if (result.accessToken) {
    // Supabase signed the throwaway client in (confirmations turned off): that session is not kept.
    const { error } = await client.auth.admin.signOut(result.accessToken, "local");
    if (error) logRefusal(`${step} (ending the session it made)`, error);
  }
  if (result.error && result.error.code === "user_already_exists" && step === "sign-up") {
    // An address-dependent sign-up outcome has the same response and allowance as a sent mail.
    return { ok: true };
  }
  if (result.error) {
    logRefusal(step, result.error);
    const code = mailRefusal(result.error);
    // Hidden sign-up outcomes consume the same app allowance as a new account.
    if (step !== "sign-up" || code !== "sent") await releaseLoginMail(email, claim.claimId);
    return code === "sent" ? { ok: true } : { ok: false, code };
  }
  return { ok: true };
}

/**
 * Make an account: the address and the login secret. Supabase mails the confirmation link for a new
 * or still-unconfirmed address. A confirmed address can receive no mail from Supabase; its app
 * response is identical so the address's registration is not disclosed by the sign-up Action.
 */
export async function signUp(input: unknown): Promise<SignUpResult> {
  const parsed = SignUpInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "other" };
  const result = await requestMail(
    "sign-up",
    parsed.data,
    async (client, email, redirectTo, captchaToken) => {
      const { data, error } = await client.auth.signUp({ email, password: parsed.data.authSecret, options: { emailRedirectTo: redirectTo, captchaToken } });
      return { error, accessToken: data.session?.access_token };
    },
    true,
  );
  if (!result.ok) return result;
  return { ok: true, code: "signup_exists_or_sent" };
}

/** The confirmation mail again. The same answer for every address. */
export async function resendSignupMail(input: unknown): Promise<ResendResult> {
  const parsed = MailRequestInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "other" };
  const result = await requestMail(
    "resend",
    parsed.data,
    async (client, email, redirectTo, captchaToken) => {
      const { error } = await client.auth.resend({ type: "signup", email, options: { emailRedirectTo: redirectTo, captchaToken } });
      return { error };
    },
    false,
  );
  if (result.ok) return { ok: true, code: "confirmation_sent" };
  return { ok: false, code: result.code === "email_not_ascii" ? "invalid_email" : result.code };
}

/** The reset mail. The same answer for every address. */
export async function requestResetMail(input: unknown): Promise<ResetMailResult> {
  const parsed = MailRequestInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "other" };
  const result = await requestMail(
    "reset",
    parsed.data,
    async (client, email, redirectTo, captchaToken) => {
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo, captchaToken });
      return { error };
    },
    false,
  );
  if (result.ok) return { ok: true, code: "reset_sent" };
  return { ok: false, code: result.code === "email_not_ascii" ? "invalid_email" : result.code };
}

/**
 * Set the login secret of the signed-in user (updateUser). Supabase signs out every other session
 * of the user when it changes.
 * - `set`, or `same`: it is that one already (a retry after an answer that was lost).
 * - `unknown`: no answer, or a 5xx: it may or may not have been set.
 * - `signed_out`, `rate`, `refused`: it was not set.
 */
async function setLoginSecret(supabase: ServerClient, authSecret: string): Promise<"set" | "same" | "unknown" | "signed_out" | "rate" | "refused"> {
  let error: AuthError | null;
  try {
    ({ error } = await supabase.auth.updateUser({ password: authSecret }));
  } catch (thrown) {
    logThrown("setting the login secret", thrown);
    return "unknown";
  }
  if (!error) return "set";
  logRefusal("setting the login secret", error);
  if (error.code === "same_password") return "same";
  if (isOutage(error)) return "unknown";
  if (error.status === 429 || error.code === "over_request_rate_limit") return "rate";
  if (error.name === "AuthSessionMissingError" || error.code === "session_not_found" || error.code === "bad_jwt" || error.status === 401) return "signed_out";
  return "refused";
}

/**
 * The end of a reset (/reset-password): verify the screen owner and the pending key first, then
 * the new login secret, then the key the browser made
 * for it is put in use (the old key is retired under the same lock: activate_user_key_checked).
 * Only on a session from a reset link of the last 15 minutes (auth-session.ts).
 *
 * When only the activation fails, its code is answered and calling this again is safe: the secret
 * is the new one already (Supabase answers same_password, read as set) and the pending key waits.
 */
export async function finishReset(input: unknown): Promise<FinishResetResult> {
  const parsed = FinishResetInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  const { authSecret, keyId, challenge, expectedCurrentKeyId, expectedUserId, expectedEmailNorm } = parsed.data;
  const supabase = await createClient();
  const read = await readCookieSession(supabase);
  if (read.state === "unknown") return { ok: false, code: "network" };
  if (read.state === "signed_out") return { ok: false, code: "signed_out" };
  // These are equality conditions only: the authenticated session remains the owner of every query.
  if (read.session.userId !== expectedUserId || !read.session.email || normalizeLoginAddress(read.session.email) !== expectedEmailNorm) return { ok: false, code: "signed_out" };
  if (!isFresh(read.session.amr, "reset")) return { ok: false, code: "reset_expired" };

  const db = createAdminClient();
  const checked = await checkResetKey(db, read.session.userId, { keyId, challenge, expectedCurrentKeyId });
  if (!checked.ok) return { ok: false, code: keyStepCode(checked.error) };

  const set = await setLoginSecret(supabase, authSecret);
  if (set === "unknown") return { ok: false, code: "secret_change_unknown" };
  if (set === "signed_out" || set === "rate") return { ok: false, code: set };
  if (set === "refused") return { ok: false, code: "other" };

  const activated = await activateKey(db, read.session.userId, { keyId, challenge, expectedCurrentKeyId });
  revalidatePath("/app", "layout");
  if (!activated.ok) {
    const code = keyStepCode(activated.error);
    console.warn("[login] reset: the new key was not put in use:", code);
    return { ok: false, code };
  }
  scheduleSealRemaining(read.session.userId);
  return { ok: true, keyId: activated.keyId };
}

/**
 * Putting back the wrap from before a rewrap: restoreKeyWrap of src/lib/mail-keys.ts, which the
 * Action (password-actions.ts) passes in. It answers ok also when that wrap is back already.
 */
export type RestoreKeyWrap = (db: AdminClient, userId: string, input: KeyRestore) => Promise<KeyResult<{ keyId: string }>>;

/**
 * Change the password while the current one is known (設定). In this order, in this one call:
 *   1. the current login secret, by signing in with it on this browser (counted like a sign-in);
 *   2. the key in use, wrapped for the new password, stored only over the wrap the browser opened
 *      (or, with no rewrap, a check that no key is in use: it would no longer open);
 *   3. the new login secret;
 *   4. when Supabase refused it, the wrap from 2 is put back (restoreWrap), so the key opens with
 *      the password that still signs in. When Supabase's answer is unknown nothing is put back:
 *      the key opens with the new password, which may be the one that signs in (secret_change_unknown).
 */
export async function changeSecret(input: unknown, restoreWrap: RestoreKeyWrap): Promise<ChangeSecretResult> {
  const parsed = ChangeSecretInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "invalid_input" };
  const { currentAuthSecret, newAuthSecret, rewrap, captchaToken } = parsed.data;
  if (currentAuthSecret === newAuthSecret) return { ok: false, code: "same_secret" };

  const supabase = await createClient();
  const read = await readCookieSession(supabase);
  if (read.state === "unknown") return { ok: false, code: "network" };
  if (read.state === "signed_out" || !read.session.email) return { ok: false, code: "signed_out" };
  const { userId } = read.session;
  const email = normalizeLoginAddress(read.session.email);

  // 1. The current login secret.
  const attempt = await claimSignIn(email);
  if (!attempt) return { ok: false, code: "rate" };
  let signedIn: Awaited<ReturnType<ServerClient["auth"]["signInWithPassword"]>>;
  try {
    signedIn = await supabase.auth.signInWithPassword({ email, password: currentAuthSecret, options: { captchaToken: captchaOf(captchaToken) } });
  } catch (thrown) {
    logThrown("change: sign-in", thrown);
    await releaseLoginAttempt(email, attempt.claimId);
    return { ok: false, code: "network" };
  }
  if (signedIn.error) {
    logRefusal("change: sign-in", signedIn.error);
    const code = signInFailureCode(signedIn.error);
    if (code !== "credentials") await releaseLoginAttempt(email, attempt.claimId);
    return { ok: false, code: code === "not_confirmed" ? "other" : code };
  }
  await releaseLoginAttempt(email, attempt.claimId);
  if (signedIn.data.user?.id !== userId) return { ok: false, code: "other" };

  // 2. The key in use, for the new password.
  const db = createAdminClient();
  const stored = await readStoredKey(db, userId, { keyId: null });
  if (!stored.ok) return { ok: false, code: "key_failed" };
  let restore: KeyRestore | null = null;
  if (rewrap) {
    if (!stored.key || stored.key.key_id !== rewrap.keyId) return { ok: false, code: "key_not_in_use" };
    if (stored.key.wrapped_private_key !== rewrap.previousWrappedPrivateKey) return { ok: false, code: "key_wrap_changed" };
    const rewrapped = await rewrapKey(db, userId, rewrap);
    if (!rewrapped.ok) return { ok: false, code: keyStepCode(rewrapped.error) };
    restore = {
      keyId: rewrap.keyId,
      rewrappedPrivateKey: rewrap.wrappedPrivateKey,
      wrappedPrivateKey: stored.key.wrapped_private_key,
      wrapIv: stored.key.wrap_iv,
      kdfSalt: stored.key.kdf_salt,
      kdfIterations: stored.key.kdf_iterations,
    };
  } else if (stored.key) {
    return { ok: false, code: "key_in_use_changed" };
  }

  // 3. The new login secret.
  const set = await setLoginSecret(supabase, newAuthSecret);
  if (set === "set" || set === "same") return { ok: true };
  if (set === "unknown") return { ok: false, code: "secret_change_unknown" };

  // 4. Refused: the key goes back to the wrap of the password that still signs in.
  if (restore) {
    const back = await restoreWrap(db, userId, restore);
    if (!back.ok) {
      console.error("[login] change: the wrap could not be put back:", keyStepCode(back.error));
      return { ok: false, code: "secret_change_refused_key_new" };
    }
  }
  return { ok: false, code: "secret_change_refused" };
}
