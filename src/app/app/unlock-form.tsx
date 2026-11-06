"use client";

import { useRef, useState } from "react";
import { Spinner } from "@/components/spinner";
import { flowMessage, openKeyAgain } from "@/lib/crypto/password-flows";
import { readMailKey } from "@/app/app/settings/key-actions";

/**
 * Ask for the password once; the key stays open in this tab (memory only, src/lib/crypto/tab-key.ts).
 * `email` is the session's address (the server page hands it down): with the password it makes the
 * KEK again (openKeyAgain). Supabase Auth is not asked.
 */
export function UnlockForm({ userId, email }: { userId: string; email: string }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set before anything is awaited: a second press (or Enter) meanwhile opens nothing more.
  const opening = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (opening.current || !password) return;
    opening.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await openKeyAgain({ email, password, userId }, { readMailKey });
      if (result.ok) setPassword("");
      else setError(flowMessage(result.code));
    } finally {
      opening.current = false;
      setBusy(false);
    }
  }

  return (
    // No field has a `name` and the method is POST: a press before the page's script runs (or
    // when it fails to load) sends nothing, never the password in a URL (password-forms.test.ts).
    <form method="post" onSubmit={submit} className="flex flex-col gap-2">
      {/* The account's address, so a password manager fills the password it keeps for it. */}
      <input type="text" autoComplete="username" value={email} readOnly hidden />
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="current-password"
          aria-label="パスワード"
          placeholder="パスワード"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base"
        />
        <button
          type="submit"
          disabled={busy || !password}
          aria-busy={busy || undefined}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? (
            <>
              <Spinner tone="light" />
              開いています…
            </>
          ) : (
            "開く"
          )}
        </button>
      </div>
      {error ? <p className="text-sm text-red-800">{error}</p> : null}
    </form>
  );
}
