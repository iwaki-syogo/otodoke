import { KEY_IN_USE_CHANGED, KEY_INPUT_INVALID, KEY_WRAP_CHANGED } from "@/lib/crypto/key-messages";

/**
 * The result codes of the login, sign-up, reset and change steps, and the fixed words for each.
 *
 * An Action answers a code, never Supabase's text; the screens show the words from here. A code in
 * a URL (/login?error=…) is looked up the same way, so a crafted link cannot put its own text on a
 * page. Pure (no request, no Supabase): the screens import it too.
 *
 * The first six codes are the iOS app's categories, with the same words.
 */
export const LOGIN_MESSAGES = {
  // The categories shared with the iOS app.
  credentials: "メールアドレスかパスワードが違います。",
  not_confirmed: "メールアドレスの確認がまだです。届いたメールのリンクを開いてください。",
  rate: "回数が多いため、しばらく時間をおいてから、もう一度お試しください。",
  captcha: "確認が切れました。もう一度お試しください。",
  network: "つながりませんでした。少し時間をおいて、もう一度お試しください。",
  other: "うまくいきませんでした。もう一度お試しください。",

  // The address.
  invalid_email: "メールアドレスの形式を確認してください。",
  email_not_ascii: "半角の英数字と記号だけのメールアドレスをお使いください。",
  // The app cannot say where the mail's link should lead (its URL is not configured).
  not_configured: "いまは受け付けられません。少し時間をおいて、もう一度お試しください。",

  // What a sent mail says. The same words whether the address has an account or not.
  signup_exists_or_sent: "確認のメールを送りました。メールのリンクを開いてから、ログインしてください。",
  confirmation_sent: "確認のメールを送りました。",
  reset_sent: "再設定のメールを送りました。メールのリンクを開いてください。",
  // /login?confirmed=1, after the confirmation link.
  confirmed: "メールアドレスを確認しました。パスワードでログインしてください。",

  // The session.
  signed_out: "ログインし直してください。",
  // A key step the session may not take (auth-session.ts, key-actions.ts): putting a key in use
  // and rewrapping it need a sign-in with the password in the last 15 minutes; a reset link's
  // session of the last 15 minutes registers a key only. /reset-password says reset_expired
  // instead (password-flows.ts finishPasswordReset): that user cannot log in.
  stale_session: "続けるには、もう一度ログインしてください。",
  // finishReset without a reset link opened in the last 15 minutes.
  reset_expired: "再設定の期限が切れました。もう一度、再設定のメールを送ってください。",

  // Changing the password.
  same_secret: "いまと同じパスワードです。別のパスワードを決めてください。",
  // Supabase did not answer whether the new password was set; the key opens with the new one.
  // The new one first; if it was not set after all, the old one signs in, and a key that opens
  // with the new one is then opened with 「ほかのパスワードで開く」 (R3-PW-15).
  secret_change_unknown: "パスワードを変えられたか確かめられませんでした。新しいパスワードでログインし直してください。入れないときは、前のパスワードでログインしてください。",
  // Supabase refused the new password; the key opens with the old one again.
  secret_change_refused: "パスワードを変えられませんでした。もう一度お試しください。",
  // The same, but the wrap could not be put back: the login is the old password, and the key opens
  // with the new one, or with another tab's password when that tab wrapped it again meanwhile. The
  // same change again brings both to the new password (changePassword opens with the new one too).
  secret_change_refused_key_new: "パスワードを変えられませんでした。同じ新しいパスワードで、もう一度お試しください。",

  // The key steps (src/lib/mail-keys.ts).
  key_in_use_changed: "ほかの画面で鍵が変わりました。ページを読み込み直してください。",
  key_wrap_changed: "ほかの画面でパスワードが変わりました。ページを読み込み直してください。",
  key_not_pending: "もう一度、最初からお試しください。",
  key_not_in_use: "ページを読み込み直してください。",
  key_challenge_failed: "鍵を確かめられませんでした。もう一度お試しください。",
  key_failed: "保存できませんでした。もう一度お試しください。",
  invalid_input: "うまくいきませんでした。ページを読み込み直してください。",

  // What the browser finds itself, without the server's answer (src/lib/crypto/password-flows.ts).
  // The key in use does not open with the password given (opening it again in a tab).
  wrong_password: "パスワードが違います。",
  // A change: the key opens with neither password given, or Supabase refused the current one.
  wrong_current_password: "今のパスワードが違います。",
  // There is no key in use to open.
  no_key: "メールの鍵がまだありません。設定で作れます。",
  // The address typed at the sign-in and the session's are not the same for password-v1 (letters
  // outside ASCII): no first key is made, since every later step would make another master.
  address_mismatch: "このアカウントでは、メールの鍵を作れませんでした。",
  // A sign-in that went through, with a password that does not open the key in use (a key made
  // before password-v1, or a change that stopped half-way: the key opens with its new password).
  key_not_opened: "このパスワードでは、メールの鍵を開けませんでした。",
  // 「ほかのパスワードで開く」 after that, with a password that does not open it either.
  other_password_wrong: "このパスワードでも、メールの鍵を開けませんでした。",

  // The mail's links (/auth/confirm).
  link_invalid: "このリンクは使えませんでした。確認が済んでいれば、ログインできます。",
  reset_link_invalid: "再設定のリンクは使えませんでした。もう一度、再設定のメールを送ってください。",
  // Supabase's limit on verifications (429, per IP, before the token is looked at), or the app's own
  // before Supabase is asked (login-mail-limit.ts LOGIN_LINK_LIMITS: 10 checks per IP in any 10
  // minutes, which can mean a wait of up to 10 minutes). Either way the link still works later.
  link_limited: "ただいま混み合っています。少し時間をおいてから、もう一度メールのリンクを開いてください。",
  // Supabase did not answer, or answered 5xx: nothing says the token was refused.
  link_failed: "いまは確認できませんでした。少し時間をおいて、もう一度メールのリンクを開いてください。",
  link_incomplete: "リンクが不完全です。いちばん新しいメールのリンクを開いてください。",
} as const;

