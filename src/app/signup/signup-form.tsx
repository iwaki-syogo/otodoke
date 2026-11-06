"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LeaveFor } from "@/components/leave-for";
import { PendingButton, PendingSubmitButton } from "@/components/pending-button";
import { flowMessage, signInAndOpenKey, signUpWithPassword } from "@/lib/crypto/password-flows";
import { PASSWORD_RULE, passwordProblem } from "@/lib/crypto/password-v1";
import { LOGIN_MESSAGES, TURNSTILE_TICK_PROMPT, loginMessage } from "@/lib/login-errors";
import { isAsciiAddress, isLoginAddress, normalizeLoginAddress } from "@/lib/login-form";
import { AUTO_SIGN_IN_GAP_MS, CONFIRM_WAIT, landingAfterSignIn } from "@/lib/onboarding";
import { safeNextPath } from "@/lib/safe-next";
import { pressText, tokenForAutoAttempt, tokenForPress, type TokenField } from "@/lib/turnstile";
import { inputClass, submitClass } from "@/app/login/form-style";
import { resendConfirmation, signUpWithAuthSecret } from "@/app/login/actions";
import { signInPorts } from "@/app/login/sign-in-ports";
import { TurnstileWidget } from "@/app/login/turnstile-widget";

/** The waiting screen's main button: black and full width, as on the other onboarding screens. */
const primaryClass = "flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 py-4 text-base font-medium text-white active:opacity-80";

/** How long the 「送り直しました」 toast stays. */
const TOAST_MS = 4_000;

/**
 * What the waiting screen says. `not_yet`: 「確認しました」 was pressed before the link. `key`: signed
 * in, but the key did not open or could not be made (the app can still be used).
 */
type WaitNotice = { kind: "not_yet" } | { kind: "error"; text: string } | { kind: "key"; text: string };

/** Who tried the sign-in: the screen by itself (the tab shown again) or a press of 「確認しました」. */
type Trigger = "auto" | "press";

/**
 * /signup: the address and the password, twice. Only the login secret is sent; the key is made at
 * the first sign-in, after the confirmation link (decision 6). An address with characters outside
 * ASCII is refused here as on the server (decision 9).
 *
 * Once the mail is sent, the same tab waits for the confirmation (onboarding screen 1): it keeps the
 * address and the password in a ref of this component, nowhere else (no storage, no URL, no
 * cookie), and signs in with them as /login does when the tab is shown again (`visibilitychange`
 * to visible, `focus`) or 「確認しました」 is pressed. No timer tries. A sign-in tried by itself says
 * nothing while the address is not confirmed; a press says so. The sign-in that makes the first key
 * goes on to the first-run guide. A reload forgets the password: /login is the way on then.
 *
 * No field has a `name` and the form is POST without an action (password-forms.test.ts).
 */
