"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { LeaveFor } from "@/components/leave-for";
import { PendingSubmitButton } from "@/components/pending-button";
import { flowMessage, signInAndOpenKey, type OpenWithAnother, type SignInPorts } from "@/lib/crypto/password-flows";
import { LOGIN_MESSAGES, TURNSTILE_TICK_PROMPT } from "@/lib/login-errors";
import { isLoginAddress, normalizeLoginAddress } from "@/lib/login-form";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { tokenForPress, type TokenField } from "@/lib/turnstile";
import { readMailKey, registerMailKey, activateMailKey, rewrapMailKey } from "@/app/app/settings/key-actions";
import { signInWithAuthSecret } from "./actions";
import { inputClass, submitClass } from "./form-style";
import { OtherPasswordForm } from "./other-password-form";
import { readSignedInAddress } from "./session-actions";
import { TurnstileWidget } from "./turnstile-widget";

/** The Actions a sign-in calls, read when a press needs them. */
const ports = (): SignInPorts => ({ signInWithAuthSecret, readSignedInAddress, readMailKey, registerMailKey, activateMailKey, rewrapMailKey });

/**
 * What the form says after a press. The sign-in went through but the key did not open
 * (`not_opened`: another password may open it) or could not be opened or made (`key_failed`); the
 * app can still be used.
 */
type Notice = { kind: "error"; text: string } | { kind: "not_opened"; openWithAnother: OpenWithAnother } | { kind: "key_failed"; text: string };

/**
 * /login: the address and the password. The press is shown at once (making master takes about a
 * second on a phone): the spinner and 「ログインしています…」 until the next page is drawn, or the
 * tick prompt while the bot check waits for it.
 *
 * No field has a `name` and the form is POST without an action: a press before the page's script
 * runs sends an empty body to this page, never the password (password-forms.test.ts). The
 * autocomplete hints let a password manager fill and keep both.
 */
export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsTick, setNeedsTick] = useState(false);
  const [round, setRound] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [leaveFor, setLeaveFor] = useState<string | null>(null);
  // A ref, not state: a second press (or Enter) can come before React has drawn the first.
  const running = useRef(false);
  const token = useRef<TokenField>({ value: "", dataset: {} });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    if (!isLoginAddress(normalizeLoginAddress(email))) {
      setNotice({ kind: "error", text: LOGIN_MESSAGES.invalid_email });
      return;
    }
    if (!password) return;
    running.current = true;
    setBusy(true);
    setNotice(null);
    let leaving = false;
    try {
      const captchaToken = await tokenForPress(token.current, { onNeedsTick: setNeedsTick });
      setNeedsTick(false);
      const result = await signInAndOpenKey({ email, password, captchaToken }, ports());
      if (!result.ok) {
        setNotice({ kind: "error", text: flowMessage(result.code) });
        return;
      }
      if (result.key === "opened" || result.key === "made") {
        leaving = true;
        setPassword("");
        setLeaveFor(next);
        return;
      }
      if (result.key === "not_opened") {
        setPassword("");
        setNotice({ kind: "not_opened", openWithAnother: result.openWithAnother });
      } else setNotice({ kind: "key_failed", text: flowMessage(result.code) });
    } finally {
      // The token went with the press (each is checked once): the next press waits for a new one.
      setRound((r) => r + 1);
      // After a sign-in that leaves the page, the press stays shown until the next page is drawn.
      if (!leaving) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <>
      <form method="post" onSubmit={submit} className="mt-6 flex flex-col gap-3">
        <label className="text-sm font-medium" htmlFor="login-email">
          メールアドレス
        </label>
        <input id="login-email" type="email" required autoComplete="username" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
        <label className="text-sm font-medium" htmlFor="login-password">
          パスワード
        </label>
        <input id="login-password" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
        <TurnstileWidget tokenRef={token} round={round} />
        <PendingSubmitButton pending={busy && !needsTick} pendingLabel="ログインしています…" tone="light" className={submitClass}>
          {busy && needsTick ? TURNSTILE_TICK_PROMPT : "ログイン"}
        </PendingSubmitButton>
        {notice?.kind === "error" ? (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
            {notice.text}
          </p>
        ) : null}
      </form>
      {notice?.kind === "not_opened" || notice?.kind === "key_failed" ? (
        <div role="status" className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          {notice.kind === "not_opened" ? (
            <>
              <p className="font-medium">{LOGIN_MESSAGES.key_not_opened}</p>
              <p className="mt-1">{RESET_LOSES_MAIL}</p>
              <div className="mt-3">
                {/* Too late for the wrap (or signed out meanwhile): the words go under the login above, which signs in again. */}
                <OtherPasswordForm email={email} openWithAnother={notice.openWithAnother} onOpened={() => setLeaveFor(next)} onLogInAgain={(code) => setNotice({ kind: "error", text: flowMessage(code) })} />
              </div>
            </>
          ) : (
            <p>{notice.text}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            {notice.kind === "not_opened" ? (
              <Link href="/login/forgot" className="rounded-lg bg-neutral-900 px-4 py-2 font-medium text-white">
                再設定する
              </Link>
            ) : null}
            <Link href={next} className="rounded-lg border border-neutral-300 bg-white px-4 py-2 font-medium text-neutral-900">
              このまま進む
            </Link>
          </div>
        </div>
      ) : null}
      {leaveFor ? <LeaveFor href={leaveFor} /> : null}
    </>
  );
}