export type LoginCode = keyof typeof LOGIN_MESSAGES;

/** The categories the iOS app has too. */
export type CommonFailure = "credentials" | "not_confirmed" | "rate" | "captcha" | "network" | "other";

export type SignInFailure = CommonFailure | "invalid_email";
export type SignInResult = { ok: true; userId: string } | { ok: false; code: SignInFailure };

export type SignUpFailure = "invalid_email" | "email_not_ascii" | "not_configured" | "rate" | "captcha" | "network" | "other";
export type SignUpResult = { ok: true; code: "signup_exists_or_sent" } | { ok: false; code: SignUpFailure };

export type MailRequestFailure = "invalid_email" | "not_configured" | "rate" | "captcha" | "network" | "other";
export type ResendResult = { ok: true; code: "confirmation_sent" } | { ok: false; code: MailRequestFailure };
export type ResetMailResult = { ok: true; code: "reset_sent" } | { ok: false; code: MailRequestFailure };

/** What a key step of src/lib/mail-keys.ts can come to, as a code (keyStepCode maps them). */
export type KeyStepFailure = "key_in_use_changed" | "key_wrap_changed" | "key_not_pending" | "key_not_in_use" | "key_challenge_failed" | "key_failed" | "invalid_input";

/**
 * The code for the `error` text a key step of src/lib/mail-keys.ts answered. Those texts are the
 * shared constants of key-messages.ts and the fixed sentences of mail-keys.ts; a database or
 * unexpected error is key_failed (its text is not passed on).
 */
export function keyStepCode(error: string): KeyStepFailure {
  if (error === KEY_IN_USE_CHANGED) return "key_in_use_changed";
  if (error === KEY_WRAP_CHANGED) return "key_wrap_changed";
  // A value of the wrong form, a rewrap to the wrap it replaces, a key registered already: the
  // app's mistake, which sending it again does not mend.
  if (error === KEY_INPUT_INVALID) return "invalid_input";
  // activateKey's own check, and activate_user_key_checked's P0002 (passed on in its message).
  if (error === "no key is waiting to be activated" || error.includes("no matching key is waiting to be activated")) return "key_not_pending";
  if (error === "the key did not open its challenge") return "key_challenge_failed";
  if (error === "no key in use with this id") return "key_not_in_use";
  // restoreKeyWrap's refusal to put back the wrap stored now.
  if (error === "the wrap to put back is the one stored now") return "invalid_input";
  return "key_failed";
}

export type FinishResetFailure = "signed_out" | "reset_expired" | "rate" | "network" | "other" | "secret_change_unknown" | KeyStepFailure;
export type FinishResetResult = { ok: true; keyId: string } | { ok: false; code: FinishResetFailure };

export type ChangeSecretFailure =
  | "signed_out"
  | "credentials"
  | "rate"
  | "captcha"
  | "network"
  | "other"
  | "same_secret"
  | "secret_change_unknown"
  | "secret_change_refused"
  | "secret_change_refused_key_new"
  | KeyStepFailure;
