"use client";

/**
 * The opened keys, kept for this tab only: a module variable in memory. Never written to
 * localStorage, sessionStorage or IndexedDB, never sent anywhere. Closing or reloading the tab
 * forgets them; the passphrase is asked again then.
 *
 * The wrapped keys come from Server Actions (src/app/app/settings/key-actions.ts). This module has
 * no Supabase client: none is shipped to the browser (src/lib/__tests__/no-browser-supabase.test.ts).
 *
 * Besides the key in use, the tab keeps any retired key the user opened, so mail sealed before a
 * key was made again still opens (a key replaced by mistake from a stale screen loses nothing).
 */
import { useSyncExternalStore } from "react";
import { equalBytes, toBase64 } from "./bytes";
import { challengeAad, openBytes, type PrivateRecipient } from "./envelope";
import { KEY_IN_USE_CHANGED, KEY_WRAP_CHANGED } from "./key-messages";
import { createKeyPair, openStoredKey, unwrapPrivateKeyBytes, wrapPrivateKey, type StoredKey } from "./key-wrap";
import { activateMailKey, readMailKey, readRetiredMailKeys, registerMailKey, rewrapMailKey } from "@/app/app/settings/key-actions";

interface TabKeys {
  userId: string;
  /** The key in use, opened. */
  current: PrivateRecipient | null;
  /** Retired keys opened in this tab, by key id. */
  retired: Readonly<Record<string, PrivateRecipient>>;
}

const NO_RETIRED: Readonly<Record<string, PrivateRecipient>> = Object.freeze({});

let state: TabKeys | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: TabKeys | null) {
  state = next;
  for (const l of listeners) l();
}

function useTabKeys(): TabKeys | null {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => null,
  );
}

/** The key in use, opened in this tab for this user, or null. */
export function useTabKey(userId: string): PrivateRecipient | null {
  const k = useTabKeys();
  return k && k.userId === userId ? k.current : null;
}

/** Retired keys opened in this tab for this user, by key id. */
export function useRetiredTabKeys(userId: string): Readonly<Record<string, PrivateRecipient>> {
  const k = useTabKeys();
  return k && k.userId === userId ? k.retired : NO_RETIRED;
}

export function forgetTabKey() {
  setState(null);
}

function setCurrent(userId: string, current: PrivateRecipient, retired: Readonly<Record<string, PrivateRecipient>> = state?.userId === userId ? state.retired : NO_RETIRED) {
  setState({ userId, current, retired });
}

function addRetired(userId: string, recipients: PrivateRecipient[]) {
  if (recipients.length === 0) return;
  const base = state && state.userId === userId ? state : { userId, current: null, retired: NO_RETIRED };
  setState({ ...base, retired: { ...base.retired, ...Object.fromEntries(recipients.map((r) => [r.keyId, r])) } });
}

/** The key in use (keyId null) or one by id, through the Server Action. */
async function readKey(keyId: string | null): Promise<StoredKey | null> {
  const res = await readMailKey({ keyId });
  if (!res.ok) throw new Error("read failed");
  return res.key;
}

/**
 * The new wrap was saved but could not be read back and opened. The change most likely went
 * through, so it must not be told as a failure (the user would retry with the old passphrase).
 */
export class PassphraseChangeUnconfirmedError extends Error {
  constructor() {
    super("passphrase change saved but not confirmed");
    this.name = "PassphraseChangeUnconfirmedError";
  }
}

/** Words for the screen. A failed decryption almost always means a mistyped passphrase. */
export function keyErrorText(err: unknown): string {
  if (err instanceof PassphraseChangeUnconfirmedError) return "変わったはずですが、確かめられませんでした。ページを読み込み直して、新しい合言葉で開けるか確かめてください";
  if (err instanceof Error && err.name === "OperationError") return "合言葉が違います";
  if (err instanceof Error && err.message === "no key") return "合言葉がまだありません。設定で決めてください";
  if (err instanceof Error && err.message === KEY_IN_USE_CHANGED) return "ほかの画面で合言葉が決まっていました。何も変えていません。ページを読み込み直してください";
  if (err instanceof Error && err.message === KEY_WRAP_CHANGED) return "ほかの画面で合言葉が変わっていました。何も変えていません。ページを読み込み直してください";
  return "うまくいきませんでした。もう一度試してください";
}

/**
 * Open the key in use with the passphrase, for this tab. The same passphrase is then tried on the
 * newest retired keys too (quietly: a passphrase that does not open them is the normal case).
 */
