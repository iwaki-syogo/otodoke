"use client";

import { useRef, useState } from "react";
import { PendingSubmitButton } from "@/components/pending-button";
import { LOGIN_MESSAGES, TURNSTILE_TICK_PROMPT, loginMessage } from "@/lib/login-errors";
import { isLoginAddress, normalizeLoginAddress } from "@/lib/login-form";
import { pressText, tokenForPress, type TokenField } from "@/lib/turnstile";
import { inputClass, submitClass } from "../form-style";
import { sendResetMail } from "../actions";
import { TurnstileWidget } from "../turnstile-widget";

/**
 * /login/forgot: the address, and the reset mail. The answer is the same whether the address has
 * an account or not (sendResetMail). The form is sent in code like the others: no named field.
 */
export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsTick, setNeedsTick] = useState(false);
  const [round, setRound] = useState(0);
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);
  const running = useRef(false);
  const token = useRef<TokenField>({ value: "", dataset: {} });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    if (!isLoginAddress(normalizeLoginAddress(email))) {
      setAnswer({ ok: false, text: LOGIN_MESSAGES.invalid_email });
      return;
    }
    running.current = true;
    setBusy(true);
    setAnswer(null);
    try {
      const captchaToken = await tokenForPress(token.current, { onNeedsTick: setNeedsTick });
      setNeedsTick(false);
      const result = await sendResetMail({ email, captchaToken }).catch(() => ({ ok: false as const, code: "network" as const }));
      setAnswer({ ok: result.ok, text: pressText(result.code, captchaToken, loginMessage(result.code)) });
    } finally {
      // The token went with the press (each is checked once): the next press waits for a new one.
      setRound((r) => r + 1);
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <form method="post" onSubmit={submit} className="mt-6 flex flex-col gap-3">
      <label className="text-sm font-medium" htmlFor="forgot-email">
        メールアドレス
      </label>
      <input id="forgot-email" type="email" required autoComplete="username" inputMode="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
      <TurnstileWidget tokenRef={token} round={round} />
      <PendingSubmitButton pending={busy && !needsTick} pendingLabel="送っています…" tone="light" className={submitClass}>
        {busy && needsTick ? TURNSTILE_TICK_PROMPT : "再設定のメールを送る"}
      </PendingSubmitButton>
      {answer ? (
        <p role={answer.ok ? "status" : "alert"} className={`rounded-lg border p-3 text-sm ${answer.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>
          {answer.text}
        </p>
      ) : null}
    </form>
  );
}
