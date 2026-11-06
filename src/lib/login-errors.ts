import { safeNextPath } from "./safe-next";

/**
 * What /login?error=<code> may say. The query carries only a code; the words come from here,
 * so a crafted link cannot put its own text on the login page.
 */
export const LOGIN_ERROR_MESSAGES = {
  invalid_email: "メールアドレスの形式を確認してください",
  not_configured: "ログインの設定に問題があり、メールを送れませんでした",
  send_failed: "メールを送れませんでした。少し時間をおいて、もう一度お試しください。",
  // Supabase refused to send (one address once a minute, or the project's hourly allowance).
  busy: "いまはリンクを送れませんでした。少し時間をおいて、もう一度お試しください。",
  // Supabase's CAPTCHA wanted a Turnstile token and the press had none: the check did not finish
  // (script blocked, host not allowed, not solved within the button's wait).
  captcha_missing: "確認が終わりませんでした。ページを読み込み直すか、別のブラウザでお試しください。",
  // Supabase's CAPTCHA refused the token the press sent (expired, already used or invalid). The
  // form comes back with a new check, so sending again works.
  captcha_refused: "確認が切れました。もう一度リンクを送ってください。",
  // The code used before missing and refused were told apart. No longer sent; kept for old links.
  captcha: "確認が切れました。もう一度お試しください。",
  // The app's own limits (src/lib/login-mail-limit.ts).
  email_10m:
    "このメールアドレスには続けてリンクを送りました。10分ほど待ってから、もう一度お試しください。届いたメールが迷惑メールに入っていないかも見てください。",
  email_1h: "このメールアドレスにはリンクを何度も送りました。1時間ほど待ってから、もう一度お試しください。",
  ip_1h: "この接続からのリンクの送信が続いたため、しばらく止めています。1時間ほど待ってから、もう一度お試しください。",
  // The link was not accepted: Supabase refused its token (wrong, expired, used, or an older mail
  // whose token a newer one replaced), or /auth/confirm refused a POST from another site (then the
  // token was not used at all). The words fit every one of them.
  link_invalid: "リンクを確認できませんでした。いちばん新しいメールのリンクを開くか、もう一度リンクを送ってください。",
  // Supabase's limit on verifications (429, per IP, before the token is looked at: the link still
  // works). Its bucket refills within a minute (see verifyFailure).
  link_limited: "ただいま混み合っています。1分ほど待ってから、もう一度メールのリンクを開いてください。",
  // Supabase did not answer, or answered 5xx: nothing says the token was refused.
  link_failed: "いまはログインできませんでした。少し時間をおいて、もう一度メールのリンクを開いてください。",
  link_incomplete: "リンクが不完全です。もう一度リンクを送ってください。",
  // The code typed on the "sent" screen (verifyLoginCode). Not 6 to 10 digits once full-width
  // digits, spaces and dashes are read: Supabase is not asked.
  code_format: "コードを確かめて、もう一度入力してください。",
  // Supabase refused it: wrong, expired, used, or from an older mail (a new send replaces it).
  code_invalid: "コードが違うか、期限が切れています。いちばん新しいメールのコードを入力してください。",
  // The same limit and outages as the link (verifyFailure). The code still works after the wait.
  code_limited: "ただいま混み合っています。1分ほど待ってから、もう一度お試しください。",
  code_failed: "いまはログインできませんでした。少し時間をおいて、もう一度お試しください。",
  // This browser no longer knows the address the code went to (the cookie is an hour old or
  // gone), and Supabase needs the address with the code.
  code_no_address: "もう一度リンクを送ってから、届いたメールのコードを入力してください。",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

/** Shown for a code this version does not know (an old link, or one somebody typed). */
export const UNKNOWN_LOGIN_ERROR = "ログインできませんでした。もう一度リンクを送ってください。";

/** Shown in the bot check's place when its script cannot load (blocked, offline, Cloudflare down). */
export const TURNSTILE_UNAVAILABLE_MESSAGE = "確認を読み込めませんでした。ページを読み込み直すか、別のブラウザでお試しください。";

/**
 * /login with the given state. `next` (where to go after signing in) is carried only when it is a
 * path on this site other than the default, so a refused send or code does not lose it. The
 * address is never put in the URL (see login-email-cookie.ts).
 */
function loginPath(params: { sent?: boolean; error?: LoginErrorCode; next?: string | null }): string {
  const query = new URLSearchParams();
  if (params.sent) query.set("sent", "1");
  if (params.error) query.set("error", params.error);
  const next = params.next == null ? "/app" : safeNextPath(params.next);
  if (next !== "/app") query.set("next", next);
  const search = query.toString();
  return search ? `/login?${search}` : "/login";
}

export function loginErrorPath(code: LoginErrorCode, next?: string | null): string {
  return loginPath({ error: code, next });
}

/** The "sent" screen: the mail went out; the code form is there, with an error when one is given. */
export function loginSentPath(next?: string | null, error?: LoginErrorCode): string {
  return loginPath({ sent: true, error, next });
}

/** The send form again ("メールを送り直す"), keeping where to go after signing in. */
export function loginFormPath(next?: string | null): string {
  return loginPath({ next });
}

/**
 * Which fixed message a refused signInWithOtp gets. Decided by Supabase's error code and status,
 * and by whether this press sent a token; never by the English message text.
 * - `captcha_failed` (400): CAPTCHA is on and the token is missing, expired, used or invalid.
 *   Supabase answers the same code for all of them, so what this press sent tells them apart.
 * - 429: Supabase's own send limits.
 */
export function loginSendErrorCode(error: { status?: number; code?: string }, sentCaptchaToken: boolean): LoginErrorCode {
  if (error.code === "captcha_failed") return sentCaptchaToken ? "captcha_refused" : "captcha_missing";
  if (error.status === 429) return "busy";
  return "send_failed";
}

/**
 * Why Supabase did not accept a token (verifyOtp), by status only, never by the English text:
 * - `limited`: 429 (over_request_rate_limit). Supabase Auth limits /verify per IP before it reads
 *   the token, so the same link or code still works later. The limit is token_verifications in
 *   config.toml (30 per 5 minutes); GoTrue keeps it as a bucket (v2.150: rate 30 per 300 s, burst
 *   30), which gives one more try every 10 seconds once spent: a minute is the wait to suggest.
 *   The IP Supabase sees is this server's, shared by everyone signing in at the moment.
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

const LINK_ERROR = { invalid: "link_invalid", limited: "link_limited", failed: "link_failed" } as const;

/** The fixed message code for a link /auth/confirm could not verify (`null`: verifyOtp threw). */
export function loginLinkErrorCode(error: { status?: number; code?: string } | null): LoginErrorCode {
  return error ? LINK_ERROR[verifyFailure(error)] : "link_failed";
}

const CODE_ERROR = { invalid: "code_invalid", limited: "code_limited", failed: "code_failed" } as const;

/** The same for a code typed on the "sent" screen. */
export function loginCodeErrorCode(error: { status?: number; code?: string } | null): LoginErrorCode {
  return error ? CODE_ERROR[verifyFailure(error)] : "code_failed";
}

/** The message for a query value; null when there is no error to show. */
export function loginErrorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(LOGIN_ERROR_MESSAGES, code) ? LOGIN_ERROR_MESSAGES[code as LoginErrorCode] : UNKNOWN_LOGIN_ERROR;
}

/**
 * The address to echo in "sent to …". Only a plain ASCII address is echoed back; anything else
 * in ?sent= (which anyone can put in a link) gets the sentence without an address.
 */
export function sentAddress(value: string | undefined): string | null {
  if (!value || value.length > 254) return null;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value) ? value : null;
}