export async function unlock(userId: string, passphrase: string): Promise<void> {
  const stored = await readKey(null);
  if (!stored) throw new Error("no key");
  setCurrent(userId, await openStoredKey(stored, passphrase, userId));
  try {
    const res = await readRetiredMailKeys();
    if (!res.ok) return;
    const opened: PrivateRecipient[] = [];
    for (const k of res.keys) {
      try {
        opened.push(await openStoredKey(k, passphrase, userId));
      } catch {
        // Another passphrase: it can still be opened from the mail itself (unlockRetired).
      }
    }
    addRetired(userId, opened);
  } catch {
    // The key in use is open; old mail can still be opened one by one.
  }
}

/** Open one retired key (mail sealed before the key was made again) with the passphrase it had. */
export async function unlockRetired(userId: string, keyId: string, passphrase: string): Promise<void> {
  const stored = await readKey(keyId);
  if (!stored || stored.key_id !== keyId) throw new Error("read failed");
  addRetired(userId, [await openStoredKey(stored, passphrase, userId)]);
}

/**
 * Make a key pair, register it, and put it in use only after proving, from the copy the
 * database holds, that the passphrase opens it and that it is the pair of the stored public key.
 * Used both for the first passphrase and for a forgotten one (the old key is retired then).
 * `expectedCurrentKeyId` is the key in use the screen was drawn with (null: none): the server
 * refuses when another tab or device has made one since.
 */
export async function createMailKey(userId: string, passphrase: string, expectedCurrentKeyId: string | null): Promise<void> {
  const pair = await createKeyPair();
  const wrapped = await wrapPrivateKey(pair.pkcs8, passphrase, userId);
  pair.pkcs8.fill(0);
  const reg = await registerMailKey({
    publicKey: toBase64(pair.publicKey),
    wrappedPrivateKey: wrapped.wrapped_private_key,
    wrapIv: wrapped.wrap_iv,
    kdfSalt: wrapped.kdf_salt,
    kdfIterations: wrapped.kdf_iterations,
    expectedCurrentKeyId,
  });
  if (!reg.ok) throw new Error(reg.error);
  if (reg.keyId !== pair.keyId) throw new Error("key id mismatch");

  const stored = await readKey(reg.keyId);
  if (!stored || stored.public_key !== toBase64(pair.publicKey) || stored.wrapped_private_key !== wrapped.wrapped_private_key) throw new Error("stored key differs");
  const recipient = await openStoredKey(stored, passphrase, userId);
  const challenge = await openBytes(recipient, challengeAad(userId, reg.keyId), reg.challenge);
  const done = await activateMailKey({ keyId: reg.keyId, challenge: toBase64(challenge), expectedCurrentKeyId });
  if (!done.ok) throw new Error(done.error);
  // The key that was in use (if this tab had it open) now opens the mail sealed before.
  const previous = state?.userId === userId ? state.current : null;
  setCurrent(userId, recipient, { ...(state?.userId === userId ? state.retired : NO_RETIRED), ...(previous ? { [previous.keyId]: previous } : {}) });
}

/** Wrap the same private key with a new passphrase. Old mail stays readable. */
export async function changePassphrase(userId: string, oldPassphrase: string, newPassphrase: string): Promise<void> {
  const stored = await readKey(null);
  if (!stored) throw new Error("no key");
  await openStoredKey(stored, oldPassphrase, userId); // the old passphrase, and the pair, are right
  const pkcs8 = await unwrapPrivateKeyBytes(stored, oldPassphrase, userId);
  const wrapped = await wrapPrivateKey(pkcs8, newPassphrase, userId);
  const check = await unwrapPrivateKeyBytes(wrapped, newPassphrase, userId);
  const same = equalBytes(check, pkcs8);
  pkcs8.fill(0);
  check.fill(0);
  if (!same) throw new Error("rewrap check failed");
  const res = await rewrapMailKey({
    keyId: stored.key_id,
    previousWrappedPrivateKey: stored.wrapped_private_key,
    wrappedPrivateKey: wrapped.wrapped_private_key,
    wrapIv: wrapped.wrap_iv,
    kdfSalt: wrapped.kdf_salt,
    kdfIterations: wrapped.kdf_iterations,
  });
  if (!res.ok) throw new Error(res.error);
  // Saved. What follows only confirms it: a failure from here on is not "nothing changed".
  try {
    const back = await readKey(null);
    if (!back || back.key_id !== stored.key_id || back.wrapped_private_key !== wrapped.wrapped_private_key) throw new Error("stored key differs");
    setCurrent(userId, await openStoredKey(back, newPassphrase, userId));
  } catch {
    throw new PassphraseChangeUnconfirmedError();
  }
}
