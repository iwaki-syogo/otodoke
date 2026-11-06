"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { PendingButton, PendingSubmitButton } from "@/components/pending-button";
import { flowMessage, signUpWithPassword } from "@/lib/crypto/password-flows";
import { PASSWORD_RULE, passwordProblem } from "@/lib/crypto/password-v1";
import { LOGIN_MESSAGES, TURNSTILE_TICK_PROMPT, loginMessage } from "@/lib/login-errors";
import { isAsciiAddress, isLoginAddress, normalizeLoginAddress } from "@/lib/login-form";
import { tokenForPress, type TokenField } from "@/lib/turnstile";
import { inputClass, submitClass } from "@/app/login/form-style";
import { resendConfirmation, signUpWithAuthSecret } from "@/app/login/actions";
import { TurnstileWidget } from "@/app/login/turnstile-widget";

const PORTS = { signUpWithAuthSecret };

/**
 * /signup: the address and the password, twice. Only the login secret is sent; the key is made at
 * the first sign-in, after the confirmation link (decision 6). An address with characters outside
 * ASCII is refused here as on the server (decision 9). Once the mail is sent, the same screen says
 * so and offers 「送り直す」.
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
  const [resent, setResent] = useState<{ ok: boolean; text: string } | null>(null);
  const running = useRef(false);
  const token = useRef<TokenField>({ value: "", dataset: {} });

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
      const result = await signUpWithPassword({ email, password, captchaToken }, PORTS);
      setRound((r) => r + 1);
      if (!result.ok) {
        setError(flowMessage(result.code));
        return;
      }
      setPassword("");
      setAgain("");
      setSentTo(email);
    } finally {
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
      setRound((r) => r + 1);
      setResent({ ok: result.ok, text: loginMessage(result.code) });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="mt-6 flex flex-col gap-3">
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          {LOGIN_MESSAGES.signup_exists_or_sent}
        </p>
        <TurnstileWidget tokenRef={token} round={round} />
        <PendingButton pending={busy && !needsTick} pendingLabel="送っています…" onClick={resend} className="flex items-center justify-center gap-2 rounded-lg border border-neutral-300 bg-white px-4 py-3 text-base font-medium text-neutral-900">
          {busy && needsTick ? TURNSTILE_TICK_PROMPT : "送り直す"}
        </PendingButton>
        {resent ? <p className={`text-sm ${resent.ok ? "text-emerald-800" : "text-red-800"}`}>{resent.text}</p> : null}
        <Link href="/login" className="self-start text-sm text-neutral-600 underline underline-offset-4">
          ログイン
        </Link>
      </div>
    );
  }

  return (
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
  );
}
