"use client";

/**
 * The opened key, kept for this tab only: a module variable in memory. Never written to
 * localStorage, sessionStorage or IndexedDB, never sent anywhere. Closing or reloading the tab
 * forgets it; the passphrase is asked again then.
 */
import { useSyncExternalStore } from "react";
import { createClient } from "@/lib/supabase/client";
import { equalBytes, toBase64 } from "./bytes";
import { challengeAad, openBytes, type PrivateRecipient } from "./envelope";
import { createKeyPair, openStoredKey, unwrapPrivateKeyBytes, wrapPrivateKey, type StoredKey } from "./key-wrap";
import { activateMailKey, registerMailKey, rewrapMailKey } from "@/app/app/settings/key-actions";

interface TabKey {
  userId: string;
  recipient: PrivateRecipient;
}

let current: TabKey | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setTabKey(next: TabKey | null) {
  current = next;
  for (const l of listeners) l();
}

/** The key opened in this tab for this user, or null. */
export function useTabKey(userId: string): PrivateRecipient | null {
  const k = useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
  return k && k.userId === userId ? k.recipient : null;
}

export function forgetTabKey() {
  setTabKey(null);
}

const KEY_COLUMNS = "key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations";

/** The key in use, read with the user's own session (RLS: owner only). */
async function readCurrentKey(): Promise<StoredKey | null> {
  const { data, error } = await createClient().from("user_keys").select(KEY_COLUMNS).not("activated_at", "is", null).is("retired_at", null).maybeSingle();
  if (error) throw new Error("read failed");
  return data;
}

async function readKey(keyId: string): Promise<StoredKey | null> {
  const { data, error } = await createClient().from("user_keys").select(KEY_COLUMNS).eq("key_id", keyId).maybeSingle();
  if (error) throw new Error("read failed");
  return data;
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
  return "うまくいきませんでした。もう一度試してください";
}

/** Open the key in use with the passphrase, for this tab. */
export async function unlock(userId: string, passphrase: string): Promise<void> {
  const stored = await readCurrentKey();
  if (!stored) throw new Error("no key");
  setTabKey({ userId, recipient: await openStoredKey(stored, passphrase, userId) });
}

/**
 * Make a key pair, register it, and put it in use only after proving, from the copy the
 * database holds, that the passphrase opens it and that it is the pair of the stored public key.
 * Used both for the first passphrase and for a forgotten one (the old key is retired then).
 */
export async function createMailKey(userId: string, passphrase: string): Promise<void> {
  const pair = await createKeyPair();
  const wrapped = await wrapPrivateKey(pair.pkcs8, passphrase, userId);
  pair.pkcs8.fill(0);
  const reg = await registerMailKey({
    publicKey: toBase64(pair.publicKey),
    wrappedPrivateKey: wrapped.wrapped_private_key,
    wrapIv: wrapped.wrap_iv,
    kdfSalt: wrapped.kdf_salt,
    kdfIterations: wrapped.kdf_iterations,
  });
  if (!reg.ok) throw new Error(reg.error);
  if (reg.keyId !== pair.keyId) throw new Error("key id mismatch");

  const stored = await readKey(reg.keyId);
  if (!stored || stored.public_key !== toBase64(pair.publicKey) || stored.wrapped_private_key !== wrapped.wrapped_private_key) throw new Error("stored key differs");
  const recipient = await openStoredKey(stored, passphrase, userId);
  const challenge = await openBytes(recipient, challengeAad(userId, reg.keyId), reg.challenge);
  const done = await activateMailKey({ keyId: reg.keyId, challenge: toBase64(challenge) });
  if (!done.ok) throw new Error(done.error);
  setTabKey({ userId, recipient });
}

/** Wrap the same private key with a new passphrase. Old mail stays readable. */
export async function changePassphrase(userId: string, oldPassphrase: string, newPassphrase: string): Promise<void> {
  const stored = await readCurrentKey();
  if (!stored) throw new Error("no key");
  await openStoredKey(stored, oldPassphrase, userId); // the old passphrase, and the pair, are right
  const pkcs8 = await unwrapPrivateKeyBytes(stored, oldPassphrase, userId);
  const wrapped = await wrapPrivateKey(pkcs8, newPassphrase, userId);
  const check = await unwrapPrivateKeyBytes(wrapped, newPassphrase, userId);
  const same = equalBytes(check, pkcs8);
  pkcs8.fill(0);
  check.fill(0);
  if (!same) throw new Error("rewrap check failed");
  const res = await rewrapMailKey({ keyId: stored.key_id, wrappedPrivateKey: wrapped.wrapped_private_key, wrapIv: wrapped.wrap_iv, kdfSalt: wrapped.kdf_salt, kdfIterations: wrapped.kdf_iterations });
  if (!res.ok) throw new Error(res.error);
  // Saved. What follows only confirms it: a failure from here on is not "nothing changed".
  try {
    const back = await readCurrentKey();
    if (!back || back.key_id !== stored.key_id || back.wrapped_private_key !== wrapped.wrapped_private_key) throw new Error("stored key differs");
    setTabKey({ userId, recipient: await openStoredKey(back, newPassphrase, userId) });
  } catch {
    throw new PassphraseChangeUnconfirmedError();
  }
}