export type ChangeSecretResult = { ok: true } | { ok: false; code: ChangeSecretFailure };

/**
 * The `error` a key Action (key-actions.ts) answers for a session that may not take the step:
 * putting a key in use and rewrapping it need a sign-in with the password in the last 15 minutes;
 * registering one takes a reset link's session of the last 15 minutes too (src/lib/auth-session.ts).
 * The screens ask to log in again (LOGIN_MESSAGES.stale_session); /reset-password, whose user has
 * no password to log in with, asks for a new reset mail (reset_expired).
 */
export const KEY_SESSION_STALE = "stale_session";

/** Shown for a code this version does not know (an old link, or one somebody typed). */
export const UNKNOWN_LOGIN_ERROR = "ログインできませんでした。もう一度お試しください。";

/** The words for a code; the unknown-code words for anything else (never the text itself). */
export function loginMessage(code: string): string {
  return Object.hasOwn(LOGIN_MESSAGES, code) ? LOGIN_MESSAGES[code as LoginCode] : UNKNOWN_LOGIN_ERROR;
}

/** The message for /login?error=<code>; null when there is no error to show. */
export function loginErrorMessage(code: string | undefined): string | null {
  return code ? loginMessage(code) : null;
}

/** The held login button, while the bot check shows its checkbox and waits for the tick. */
export const TURNSTILE_TICK_PROMPT = "確認のチェックを押してください";

/**
 * The button after key_not_opened that asks for a password that opened the key before: opened with
 * it, the key is wrapped again for the password that signed in (password-flows.ts openWithAnother).
 */
export const OPEN_WITH_ANOTHER_PASSWORD = "ほかのパスワードで開く";

/** Shown in the bot check's place when its script cannot load (blocked, offline, Cloudflare down). */
export const TURNSTILE_UNAVAILABLE_MESSAGE = "確認を読み込めませんでした。ページを読み込み直すか、別のブラウザでお試しください。";

/** Where /auth/confirm sends a reset link it accepted: a constant, never the link's next. */
export const RESET_PATH = "/reset-password";

/** Where /auth/confirm sends a confirmation link it accepted: the login, to sign in with the password. */
export const CONFIRMED_PATH = "/login?confirmed=1";

/** /login with an error code (the words come from LOGIN_MESSAGES). */
export function loginErrorPath(code: LoginCode): string {
  return `/login?error=${encodeURIComponent(code)}`;
}

/** An error Supabase Auth answered with: only its status and code are read, never the English text. */
export type AuthFailure = { status?: number; code?: string } | null;

/**
 * Why Supabase did not accept a token (verifyOtp), by status only:
 * - `limited`: 429 (over_request_rate_limit). Supabase Auth limits /verify per IP before it reads
 *   the token, so the same link still works later. The IP Supabase sees is this server's.
 * - `failed`: no answer (status 0), 5xx or Cloudflare's 52x (AuthRetryableFetchError), or an
 *   answer that was not Supabase's (AuthUnknownError, no status): try again later.
 * - `invalid`: every other answer (403 otp_expired for a wrong, expired, used or replaced token;
 *   400/422 for one that cannot be one).
 */
export function verifyFailure(error: { status?: number; code?: string }): "invalid" | "limited" | "failed" {
  if (error.status === 429 || error.code === "over_request_rate_limit") return "limited";
  if (!error.status || error.status >= 500) return "failed";
  return "invalid";
}

/** The code for a mail's link /auth/confirm could not verify (`null`: verifyOtp threw). */
export function linkFailureCode(error: AuthFailure, kind: "confirm" | "reset"): LoginCode {
  if (!error) return "link_failed";
  const reason = verifyFailure(error);
  if (reason === "limited") return "link_limited";
  if (reason === "failed") return "link_failed";
  return kind === "reset" ? "reset_link_invalid" : "link_invalid";
}

/** No answer or not Supabase's: nothing says the request was refused (verifyFailure's `failed`). */
export function isOutage(error: { status?: number; code?: string }): boolean {
  return !error.status || error.status >= 500;
}

/**
 * The code for a refused sign-in with the login secret (signInWithPassword), by Supabase's code and
 * status. `invalid_credentials` is the same for an unknown address and a wrong secret.
 */
export function signInFailureCode(error: { status?: number; code?: string }): CommonFailure {
  if (error.code === "invalid_credentials") return "credentials";
  if (error.code === "email_not_confirmed") return "not_confirmed";
  if (error.code === "captcha_failed") return "captcha";
  if (error.status === 429 || error.code === "over_request_rate_limit") return "rate";
  if (isOutage(error)) return "network";
  return "other";
}
