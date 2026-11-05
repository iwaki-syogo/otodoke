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

export function loginErrorPath(code: LoginErrorCode): string {
  return `/login?error=${code}`;
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
