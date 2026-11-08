"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { PendingSubmitButton } from "@/components/pending-button";
import { changePassword, flowMessage, signInAndOpenKey, type FlowCode, type OpenWithAnother } from "@/lib/crypto/password-flows";
import { PASSWORD_RULE, passwordProblem } from "@/lib/crypto/password-v1";
import { useTabKey } from "@/lib/crypto/tab-key";
import { LOGIN_MESSAGES, TURNSTILE_TICK_PROMPT } from "@/lib/login-errors";
import { PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { pressText, tokenForPress, type TokenField } from "@/lib/turnstile";
import { signInWithAuthSecret } from "@/app/login/actions";
import { readSignedInAddress } from "@/app/login/session-actions";
import { OtherPasswordForm } from "@/app/login/other-password-form";
import { TurnstileWidget } from "@/app/login/turnstile-widget";
import { UnlockForm } from "../unlock-form";
import { activateMailKey, readMailKey, registerMailKey, rewrapMailKey } from "./key-actions";
import { changeLoginSecret } from "./password-actions";

export interface PasswordPanelState {
  userId: string;
  /** The session's address: master is made from it after the login. */
  email: string;
  /** When the key in use was made, or null when there is none. */
  keyCreatedAt: string | null;
  /** Mail sealed to a key that is no longer in use (a reset, or a key from before password-v1). */
  oldKeyCount: number;
}

/** Codes after which this page cannot go on: the way on is to log in again. */
const LOG_IN_AGAIN: ReadonlySet<FlowCode> = new Set(["stale_session", "signed_out"]);

const input = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base";
const primary = "inline-flex items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white";

/**
 * 設定's パスワード (password-v1): the key that opens the stored mail, opened with the login password.
 * - With a key: whether it is open in this tab (and the password to open it again), changing the
 *   password (the same key wrapped again: the mail stays readable), and the reset when it is
 *   forgotten (a new key: the mail sealed before no longer opens).
 * - Without one (a sign-in whose key could not be made, or a session from the time of the mail's
 *   link): the password makes it, after signing in with it once more, which also proves it is the
 *   login password. Those who never set one do it from 「パスワードを忘れた」 (decision 7).
 *
 * Every form that takes a password has no named field and posts nothing (password-forms.test.ts).
 */
export function PasswordPanel({ state }: { state: PasswordPanelState }) {
  const { userId, email, keyCreatedAt, oldKeyCount } = state;
  const opened = useTabKey(userId);

  if (!keyCreatedAt) {
    return (
      <section className="rounded-2xl border border-sky-300 bg-sky-50 p-4">
        <h2 className="text-base font-bold">メールの鍵を作る</h2>
        <p className="mt-1 text-sm leading-6">読み取った後のメールの件名・差出人・本文は、あなたのパスワードでしか開けない形で保存します。</p>
        <p className="mt-2 text-sm leading-6">{PLAINTEXT_DROP_NOTICE}</p>
        <MakeKeyForm email={email} />
        <p className="mt-3 text-sm leading-6 text-neutral-700">
          パスワードをまだ決めていない場合は、
          <Link href="/login/forgot" className="font-medium underline underline-offset-4">
            パスワードを忘れた
          </Link>
          から決めてください。
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-bold">パスワード</h2>
      {oldKeyCount > 0 ? <p className="text-sm leading-6 text-neutral-600">前の鍵で暗号化したメールが {oldKeyCount} 通あります。開けませんが、荷物は残っています。</p> : null}
      <div className="rounded-2xl border border-neutral-200 bg-white p-4">
        {opened ? (
          <p className="text-sm">このタブではメールを開けます。タブを閉じると忘れます。</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-neutral-600">元メールを見るときに使います。</p>
            <UnlockForm userId={userId} email={email} />
          </>
        )}
      </div>
      <ChangeDetails userId={userId} email={email} />
      <details className="rounded-2xl border border-neutral-200 bg-white">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">パスワードを忘れたとき</summary>
        <div className="border-t border-neutral-100 p-4 text-sm leading-6">
          <p>{RESET_LOSES_MAIL}</p>
          <Link href="/login/forgot" className="mt-3 inline-block rounded-lg border border-neutral-300 px-4 py-2 font-medium">
            再設定のメールを送る
          </Link>
        </div>
      </details>
    </section>
  );
}

/** The way on after stale_session or signed_out: the login, back to 設定. */
function LogInAgain() {
  return (
    <Link href="/login?next=%2Fapp%2Fsettings%2Fpassword" className="mt-1 inline-block font-medium underline underline-offset-4">
      ログイン
    </Link>
  );
}

/**
 * For a user with no key: the password, checked by signing in with it, then the first key.
 * Exported for its tests (captcha-enforced-forms.test.ts), like ChangeForm.
 */
export function MakeKeyForm({ email }: { email: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsTick, setNeedsTick] = useState(false);
  const [round, setRound] = useState(0);
  // `openWithAnother`: the key in use (made in another tab meanwhile) does not open with this password.
  const [error, setError] = useState<{ text: string; logIn: boolean; openWithAnother?: OpenWithAnother } | null>(null);
  // A ref, not state: a second press (or Enter) can come before React has drawn the first.
  const running = useRef(false);
  const token = useRef<TokenField>({ value: "", dataset: {} });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current || !password) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const captchaToken = await tokenForPress(token.current, { onNeedsTick: setNeedsTick, onStale: () => setRound((r) => r + 1) });
      setNeedsTick(false);
      const result = await signInAndOpenKey({ email, password, captchaToken }, { signInWithAuthSecret, readSignedInAddress, readMailKey, registerMailKey, activateMailKey, rewrapMailKey });
      if (!result.ok) {
        // The address is the session's: a refused sign-in can only be the password.
        const code = result.code === "credentials" ? "wrong_password" : result.code;
        setError({ text: pressText(code, captchaToken, flowMessage(code)), logIn: LOG_IN_AGAIN.has(code) });
        return;
      }
      if (result.key === "opened" || result.key === "made") {
        setPassword("");
        router.refresh();
        return;
      }
      if (result.key === "not_opened") {
        setPassword("");
        setError({ text: RESET_LOSES_MAIL, logIn: false, openWithAnother: result.openWithAnother });
      } else setError({ text: flowMessage(result.code), logIn: LOG_IN_AGAIN.has(result.code) });
    } finally {
      // The token went with the press (each is checked once): the next press waits for a new one.
      setRound((r) => r + 1);
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      {/* No `name` on any field, POST: submitted before the script runs, it sends nothing. */}
      <form method="post" onSubmit={submit} className="mt-3 flex flex-col gap-2">
        <input type="text" autoComplete="username" value={email} readOnly hidden />
        <input type="password" autoComplete="current-password" aria-label="パスワード" placeholder="パスワード" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        <TurnstileWidget tokenRef={token} round={round} />
        <PendingSubmitButton pending={busy && !needsTick} pendingLabel="作っています…" tone="light" className={primary}>
          {busy && needsTick ? TURNSTILE_TICK_PROMPT : "鍵を作る"}
        </PendingSubmitButton>
      </form>
      {/* Below the form, not in it: 「ほかのパスワードで開く」 is a form of its own. */}
      {error ? (
        <div role="alert" className="mt-2 text-sm leading-6 text-red-800">
          {error.openWithAnother ? <p className="font-medium">{LOGIN_MESSAGES.key_not_opened}</p> : null}
          <p>{error.text}</p>
          {error.logIn ? <LogInAgain /> : null}
          {error.openWithAnother ? (
            <>
              <div className="mt-2">
                <OtherPasswordForm openWithAnother={error.openWithAnother} onOpened={() => router.refresh()} onLogInAgain={(code) => setError({ text: flowMessage(code), logIn: true })} />
              </div>
              <Link href="/login/forgot" className="mt-1 inline-block font-medium underline underline-offset-4">
                再設定する
              </Link>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

/**
 * 「パスワードを変える」: the bot check is drawn only once it is opened. Its token goes with the
 * change: changeLoginSecret checks the current password with a sign-in, which Supabase refuses
 * without one once CAPTCHA is enforced.
 *
 * `open` follows the element: the toggle event says when it is opened, and the effect reads it once
 * when the page is hydrated, because a details opened before React attached its handlers
 * (a slow phone) has fired its toggle already and would otherwise stay "closed" here, with no bot
 * check drawn and a form that can be pressed.
 * The hook and ChangeDetails are exported for their tests (password-panel-forms.test.ts).
 */
export function useDetailsOpen() {
  const [open, setOpen] = useState(false);
  const element = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (element.current) setOpen(element.current.open);
  }, []);
  return { open, element, onToggle: (e: { currentTarget: { open: boolean } }) => setOpen(e.currentTarget.open) };
}

export function ChangeDetails({ userId, email }: { userId: string; email: string }) {
  const { open, element, onToggle } = useDetailsOpen();
  return (
    <details ref={element} className="rounded-2xl border border-neutral-200 bg-white" onToggle={onToggle}>
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">パスワードを変える</summary>
      <div className="border-t border-neutral-100 p-4">
        <ChangeForm userId={userId} email={email} withCheck={open} />
      </div>
    </details>
  );
}

export function ChangeForm({ userId, email, withCheck }: { userId: string; email: string; withCheck: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsTick, setNeedsTick] = useState(false);
  const [round, setRound] = useState(0);
  const [message, setMessage] = useState<{ ok: boolean; text: string; logIn: boolean } | null>(null);
  const running = useRef(false);
  const token = useRef<TokenField>({ value: "", dataset: {} });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current || !current) return;
    const problem = passwordProblem(next, again);
    if (problem) {
      setMessage({ ok: false, text: problem, logIn: false });
      return;
    }
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const captchaToken = await tokenForPress(token.current, { onNeedsTick: setNeedsTick, onStale: () => setRound((r) => r + 1) });
      setNeedsTick(false);
      const result = await changePassword({ email, userId, current, next, captchaToken }, { readMailKey, changeLoginSecret });
      if (result.ok || result.code === "secret_change_unknown") {
        // Changed, or most likely: the current password may no longer be the one, so it goes too.
        setCurrent("");
        setNext("");
        setAgain("");
      }
      setMessage(result.ok ? { ok: true, text: "変えました。前のメールも新しいパスワードで開けます。", logIn: false } : { ok: false, text: pressText(result.code, captchaToken, flowMessage(result.code)), logIn: LOG_IN_AGAIN.has(result.code) });
    } finally {
      // The token went with the press (each is checked once): the next press waits for a new one.
      setRound((r) => r + 1);
      running.current = false;
      setBusy(false);
    }
  }

  return (
    // No `name` on any field, POST: submitted before the script runs, it sends nothing.
    <form method="post" onSubmit={submit} className="flex flex-col gap-2">
      <input type="text" autoComplete="username" value={email} readOnly hidden />
      <input type="password" autoComplete="current-password" aria-label="今のパスワード" placeholder="今のパスワード" value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" aria-label="新しいパスワード" aria-describedby="settings-password-rule" placeholder="新しいパスワード" value={next} onChange={(e) => setNext(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" aria-label="新しいパスワードをもう一度" aria-describedby="settings-password-rule" placeholder="もう一度" value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
      <p id="settings-password-rule" className="text-sm leading-5 text-neutral-600">{PASSWORD_RULE}</p>
      {withCheck ? <TurnstileWidget tokenRef={token} round={round} /> : null}
      <PendingSubmitButton pending={busy && !needsTick} pendingLabel="変えています…" tone="light" className={primary}>
        {busy && needsTick ? TURNSTILE_TICK_PROMPT : "変える"}
      </PendingSubmitButton>
      {message ? (
        <div className={`text-sm leading-6 ${message.ok ? "text-emerald-800" : "text-red-800"}`}>
          <p>{message.text}</p>
          {message.logIn ? <LogInAgain /> : null}
        </div>
      ) : null}
    </form>
  );
}
