"use client";

/**
 * The opened key, kept for this tab only: a module variable in memory. Never written to
 * localStorage, sessionStorage, IndexedDB or a cookie, never sent anywhere.
 *
 * Only the opened private key is kept (a CryptoKey that cannot be exported), with the user it was
 * opened for: never the password, master, the login secret or a KEK (src/lib/crypto/password-flows.ts
 * opens it and hands it here). It goes:
 *  - when the tab is closed or reloaded (the password is asked again then: openKeyAgain);
 *  - at the logout, a native POST to /auth/signout that leaves the page;
 *  - at a sign-in or a reset in this tab, which forget it first;
 *  - for another account: useTabKey answers only for the user it was opened for.
 *
 * Mail sealed to a retired key (before a reset, or before password-v1) does not open: no retired
 * key is kept or asked for. This module has no Supabase client: none is shipped to the browser
 * (src/lib/__tests__/no-browser-supabase.test.ts). tab-key-memory.test.ts tests all of this.
 */
import { useSyncExternalStore } from "react";
import type { PrivateRecipient } from "./envelope";

interface TabKey {
  userId: string;
  /** The key in use, opened. */
  key: PrivateRecipient;
}

let state: TabKey | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: TabKey | null) {
  state = next;
  for (const l of listeners) l();
}

/** The key in use, opened in this tab for this user, or null. */
export function useTabKey(userId: string): PrivateRecipient | null {
  const k = useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
  return k && k.userId === userId ? k.key : null;
}

export function forgetTabKey() {
  setState(null);
}

/** Keep `key`, opened by password-flows.ts, as the key in use of `userId` for this tab. */
export function setTabKey(userId: string, key: PrivateRecipient) {
  setState({ userId, key });
}
