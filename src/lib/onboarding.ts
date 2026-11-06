import { CONFIRMED_PATH } from "@/lib/login-errors";

/**
 * From the sign-up to the forwarding setup without a stop (decided on 2026-11-07): the words of the
 * three screens and where each one leads. The words are the iOS app's too, character for character
 * (the source is the team's onboarding-wording.md, outside this repository); change them only
 * together with it. Pure: the screens and the route import it.
 *
 *   1  /signup, once the confirmation mail went: the tab keeps the password in its memory and signs
 *      in by itself when it is shown again (or 「確認しました」 is pressed).
 *   2  /auth/confirmed, where the mail's link leads (POST /auth/confirm, a sign-up's link only).
 *   3  /app/welcome, after the sign-in that made the user's first mail key.
 */

/** Screen 1: the sign-up's own tab, waiting for the confirmation. */
export const CONFIRM_WAIT = {
  title: "確認のメールを送りました",
  body: "メールのリンクを押してこの画面に戻ると、自動で次へ進みます。",
  done: "確認しました",
  resend: "メールを送り直す",
  /** After 「確認しました」 only: a sign-in tried by itself says nothing when the address is not confirmed yet. */
  notYet: "まだ確認できていません。メールのリンクを押しましたか？",
  /** The toast after 「メールを送り直す」 went through. */
  resent: "送り直しました",
} as const;

/** Screen 2: the browser that opened the confirmation link. */
export const CONFIRMED = {
  title: "確認できました",
  body: "登録した画面に戻ると、自動で次へ進みます。",
  logIn: "この画面でログインする",
} as const;

/** Screen 3: the first-run guide. */
export const WELCOME = {
  title: "最後に、メールの自動転送を設定しますか？",
  body: "設定は最初の 1 回だけです。",
  copyStep: "1. 転送先アドレスをコピー",
  setUpStep: "2. お使いのメールで設定",
  done: "設定しました",
  later: "あとで",
} as const;

/** Screen 3's path. */
export const WELCOME_PATH = "/app/welcome";

/** Where both of screen 3's buttons lead: the parcel list. */
export const AFTER_WELCOME_PATH = "/app";

/** Screen 2's path: where POST /auth/confirm sends a sign-up's confirmation link it accepted. */
export const SIGNUP_CONFIRMED_PATH = "/auth/confirmed";

/** Screen 2's 「この画面でログインする」: the login with its `confirmed` words, then screen 3. */
export const CONFIRMED_LOGIN_PATH = `${CONFIRMED_PATH}&next=${encodeURIComponent(WELCOME_PATH)}`;

/**
 * Where a sign-in that opened the key goes: screen 3 when this sign-in made the user's first key
 * (the same rule as iOS; nothing is stored to say so), else `next`. A later sign-in finds the key
 * and opens it, so it never sees screen 3 by itself.
 */
export function landingAfterSignIn(key: "opened" | "made", next: string): string {
  return key === "made" ? WELCOME_PATH : next;
}

/**
 * The shortest time between two sign-ins the waiting screen tries by itself. Showing a tab again
 * fires both `visibilitychange` and `focus`: they make one try. No timer tries again.
 */
export const AUTO_SIGN_IN_GAP_MS = 2_000;
