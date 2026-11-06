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
  link_invalid: "リンクを確認できませんでした（期限切れか、すでに使われたリンクです）。もう一度リンクを送ってください。",
  link_incomplete: "リンクが不完全です。もう一度リンクを送ってください。",
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

/** Shown for a code this version does not know (an old link, or one somebody typed). */
export const UNKNOWN_LOGIN_ERROR = "ログインできませんでした。もう一度リンクを送ってください。";

/** Shown in the bot check's place when its script cannot load (blocked, offline, Cloudflare down). */
export const TURNSTILE_UNAVAILABLE_MESSAGE = "確認を読み込めませんでした。ページを読み込み直すか、別のブラウザでお試しください。";

export function loginErrorPath(code: LoginErrorCode): string {
  return `/login?error=${code}`;
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
