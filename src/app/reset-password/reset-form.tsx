"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { LeaveFor } from "@/components/leave-for";
import { PendingSubmitButton } from "@/components/pending-button";
import { finishPasswordReset, flowMessage, type FlowCode, type ResetPorts } from "@/lib/crypto/password-flows";
import { PASSWORD_RULE, passwordProblem } from "@/lib/crypto/password-v1";
import { inputClass, submitClass } from "@/app/login/form-style";
import { readMailKey, registerMailKey } from "@/app/app/settings/key-actions";
import { finishReset } from "./actions";

/** The Actions a reset calls, read when a press needs them. */
const ports = (): ResetPorts => ({ readMailKey, registerMailKey, finishReset });

/**
 * A reset that cannot go on from this page: the mail's link has to be opened again. A session too
 * old for the key steps comes as reset_expired (finishPasswordReset never answers stale_session).
 */
const NEEDS_NEW_LINK: ReadonlySet<FlowCode> = new Set(["reset_expired", "signed_out"]);

/**
 * /reset-password, on the session a reset link made: the new password twice, then a new key for
 * it and the new login secret (finishPasswordReset). The address is the session's (`email`), kept
 * for a password manager in a hidden field that has no name either.
 *
 * When it did not go through (the key was not put in use, Supabase did not answer), the same press
 * runs it again: 「もう一度試す」. When the session is too old for it, the way back is a new mail.
 */
export function ResetForm({ email, userId }: { email: string; userId: string }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; newLink: boolean } | null>(null);
  const [tried, setTried] = useState(false);
  const [leaveFor, setLeaveFor] = useState<string | null>(null);
  const running = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    const problem = passwordProblem(password, again);
    if (problem) {
      setError({ text: problem, newLink: false });
      return;
    }
    running.current = true;
    setBusy(true);
    setError(null);
    let leaving = false;
    try {
      const result = await finishPasswordReset({ email, userId, password }, ports());
      if (result.ok) {
        leaving = true;
        setPassword("");
        setAgain("");
        setLeaveFor("/app");
        return;
      }
      setTried(true);
      setError({ text: flowMessage(result.code), newLink: NEEDS_NEW_LINK.has(result.code) });
    } finally {
      if (!leaving) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <form method="post" onSubmit={submit} className="mt-6 flex flex-col gap-3">
      <input type="text" autoComplete="username" value={email} readOnly hidden />
      <label className="text-sm font-medium" htmlFor="reset-password">
        新しいパスワード
      </label>
      <input id="reset-password" aria-describedby="reset-password-rule" type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
      <label className="text-sm font-medium" htmlFor="reset-password-again">
        新しいパスワードをもう一度
      </label>
      <input id="reset-password-again" aria-describedby="reset-password-rule" type="password" required autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} className={inputClass} />
      <p id="reset-password-rule" className="text-sm leading-5 text-neutral-600">{PASSWORD_RULE}</p>
      {error?.newLink ? null : (
        <PendingSubmitButton pending={busy} pendingLabel="再設定しています…" tone="light" className={submitClass}>
          {tried ? "もう一度試す" : "再設定する"}
        </PendingSubmitButton>
      )}
      {error ? (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          <p>{error.text}</p>
          {error.newLink ? (
            <Link href="/login/forgot" className="mt-2 inline-block font-medium underline underline-offset-4">
              再設定のメールを送る
            </Link>
          ) : null}
        </div>
      ) : null}
      {leaveFor ? <LeaveFor href={leaveFor} /> : null}
    </form>
  );
}
