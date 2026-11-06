"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { LeaveFor } from "@/components/leave-for";
import { PendingButton, PendingSubmitButton } from "@/components/pending-button";
import { flowMessage, signInAndOpenKey, signUpWithPassword } from "@/lib/crypto/password-flows";
import { PASSWORD_RULE, passwordProblem } from "@/lib/crypto/password-v1";
import { LOGIN_MESSAGES, TURNSTILE_TICK_PROMPT, loginMessage } from "@/lib/login-errors";
import { isAsciiAddress, isLoginAddress, normalizeLoginAddress } from "@/lib/login-form";
import { handOffToLogin } from "@/lib/login-handoff";
import { AUTO_SIGN_IN_AFTER_FAILURE_MS, AUTO_SIGN_IN_MAX, AUTO_SIGN_IN_SAME_RETURN_MS, CONFIRM_WAIT, autoSignInGapMs, landingAfterSignIn } from "@/lib/onboarding";
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
 * in, but the key did not open or could not be made: the waiting is over (the app can still be
 * used, and the key is made in 設定 › パスワードとメールの鍵).
 */
type WaitNotice = { kind: "not_yet" } | { kind: "error"; text: string } | { kind: "key"; text: string };

/** Who tried the sign-in: the screen by itself (the tab shown again) or a press of 「確認しました」. */
type Trigger = "auto" | "press";

/** What holds the widget's token now (one request at a time: each token is checked once). */
type Task = "signup" | "resend" | "signin";

type SignInAnswer = Awaited<ReturnType<typeof signInAndOpenKey>>;

/**
 * /signup: the address and the password, twice. Only the login secret is sent; the key is made at
 * the first sign-in, after the confirmation link (decision 6). An address with characters outside
 * ASCII is refused here as on the server (decision 9).
 *
 * Once the mail is sent, the same tab waits for the confirmation (onboarding screen 1): it keeps the
 * address and the password in a ref of this component, nowhere else (no storage, no URL, no
 * cookie), and signs in with them as /login does when the tab is shown again (`visibilitychange`
 * to visible, `focus`) or 「確認しました」 is pressed, and, while the tab is shown, at the points of
 * the backoff (AUTO_SIGN_IN_BACKOFF_MS: one timer at a time, cancelled when hidden, and on restart,
 * success and unmount; the link may have been opened on another device). A sign-in tried by itself says
 * nothing while the address is not confirmed; a press says so. The sign-in that makes the first key
 * goes straight on to the first-run guide (the press stays shown until it is there). A reload
 * forgets the password: /login is the way on then.
 *
 * - The tries by themselves are few (AUTO_SIGN_IN_BACKOFF_MS, AUTO_SIGN_IN_AFTER_FAILURE_MS,
 *   AUTO_SIGN_IN_MAX): each one counts against the sign-in limits per IP. A press always tries.
 * - Signed in, but the key did not open or could not be made: the waiting screen goes, and the
 *   key's words stay with 「このまま進む」 and the way to 設定 › パスワードとメールの鍵.
 * - `credentials` (an account with another password has the address): it stops waiting and goes to
 *   /login with the address filled in and those words (src/lib/login-handoff.ts; never the password).
 *   Any other refusal stays here with LOGIN_MESSAGES' words, and the next return or press tries again.
 * - A try by itself refused with `captcha` (the token ran out) tries once more with a new token,
 *   then says nothing until the next trigger.
 * - One request at a time. A press while another one is on its way is shown pressed at once and
 *   goes after it; a press of something on its way or waiting already is that one (never two
 *   sign-ups, two mails, two sign-ins for one press). The sign-up never goes again once the
 *   waiting screen is shown.
 * - 「別のアドレスでやり直す」 lets the address and the password go and brings the form back. A press
 *   still waiting for its token sends nothing (the token is the new form's). While a sign-in is on
 *   its way to the server, it is shown pressed and waits for the answer: a refusal brings the form
 *   back; a sign-in that went through goes on as it would have (a key made is never let go, and the
 *   form is never shown to a signed-in tab).
 * - A press's token past TURNSTILE_TOKEN_STALE_MS (a tab frozen in the background) is renewed
 *   first, as for a try by itself.
 *
 * No field has a `name` and the form is POST without an action (password-forms.test.ts).
 */
