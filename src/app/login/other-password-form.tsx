"use client";

import { useRef, useState } from "react";
import { PendingSubmitButton } from "@/components/pending-button";
import { flowMessage, type OpenWithAnother } from "@/lib/crypto/password-flows";
import { OPEN_WITH_ANOTHER_PASSWORD } from "@/lib/login-errors";

/**
 * After a sign-in whose password does not open the key in use (key_not_opened): a password that
 * opened it before, the new one of a change that stopped half-way say, opens it, and it is wrapped
 * again for the password that signed in (openWithAnother), so the next sign-in opens it. The reset
 * next to it would make a new key and lose the mail sealed before.
 *
 * 「ほかのパスワードで開く」 shows the field. Like every form that takes a password, no field has a
 * `name` and the form is POST without an action (password-forms.test.ts); the field is emptied
 * after each press. `email` names the account for a password manager.
 */
export function OtherPasswordForm({ email, openWithAnother, onOpened }: { email: string; openWithAnother: OpenWithAnother; onOpened: () => void }) {
  const [shown, setShown] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: a second press (or Enter) can come before React has drawn the first.
  const running = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current || !password) return;
    running.current = true;
    setBusy(true);
    setError(null);
    let opened = false;
    try {
      const result = await openWithAnother(password);
      setPassword("");
      if (result.ok) {
        opened = true;
        onOpened();
      } else setError(flowMessage(result.code));
    } finally {
      // Opened: the press stays shown until the next page is drawn, as the login's does.
      if (!opened) {
        running.current = false;
        setBusy(false);
      }
    }
  }

  if (!shown) {
    return (
      <button type="button" onClick={() => setShown(true)} className="rounded-lg border border-neutral-300 bg-white px-4 py-2 font-medium text-neutral-900">
        {OPEN_WITH_ANOTHER_PASSWORD}
      </button>
    );
  }

  return (
    <form method="post" onSubmit={submit} className="flex w-full flex-col gap-2">
      <input type="text" autoComplete="username" value={email} readOnly hidden />
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="current-password"
          aria-label="ほかのパスワード"
          placeholder="ほかのパスワード"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base"
        />
        <PendingSubmitButton pending={busy} pendingLabel="開いています…" tone="light" className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 font-medium text-white">
          開く
        </PendingSubmitButton>
      </div>
      {error ? (
        <p role="alert" className="text-red-800">
          {error}
        </p>
      ) : null}
    </form>
  );
}
