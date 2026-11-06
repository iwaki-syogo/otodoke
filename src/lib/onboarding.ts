import { CONFIRMED_PATH } from "@/lib/login-errors";

/**
 * From the sign-up to the forwarding setup without a stop (decided on 2026-11-07): the words of the
 * three screens and where each one leads. The words are the iOS app's too, character for character;
 * change them only together with it. Pure: the screens and the route import it.
 *
 *   1  /signup, once the confirmation mail went: the tab keeps the password in its memory and signs
 *      in by itself when it is shown again (or 「確認しました」 is pressed).
 *   2  /auth/confirmed, where the mail's link leads (POST /auth/confirm, a sign-up's link only).
 *   3  /app/welcome, after the sign-in that made the user's first mail key.
 */

/** Screen 1: the sign-up's own tab, waiting for the confirmation. */
export const CONFIRM_WAIT = {
  title: "確認のメールを送りました",
  body: "メールのリンクを開いて「確認する」を押すと、この画面が自動で次へ進みます。進まないときは「確認しました」を押してください。",
  done: "確認しました",
  resend: "メールを送り直す",
  /** Under 「メールを送り直す」, smaller: the address and the password are let go, and the form is back. */
  restart: "別のアドレスでやり直す",
  /** After 「確認しました」 only: a sign-in tried by itself says nothing when the address is not confirmed yet. */
  notYet: "まだ確認できていません。メールのリンクを押しましたか？",
  /** The toast after 「メールを送り直す」 went through. */
  resent: "送り直しました",
} as const;

/** Screen 2: the browser that opened the confirmation link. */
export const CONFIRMED = {
  title: "確認できました",
  body: "登録した画面に戻ってください。",
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

/**
 * Screen 2's 「この画面でログインする」: the login with its `confirmed` words, and no next. The sign-in
 * that makes the first key goes to screen 3 by itself (landingAfterSignIn); one that finds a key goes
 * where every login does.
 */
export const CONFIRMED_LOGIN_PATH = CONFIRMED_PATH;

/**
 * Where a sign-in that opened the key goes: screen 3 when this sign-in made the user's first key
 * (the same rule as iOS; nothing is stored to say so), else `next`. A later sign-in finds the key
 * and opens it, so it never sees screen 3 by itself.
 */
export function landingAfterSignIn(key: "opened" | "made", next: string): string {
  return key === "made" ? WELCOME_PATH : next;
}

/**
 * How often the waiting screen tries a sign-in by itself: every try counts against the sign-in
 * limits per IP (LOGIN_TRY_LIMITS, 15 in 10 minutes) and Supabase's own. A press of 「確認しました」
 * always tries, and changes none of this unless it signs in.
 *
 * - The tab shown again (`visibilitychange` to visible, `focus`) tries at once. The two events of
 *   one return, within AUTO_SIGN_IN_SAME_RETURN_MS of each other, are one try.
 * - While the tab is shown, one timer tries at the next point of the backoff (the link may have been
 *   opened on another device, with this tab in sight all the time): AUTO_SIGN_IN_BACKOFF_MS[0]
 *   after the screen appears, then after each try refused as "not confirmed yet" the next gap of
 *   the list, its last one again after that. Hidden, the timer is cancelled; shown again, the
 *   return tries and the timer starts anew.
 * - After a refusal other than "not confirmed yet", the next try waits at least
 *   AUTO_SIGN_IN_AFTER_FAILURE_MS.
 * - At most AUTO_SIGN_IN_MAX sends per waiting screen (returns and the timer together); after them
 *   only the button tries.
 */
export const AUTO_SIGN_IN_BACKOFF_MS = [20_000, 60_000, 180_000] as const;
export const AUTO_SIGN_IN_SAME_RETURN_MS = 2_000;
export const AUTO_SIGN_IN_AFTER_FAILURE_MS = 60_000;
export const AUTO_SIGN_IN_MAX = 5;

/** The gap before the next timed try, after `refusals` tries by themselves refused as "not confirmed yet". */
export function autoSignInGapMs(refusals: number): number {
  return AUTO_SIGN_IN_BACKOFF_MS[Math.min(Math.max(refusals - 1, 0), AUTO_SIGN_IN_BACKOFF_MS.length - 1)];
}
