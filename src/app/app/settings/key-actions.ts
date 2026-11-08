"use server";

import { revalidatePath } from "next/cache";
import {
  activateKey,
  readRetiredKeys,
  readSealedEnvelope,
  readStoredKey,
  registerKey,
  rewrapKey,
  type KeyActivation,
  type KeyRead,
  type KeyRegistration,
  type KeyResult,
  type KeyRewrap,
  type SealedMailRead,
  type StoredKeyColumns,
} from "@/lib/mail-keys";
import { freshCookieSession, type FreshCheck } from "@/lib/auth-session";
import type { EnvelopeV1 } from "@/lib/crypto/envelope";
import type { Json } from "@/lib/db/database.types";
import { KEY_SESSION_STALE } from "@/lib/login-errors";
import { scheduleSealRemaining } from "@/lib/seal-later";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getUser } from "@/lib/supabase/server";

/*
 * The key steps of 設定, and the reads the browser needs to open its mail. Each takes only wrapped
 * keys and public data: there is no parameter for a secret, and the schemas in
 * src/lib/mail-keys.ts refuse unknown fields.
 *
 * Putting a key in use and rewrapping it need a sign-in with the password in the last 15 minutes;
 * registering one takes a reset link's session of the last 15 minutes too, for /reset-password,
 * whose key finishReset puts in use (src/lib/auth-session.ts, review R3-PW-2). Any other session
 * gets { ok: false, error: KEY_SESSION_STALE }, and the screen asks to log in again. The reads do not.
 *
 * The browser has no Supabase client (src/lib/__tests__/no-browser-supabase.test.ts): it reads its
 * wrapped keys and sealed mail here. The reads use the user's own session, so RLS applies as well
 * as the user id filter; what comes back is only what opening needs.
 */

const signedOut = { ok: false as const, error: "ログインし直してください" };

/** The refusal for a session that is not fresh enough to change a key. */
function refusal(check: Extract<FreshCheck, { ok: false }>): { ok: false; error: string } {
  if (check.reason === "stale") return { ok: false, error: KEY_SESSION_STALE };
  // Supabase could not be asked: not "signed out", which would ask to log in for nothing.
  if (check.reason === "unknown") return { ok: false, error: "network" };
  return signedOut;
}

/** A new key, waiting: it seals nothing until it is put in use (activateMailKey, or finishReset). */
export async function registerMailKey(input: KeyRegistration): Promise<KeyResult<{ keyId: string; challenge: EnvelopeV1 }>> {
  const check = await freshCookieSession("login_or_reset");
  if (!check.ok) return refusal(check);
  return registerKey(createAdminClient(), check.session.userId, input);
}

export async function activateMailKey(input: KeyActivation): Promise<KeyResult<{ keyId: string }>> {
  const check = await freshCookieSession("login");
  if (!check.ok) return refusal(check);
  const result = await activateKey(createAdminClient(), check.session.userId, input);
  // The mail stored before the key is sealed in the background, with no step for the user.
  if (result.ok) scheduleSealRemaining(check.session.userId);
  revalidatePath("/app", "layout");
  return result;
}

export async function rewrapMailKey(input: KeyRewrap): Promise<KeyResult<{ keyId: string }>> {
  const check = await freshCookieSession("login");
  if (!check.ok) return refusal(check);
  return rewrapKey(createAdminClient(), check.session.userId, input);
}

/** One of the user's wrapped keys: the one in use (keyId null) or one by id. */
export async function readMailKey(input: KeyRead): Promise<KeyResult<{ key: StoredKeyColumns | null }>> {
  const user = await getUser();
  if (!user) return signedOut;
  return readStoredKey(await createClient(), user.id, input);
}

/** The user's retired wrapped keys, newest first (a few). */
export async function readRetiredMailKeys(): Promise<KeyResult<{ keys: StoredKeyColumns[] }>> {
  const user = await getUser();
  if (!user) return signedOut;
  return readRetiredKeys(await createClient(), user.id);
}

/** The envelope of one of the user's sealed mails (the browser opens it). */
export async function readSealedMail(input: SealedMailRead): Promise<KeyResult<{ envelope: Json | null }>> {
  const user = await getUser();
  if (!user) return signedOut;
  return readSealedEnvelope(await createClient(), user.id, input);
}
