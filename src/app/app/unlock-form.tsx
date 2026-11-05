"use client";

import { useState } from "react";
import { keyErrorText, unlock } from "@/lib/crypto/tab-key";

/** Ask for the passphrase once; the key stays open in this tab (memory only). */
export function UnlockForm({ userId, label = "開く" }: { userId: string; label?: string }) {
  const [passphrase, setPassphrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !passphrase) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(userId, passphrase);
      setPassphrase("");
    } catch (err) {
      setError(keyErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      {/* Lets a password manager keep the passphrase under one name. */}
      <input type="text" name="username" autoComplete="username" value="Otodoke 合言葉" readOnly hidden />
      <div className="flex gap-2">
        <input
          type="password"
          name="passphrase"
          autoComplete="current-password"
          aria-label="合言葉"
          placeholder="合言葉"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base"
        />
        <button type="submit" disabled={busy || !passphrase} className="shrink-0 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">
          {busy ? "開いています…" : label}
        </button>
      </div>
      {error ? <p className="text-sm text-red-800">{error}</p> : null}
    </form>
  );
}