export function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  /** 「アカウントを作る」 on its way (or waiting for the request before it). */
  const [creating, setCreating] = useState(false);
  /** 「メールを送り直す」 on its way (or waiting for the request before it). */
  const [resending, setResending] = useState(false);
  /** A sign-in from the waiting screen on its way (by itself or pressed, or a press waiting for its turn). */
  const [signingIn, setSigningIn] = useState(false);
  /** The request that holds the token, for the tick prompt to show on its button. */
  const [active, setActive] = useState<Task | null>(null);
  const [needsTick, setNeedsTick] = useState(false);
  const [round, setRound] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** The address the confirmation went to, once sent. */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [notice, setNotice] = useState<WaitNotice | null>(null);
  /** 「送り直しました」, or the words of a resend that did not go through. */
  const [resent, setResent] = useState<{ ok: boolean; text: string } | null>(null);
  const [leaveFor, setLeaveFor] = useState<string | null>(null);
  // Refs, not state: a second press (or Enter, or the second event of a tab shown again) can come
  // before React has drawn the first.
  const running = useRef<Task | null>(null);
  /** The presses waiting for the request on its way: at most one of each kind. */
  const waiters = useRef<Array<{ task: Task; run: () => void }>>([]);
  /** The waiting screen is shown: the sign-up is done (until 「別のアドレスでやり直す」). */
  const waitingShown = useRef(false);
  const token = useRef<TokenField>({ value: "", dataset: {} });
  /** The address and the password of the account just made, for the sign-in: this tab's memory only. */
  const account = useRef<{ email: string; password: string } | null>(null);
  /** Moves on at 「別のアドレスでやり直す」: an answer of an earlier screen is not read. */
  const epoch = useRef(0);
  /**
   * The tries by themselves: when the last one began (or the screen appeared), how many were refused
   * as "not confirmed yet" (the backoff), the earliest the next may be after another refusal, how
   * many were sent, when the tab was last shown again, and when 「確認しました」 last sent a sign-in.
   */
  const auto = useRef({ lastAt: 0, refusals: 0, notBefore: 0, sends: 0, lastReturnAt: 0, pressedAt: 0 });
  /** 「確認しました」 was pressed while a sign-in tried by itself was on its way: its answer is told. */
  const pressedMeanwhile = useRef(false);
  /** A sign-in is on its way to the server (sent, no answer yet). */
  const inFlight = useRef(false);
  /** 「別のアドレスでやり直す」 was pressed while a sign-in was in flight: it acts on the answer. */
  const restartAfter = useRef(false);
  const [restartPending, setRestartPending] = useState(false);
  /** A request has sent the token in the field (it is used up until spendToken). */
  const tokenSent = useRef(false);
  /** The one timer that tries at the next point of the backoff, while the tab is shown. */
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What the timer does (set below, once trySignIn is made): one try by itself. */
  const timedTry = useRef<(() => void) | null>(null);
  const clearAutoTimer = useCallback(() => {
    if (autoTimer.current !== null) clearTimeout(autoTimer.current);
    autoTimer.current = null;
  }, []);
  /**
   * The timer set anew for the next point of the backoff: only while waiting, below the maximum,
   * and with the tab shown. Never two.
   */
  const scheduleAuto = useCallback(() => {
    clearAutoTimer();
    const a = auto.current;
    if (!account.current || a.sends >= AUTO_SIGN_IN_MAX) return;
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    // A press counts as a try for the timing (not for the backoff): no timed try right after its answer.
    const gap = autoSignInGapMs(a.refusals);
    const at = Math.max(a.lastAt + gap, a.pressedAt + gap, a.notBefore);
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      timedTry.current?.();
    }, Math.max(0, at - Date.now()));
  }, [clearAutoTimer]);
  /** A press of 「確認しました」 that waited for its turn (set below, once trySignIn is made). */
  const queuedPress = useRef<(() => void) | null>(null);

  /** The address problem the browser can tell, or null. */
  function addressProblem(): string | null {
    const address = normalizeLoginAddress(email);
    if (!isLoginAddress(address)) return LOGIN_MESSAGES.invalid_email;
    if (!isAsciiAddress(address)) return LOGIN_MESSAGES.email_not_ascii;
    return null;
  }

  /** The request on its way is over: the next press that waited for it goes. */
  const release = useCallback(() => {
    running.current = null;
    setActive(null);
    waiters.current.shift()?.run();
    // A timed try that met a request on its way was dropped: the next point is set again.
    scheduleAuto();
  }, [scheduleAuto]);

  /** A press of `task` that is on its way or waiting already: the new press is that one. */
  const pressedAlready = (task: Task) => running.current === task || waiters.current.some((w) => w.task === task);

  /** The token was sent (each is checked once), or is too old: emptied at once, and the widget makes a new one. */
  const spendToken = useCallback(() => {
    tokenSent.current = false;
    token.current.value = "";
    delete token.current.dataset.tokenAt;
    setRound((r) => r + 1);
  }, []);

  /** The token for a press, as /login's (tokenForPress, which renews one too old by itself). */
  const pressToken = useCallback(async () => {
    const captchaToken = await tokenForPress(token.current, { onNeedsTick: setNeedsTick, onStale: spendToken });
    setNeedsTick(false);
    return captchaToken;
  }, [spendToken]);

  function submit(e: React.FormEvent): Promise<void> | undefined {
    e.preventDefault();
    const problem = addressProblem() ?? passwordProblem(password, again);
    if (problem) {
      setError(problem);
      return;
    }
    // A second press (a double tap, Enter) before React has drawn the first is the first.
    if (waitingShown.current || pressedAlready("signup")) return;
    setError(null);
    const typed = { email, password };
    setCreating(true);
    if (running.current) {
      waiters.current.push({ task: "signup", run: () => void createAccount(typed) });
      return;
    }
    return createAccount(typed);
  }

  async function createAccount(typed: { email: string; password: string }) {
    if (waitingShown.current) {
      setCreating(false);
      release();
      return;
    }
    running.current = "signup";
    setActive("signup");
    setCreating(true);
    try {
      const captchaToken = await pressToken();
      let result: Awaited<ReturnType<typeof signUpWithPassword>>;
      try {
        tokenSent.current = true;
        result = await signUpWithPassword({ email: typed.email, password: typed.password, captchaToken }, { signUpWithAuthSecret });
      } finally {
        spendToken();
      }
      if (!result.ok) {
        setError(pressText(result.code, captchaToken, flowMessage(result.code)));
        return;
      }
      account.current = { email: typed.email, password: typed.password };
      waitingShown.current = true;
      // The backoff counts from the moment the waiting screen appears.
      auto.current = { lastAt: Date.now(), refusals: 0, notBefore: 0, sends: 0, lastReturnAt: 0, pressedAt: 0 };
      setPassword("");
      setAgain("");
      setSentTo(typed.email);
    } finally {
      setCreating(false);
      release();
    }
  }

  function resend(): Promise<void> | undefined {
    if (!sentTo || pressedAlready("resend")) return;
    setResent(null);
    setResending(true);
    if (running.current) {
      waiters.current.push({ task: "resend", run: () => void resendNow(sentTo) });
      return;
    }
    return resendNow(sentTo);
  }

  async function resendNow(to: string) {
    const mine = epoch.current;
    running.current = "resend";
    setActive("resend");
    setResending(true);
    try {
      const captchaToken = await pressToken();
      // 「別のアドレスでやり直す」 meanwhile: no mail to the address let go (the token is the new form's).
      if (epoch.current !== mine) return;
      let result: Awaited<ReturnType<typeof resendConfirmation>>;
      try {
        tokenSent.current = true;
        result = await resendConfirmation({ email: to, captchaToken }).catch(() => ({ ok: false as const, code: "network" as const }));
      } finally {
        // After 「別のアドレスでやり直す」 the token field is the new form's: an old request leaves it alone.
        if (epoch.current === mine) spendToken();
      }
      if (epoch.current !== mine) return;
      setResent(result.ok ? { ok: true, text: CONFIRM_WAIT.resent } : { ok: false, text: pressText(result.code, captchaToken, loginMessage(result.code)) });
    } finally {
      // After 「別のアドレスでやり直す」 the lock is the new screen's already.
      if (epoch.current === mine) {
        setResending(false);
        release();
      }
    }
  }

  const startOver = useCallback(() => {
    restartAfter.current = false;
    setRestartPending(false);
    epoch.current += 1;
    clearAutoTimer();
    account.current = null;
    waitingShown.current = false;
    waiters.current = [];
    // A request still on its way is left to finish unread: the new form need not wait for it.
    running.current = null;
    setActive(null);
    setNeedsTick(false);
    pressedMeanwhile.current = false;
    setSentTo(null);
    setNotice(null);
    setResent(null);
    setSigningIn(false);
    setResending(false);
    setEmail("");
    setPassword("");
    setAgain("");
    setError(null);
    // A token a request has already sent is used up (the old request no longer spends it): the new form gets a fresh one.
    if (tokenSent.current) spendToken();
  }, [clearAutoTimer, spendToken]);

  /**
   * The sign-in of the waiting screen, as /login's (signInAndOpenKey with the same Actions). Only
   * refs and setters are read, so the listeners added once always call the current one.
   */
  const trySignIn = useCallback(
    async (trigger: Trigger, fromQueue = false) => {
      if (!account.current) {
        if (trigger === "press") setSigningIn(false);
        // A press that waited for its turn: the next one waiting goes all the same.
        if (fromQueue) release();
        return;
      }
      if (trigger === "press" && running.current) {
        if (running.current === "signin") pressedMeanwhile.current = true;
        else if (!pressedAlready("signin")) {
          // Shown pressed at once; it goes once the request on its way is over.
          setSigningIn(true);
          waiters.current.push({ task: "signin", run: () => queuedPress.current?.() });
        }
        return;
      }
      const mine = epoch.current;
      let captchaToken: string | undefined;
      if (trigger === "auto") {
        if (running.current) return;
        const a = auto.current;
        const now = Date.now();
        if (a.sends >= AUTO_SIGN_IN_MAX) return;
        // After a refusal other than "not confirmed yet": the timer tries when the wait is over.
        if (now < a.notBefore) {
          scheduleAuto();
          return;
        }
        clearAutoTimer();
        a.lastAt = now;
        // No token without a tick: nothing is sent, and the next point (or return) tries again.
        const got = await tokenForAutoAttempt(token.current, { onStale: spendToken });
        if (!got.send || running.current || epoch.current !== mine || !account.current) {
          if (epoch.current === mine && !running.current) scheduleAuto();
          return;
        }
        captchaToken = got.token;
      }
      const creds = account.current;
      running.current = "signin";
      setActive("signin");
      pressedMeanwhile.current = false;
      setSigningIn(true);
      if (trigger === "press") {
        setNotice(null);
        // The press is the try now: the timed one waiting is cancelled (set again from here when it is over).
        clearAutoTimer();
        auto.current.pressedAt = Date.now();
      }
      let leaving = false;
      const signIn = async (withToken: string | undefined): Promise<SignInAnswer> => {
        if (trigger === "auto") auto.current.sends += 1;
        inFlight.current = true;
        try {
          tokenSent.current = true;
          return await signInAndOpenKey({ email: creds.email, password: creds.password, captchaToken: withToken }, signInPorts());
        } finally {
          inFlight.current = false;
          // As for the resend: after a restart the token is the new form's.
          if (epoch.current === mine) spendToken();
        }
      };
      try {
        if (trigger === "press") {
          captchaToken = await pressToken();
          // 「別のアドレスでやり直す」 meanwhile: the account let go is not signed in (the token is the new form's).
          if (epoch.current !== mine) return;
        }
        let result = await signIn(captchaToken);
        // A try by itself whose token was refused (it ran out while the tab was away): once more with a new one.
        if (trigger === "auto" && !result.ok && result.code === "captcha" && !pressedMeanwhile.current && !restartAfter.current && auto.current.sends < AUTO_SIGN_IN_MAX) {
          const got = await tokenForAutoAttempt(token.current, { onStale: spendToken });
          if (got.send && epoch.current === mine) {
            captchaToken = got.token;
            result = await signIn(captchaToken);
          }
        }
        if (epoch.current !== mine) return;
        if (restartAfter.current) {
          // 「別のアドレスでやり直す」 waited for this answer. Signed out still (a refusal other than
          // credentials, which goes to /login with the address): the form comes back. Signed in: on
          // as below, the restart dropped.
          restartAfter.current = false;
          setRestartPending(false);
          if (!result.ok && result.code !== "credentials") {
            startOver();
            return;
          }
        }
        const told = trigger === "press" || pressedMeanwhile.current;
        if (!result.ok) {
          if (result.code === "not_confirmed") {
            // The backoff grows with each try by itself refused so; a press changes nothing of it.
            if (trigger === "auto") auto.current.refusals += 1;
            if (told) setNotice({ kind: "not_yet" });
            return;
          }
          if (result.code === "credentials") {
            // Another password has this address: the login, with the address filled in.
            account.current = null;
            clearAutoTimer();
            handOffToLogin({ email: creds.email, code: "credentials" });
            leaving = true;
            setLeaveFor("/login");
            return;
          }
          auto.current.notBefore = Date.now() + AUTO_SIGN_IN_AFTER_FAILURE_MS;
          if (result.code === "captcha" && !told) return;
          setNotice({ kind: "error", text: pressText(result.code, captchaToken, flowMessage(result.code)) });
          return;
        }
        // Signed in: the password is not needed again.
        account.current = null;
        clearAutoTimer();
        if (result.key === "opened" || result.key === "made") {
          leaving = true;
          setLeaveFor(landingAfterSignIn(result.key, safeNextPath(null)));
          return;
        }
        setNotice({ kind: "key", text: result.key === "not_opened" ? LOGIN_MESSAGES.key_not_opened : flowMessage(result.code) });
      } finally {
        // After 「別のアドレスでやり直す」 the lock is the new screen's already. After a sign-in that
        // leaves the page, the press stays shown until the next page is drawn.
        if (epoch.current === mine) {
          pressedMeanwhile.current = false;
          if (!leaving) {
            setSigningIn(false);
            release();
          }
        }
      }
    },
    [release, spendToken, pressToken, clearAutoTimer, scheduleAuto, startOver],
  );

  useEffect(() => {
    queuedPress.current = () => void trySignIn("press", true);
    timedTry.current = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") void trySignIn("auto");
    };
  }, [trySignIn]);

  // No try waits past the screen: leaving it cancels the timer.
  useEffect(() => clearAutoTimer, [clearAutoTimer]);

  /**
   * 「別のアドレスでやり直す」: the address and the password let go, the form back, empty. While a
   * sign-in is in flight it waits for the answer (trySignIn acts on it).
   */
  function restart() {
    if (running.current === "signin" && inFlight.current) {
      restartAfter.current = true;
      setRestartPending(true);
      return;
    }
    startOver();
  }

  // The tab shown again: the person may have opened the link meanwhile. Hidden: no timer runs.
  // Shown all the time: the timer tries at the points of the backoff.
  useEffect(() => {
    if (!sentTo || typeof document === "undefined") return;
    const onReturn = () => {
      const a = auto.current;
      const now = Date.now();
      // The visibilitychange and the focus of one return are one try.
      if (now - a.lastReturnAt < AUTO_SIGN_IN_SAME_RETURN_MS) return;
      a.lastReturnAt = now;
      void trySignIn("auto");
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") onReturn();
      else clearAutoTimer();
    };
    const onFocus = () => {
      if (document.visibilityState === "visible") onReturn();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    scheduleAuto();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      clearAutoTimer();
    };
  }, [sentTo, trySignIn, scheduleAuto, clearAutoTimer]);

  // The toast goes after a while.
  useEffect(() => {
    if (!resent?.ok) return;
    const timer = setTimeout(() => setResent(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [resent]);

  const ticking = (task: Task) => needsTick && active === task;

  if (sentTo && notice?.kind === "key") {
    // Signed in, the key not opened or not made: the waiting is over. The key's words, the way on,
    // and where the key is made (設定's row of that name).
    return (
      <div role="status" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
        <p>{notice.text}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link href={safeNextPath(null)} className="rounded-lg border border-neutral-300 bg-white px-4 py-2 font-medium text-neutral-900">
            このまま進む
          </Link>
          <Link href="/app/settings/password" className="rounded-lg border border-neutral-300 bg-white px-4 py-2 font-medium text-neutral-900">
            パスワードとメールの鍵
          </Link>
        </div>
      </div>
    );
  }

  if (sentTo) {
    return (
      <>
        <h1 className="text-2xl font-bold">{CONFIRM_WAIT.title}</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">{CONFIRM_WAIT.body}</p>
        <p className="mt-1 break-all text-sm font-medium text-neutral-900">{sentTo}</p>
        <div className="mt-6 flex flex-col gap-3">
          <TurnstileWidget tokenRef={token} round={round} />
          <PendingButton pending={signingIn && !ticking("signin")} pendingLabel="ログインしています…" tone="light" onClick={() => void trySignIn("press")} className={primaryClass}>
            {signingIn && ticking("signin") ? TURNSTILE_TICK_PROMPT : CONFIRM_WAIT.done}
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
          <PendingButton pending={resending && !ticking("resend")} pendingLabel="送っています…" onClick={resend} className="flex items-center justify-center gap-2 self-center px-4 py-2 text-sm text-neutral-600 underline underline-offset-4">
            {resending && ticking("resend") ? TURNSTILE_TICK_PROMPT : CONFIRM_WAIT.resend}
          </PendingButton>
          {resent && !resent.ok ? <p role="alert" className="text-sm text-red-800">{resent.text}</p> : null}
          <PendingButton pending={restartPending} pendingLabel={CONFIRM_WAIT.restart} onClick={restart} className="flex items-center justify-center gap-2 self-center px-4 py-2 text-xs text-neutral-500 underline underline-offset-4">
            {CONFIRM_WAIT.restart}
          </PendingButton>
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
        <input id="signup-password" aria-describedby="signup-password-rule" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        <label className="text-sm font-medium" htmlFor="signup-password-again">
          パスワードをもう一度
        </label>
        <input id="signup-password-again" aria-describedby="signup-password-rule" type="password" required autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={inputClass} />
        <p id="signup-password-rule" className="text-xs leading-5 text-neutral-500">{PASSWORD_RULE}</p>
        <TurnstileWidget tokenRef={token} round={round} />
        <PendingSubmitButton pending={creating && !ticking("signup")} pendingLabel="作っています…" tone="light" className={submitClass}>
          {creating && ticking("signup") ? TURNSTILE_TICK_PROMPT : "アカウントを作る"}
        </PendingSubmitButton>
        {error ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {error}
          </p>
        ) : null}
      </form>
      <div className="mt-4 flex flex-wrap gap-x-6 text-sm">
        <Link href="/login" className="py-2 font-medium text-neutral-900 underline underline-offset-4">
          ログイン
        </Link>
      </div>
      <Link href="/privacy" className="mt-6 self-start py-2 text-xs text-neutral-500 underline underline-offset-4">
        プライバシーポリシー
      </Link>
    </>
  );
}
