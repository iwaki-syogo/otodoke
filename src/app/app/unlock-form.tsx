"use client";

import { useRef, useState } from "react";
import { Spinner } from "@/components/spinner";
import { keyErrorText, unlock, unlockRetired } from "@/lib/crypto/tab-key";

/**
 * Ask for the passphrase once; the key stays open in this tab (memory only). With `retiredKeyId`,
 * it opens that retired key instead (mail sealed before the key was made again).
 */
export function UnlockForm({ userId, label = "開く", retiredKeyId }: { userId: string; label?: string; retiredKeyId?: string }) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set before anything is awaited: a second press (or Enter) meanwhile opens nothing more.
  const opening = useRef(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (opening.current || !passphrase) return;
    opening.current = true;
    setBusy(true);
    setError(null);
    try {
      if (retiredKeyId) await unlockRetired(userId, retiredKeyId, passphrase);
      else await unlock(userId, passphrase);
      setPassphrase("");
    } catch (err) {
      setError(keyErrorText(err));
    } finally {
      opening.current = false;
      setBusy(false);
    }
  }

  return (
    // No field has a `name` and the method is POST: a press before the page's script runs (or
    // when it fails to load) sends nothing, never the passphrase in a URL (passphrase-forms.test.ts).
    <form method="post" onSubmit={submit} className="flex flex-col gap-2">
      {/* Lets a password manager keep the passphrase under one name. */}
      <input type="text" autoComplete="username" value="Otodoke 合言葉" readOnly hidden />
      <div className="flex gap-2">
        <input
          type="password"
          autoComplete="current-password"
          aria-label={retiredKeyId ? "前の合言葉" : "合言葉"}
          placeholder={retiredKeyId ? "前の合言葉" : "合言葉"}
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base"
        />
        <button
          type="submit"
          disabled={busy || !passphrase}
          aria-busy={busy || undefined}
          className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
        >
          {busy ? (
            <>
              <Spinner tone="light" />
              開いています…
            </>
          ) : (
            label
          )}
        </button>
      </div>
      {error ? <p className="text-sm text-red-800">{error}</p> : null}
    </form>
  );
}
