"use server";

import { revalidatePath } from "next/cache";
import {
  activateKey,
  readRetiredKeys,
  readSealedEnvelope,
  readStoredKey,
  registerKey,
  rewrapKey,
  sealPlainBatch,
  type KeyActivation,
  type KeyRead,
  type KeyRegistration,
  type KeyResult,
  type KeyRewrap,
  type SealBatch,
  type SealBatchResult,
  type SealedMailRead,
  type StoredKeyColumns,
} from "@/lib/mail-keys";
import type { EnvelopeV1 } from "@/lib/crypto/envelope";
import type { Json } from "@/lib/db/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient, getUser } from "@/lib/supabase/server";

/*
 * The key steps of 設定, and the reads the browser needs to open its mail. Each takes only wrapped
 * keys and public data: there is no parameter for the passphrase, and the schemas in
 * src/lib/mail-keys.ts refuse unknown fields.
 *
 * The browser has no Supabase client (src/lib/__tests__/no-browser-supabase.test.ts): it reads its
 * wrapped keys and sealed mail here. The reads use the user's own session, so RLS applies as well
 * as the user id filter; what comes back is only what opening needs.
 */

const signedOut = { ok: false as const, error: "ログインし直してください" };

export async function registerMailKey(input: KeyRegistration): Promise<KeyResult<{ keyId: string; challenge: EnvelopeV1 }>> {
  const user = await getUser();
  if (!user) return signedOut;
  return registerKey(createAdminClient(), user.id, input);
}

export async function activateMailKey(input: KeyActivation): Promise<KeyResult<{ keyId: string }>> {
  const user = await getUser();
  if (!user) return signedOut;
  const result = await activateKey(createAdminClient(), user.id, input);
  revalidatePath("/app", "layout");
  return result;
}

export async function rewrapMailKey(input: KeyRewrap): Promise<KeyResult<{ keyId: string }>> {
  const user = await getUser();
  if (!user) return signedOut;
  return rewrapKey(createAdminClient(), user.id, input);
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

/**
 * One batch of 「暗号化する」. The browser calls it again until nothing remains, passing back the
 * cursor each batch answers so the next one moves on past the rows that could not be sealed.
 */
export async function sealStoredMail(input: SealBatch): Promise<SealBatchResult> {
  const user = await getUser();
  if (!user) return signedOut;
  const result = await sealPlainBatch(createAdminClient(), user.id, input);
  revalidatePath("/app", "layout");
  return result;
}