export function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsTick, setNeedsTick] = useState(false);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The address the confirmation went to, once sent. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  /** A sign-in on its way from the waiting screen (by itself or pressed). */
  const [signingIn, setSigningIn] = useState(false);
  const [notice, setNotice] = useState<WaitNotice | null>(null);
  /** 「送り直しました」, or the words of a resend that did not go through. */
  const [resent, setResent] = useState<{ ok: boolean; text: string } | null>(null);
  const [leaveFor, setLeaveFor] = useState<string | null>(null);
  // Refs, not state: a second press (or Enter, or the second event of a tab shown again) can come
  // before React has drawn the first. One request at a time: each takes the widget's token.
  const running = useRef(false);
  const token = useRef<TokenField>({ value: "", dataset: {} });
  /** The address and the password of the account just made, for the sign-in: this tab's memory only. */
  const account = useRef<{ email: string; password: string } | null>(null);
  /** When the screen last tried a sign-in by itself. */
  const lastAuto = useRef(0);
  /** 「確認しました」 was pressed while a sign-in tried by itself was on its way: its answer is told. */
  const pressedMeanwhile = useRef(false);

  /** The address problem the browser can tell, or null. */
  function addressProblem(): string | null {
    const address = normalizeLoginAddress(email);
    if (!isLoginAddress(address)) return LOGIN_MESSAGES.invalid_email;
    if (!isAsciiAddress(address)) return LOGIN_MESSAGES.email_not_ascii;
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    const problem = addressProblem() ?? passwordProblem(password, again);
    if (problem) {
      setError(problem);
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const captchaToken = await tokenForPress(token.current, { onNeedsTick: setNeedsTick });
      setNeedsTick(false);
      const result = await signUpWithPassword({ email, password, captchaToken }, { signUpWithAuthSecret });
      if (!result.ok) {
        setError(pressText(result.code, captchaToken, flowMessage(result.code)));
        return;
      }
      account.current = { email, password };
      setPassword("");
      setAgain("");
      setSentTo(email);
    } finally {
      // The token went with the press (each is checked once): the next press waits for a new one.
      setRound((r) => r + 1);
      running.current = false;
      setBusy(false);
    }
  }

  async function resend() {
    if (running.current || !sentTo) return;
    running.current = true;
    setBusy(true);
    setResent(null);
    try {
      const captchaToken = await tokenForPress(token.current, { onNeedsTick: setNeedsTick });
      setNeedsTick(false);
      const result = await resendConfirmation({ email: sentTo, captchaToken }).catch(() => ({ ok: false as const, code: "network" as const }));
      setResent(result.ok ? { ok: true, text: CONFIRM_WAIT.resent } : { ok: false, text: pressText(result.code, captchaToken, loginMessage(result.code)) });
    } finally {
      // The token went with the press (each is checked once): the next press waits for a new one.
      setRound((r) => r + 1);
      running.current = false;
      setBusy(false);
    }
  }

  /**
   * The sign-in of the waiting screen, as /login's (signInAndOpenKey with the same Actions). Only
   * refs and setters are read, so the listeners added once always call the current one.
   */
  const trySignIn = useCallback(async (trigger: Trigger) => {
    const creds = account.current;
    if (!creds) return;
    if (running.current) {
      if (trigger === "press") pressedMeanwhile.current = true;
      return;
    }
    if (trigger === "auto") {
      const now = Date.now();
      if (now - lastAuto.current < AUTO_SIGN_IN_GAP_MS) return;
      lastAuto.current = now;
    }
    running.current = true;
    pressedMeanwhile.current = false;
    setSigningIn(true);
    if (trigger === "press") setNotice(null);
    let sent = false;
    let leaving = false;
    try {
      let captchaToken: string | undefined;
      if (trigger === "press") {
        captchaToken = await tokenForPress(token.current, { onNeedsTick: setNeedsTick });
        setNeedsTick(false);
      } else {
        // No token without a tick: nothing is sent, and the next trigger tries again.
        const got = await tokenForAutoAttempt(token.current);
        if (!got.send) return;
        captchaToken = got.token;
      }
      sent = true;
      const result = await signInAndOpenKey({ email: creds.email, password: creds.password, captchaToken }, signInPorts());
      const told = trigger === "press" || pressedMeanwhile.current;
      if (!result.ok) {
        if (result.code === "not_confirmed") {
          if (told) setNotice({ kind: "not_yet" });
          return;
        }
        setNotice({ kind: "error", text: pressText(result.code, captchaToken, flowMessage(result.code)) });
        return;
      }
      // Signed in: the password is not needed again.
      account.current = null;
      if (result.key === "opened" || result.key === "made") {
        leaving = true;
        setLeaveFor(landingAfterSignIn(result.key, safeNextPath(null)));
        return;
      }
      setNotice({ kind: "key", text: result.key === "not_opened" ? LOGIN_MESSAGES.key_not_opened : flowMessage(result.code) });
    } finally {
      pressedMeanwhile.current = false;
      // The token went with the sign-in (each is checked once): the next one waits for a new one.
      if (sent) setRound((r) => r + 1);
      // After a sign-in that leaves the page, the press stays shown until the next page is drawn.
      if (!leaving) {
        running.current = false;
        setSigningIn(false);
      }
    }
  }, []);

  // The tab shown again: the person may have opened the link meanwhile.
  useEffect(() => {
    if (!sentTo || typeof document === "undefined") return;
    const onShown = () => {
      if (document.visibilityState === "visible") void trySignIn("auto");
    };
    document.addEventListener("visibilitychange", onShown);
    window.addEventListener("focus", onShown);
    return () => {
      document.removeEventListener("visibilitychange", onShown);
      window.removeEventListener("focus", onShown);
    };
  }, [sentTo, trySignIn]);

  // The toast goes after a while.
  useEffect(() => {
    if (!resent?.ok) return;
    const timer = setTimeout(() => setResent(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [resent]);

  if (sentTo) {
    const signInHeld = signingIn && needsTick;
    const resendHeld = busy && needsTick;
    return (
      <>
        <h1 className="text-2xl font-bold">{CONFIRM_WAIT.title}</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">{CONFIRM_WAIT.body}</p>
        <p className="mt-1 break-all text-sm font-medium text-neutral-900">{sentTo}</p>
        <div className="mt-6 flex flex-col gap-3">
          <TurnstileWidget tokenRef={token} round={round} />
          <PendingButton pending={signingIn && !needsTick} pendingLabel="ログインしています…" tone="light" onClick={() => void trySignIn("press")} className={primaryClass}>
            {signInHeld ? TURNSTILE_TICK_PROMPT : CONFIRM_WAIT.done}
          </PendingButton>
          {notice?.kind === "not_yet" ? (
            <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {CONFIRM_WAIT.notYet}
            </p>
          ) : null}
          {notice?.kind === "error" ? (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              {notice.text}
            </p>
          ) : null}
          {notice?.kind === "key" ? (
            <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
              <p>{notice.text}</p>
              <Link href={safeNextPath(null)} className="mt-3 inline-block rounded-lg border border-neutral-300 bg-white px-4 py-2 font-medium text-neutral-900">
                このまま進む
              </Link>
            </div>
          ) : null}
          <PendingButton pending={busy && !needsTick} pendingLabel="送っています…" onClick={resend} className="flex items-center justify-center gap-2 self-center px-4 py-2 text-sm text-neutral-600 underline underline-offset-4">
            {resendHeld ? TURNSTILE_TICK_PROMPT : CONFIRM_WAIT.resend}
          </PendingButton>
          {resent && !resent.ok ? <p className="text-sm text-red-800">{resent.text}</p> : null}
        </div>
        {resent?.ok ? (
          <div role="status" className="fixed inset-x-4 bottom-6 z-20 mx-auto max-w-md rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white">
            {resent.text}
          </div>
        ) : null}
        {leaveFor ? <LeaveFor href={leaveFor} /> : null}
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-bold">アカウントを作る</h1>
      <form method="post" onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="signup-email">
          メールアドレス
        </label>
        <input id="signup-email" type="email" required autoComplete="username" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        <label className="text-sm font-medium" htmlFor="signup-password">
          パスワード
        </label>
        <input id="signup-password" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        <label className="text-sm font-medium" htmlFor="signup-password-again">
          パスワードをもう一度
        </label>
        <input id="signup-password-again" type="password" required autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={inputClass} />
        <p className="text-xs leading-5 text-neutral-500">{PASSWORD_RULE}</p>
        <TurnstileWidget tokenRef={token} round={round} />
        <PendingSubmitButton pending={busy && !needsTick} pendingLabel="作っています…" tone="light" className={submitClass}>
          {busy && needsTick ? TURNSTILE_TICK_PROMPT : "アカウントを作る"}
        </PendingSubmitButton>
        {error ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </p>
        ) : null}
      </form>
      <Link href="/privacy" className="mt-4 self-start text-sm text-neutral-600 underline underline-offset-4">
        プライバシーポリシー
      </Link>
      <Link href="/login" className="mt-4 self-start text-sm text-neutral-600 underline underline-offset-4">
        ログイン
      </Link>
    </>
  );
}
