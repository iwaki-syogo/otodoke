"use server";

import { revalidatePath } from "next/cache";
import { activateKey, registerKey, rewrapKey, sealPlainBatch, type KeyActivation, type KeyRegistration, type KeyResult, type KeyRewrap } from "@/lib/mail-keys";
import type { EnvelopeV1 } from "@/lib/crypto/envelope";
import { createAdminClient } from "@/lib/supabase/admin";
import { getUser } from "@/lib/supabase/server";

/*
 * The key steps of 設定. Each takes only wrapped keys and public data: there is no parameter for
 * the passphrase, and the schemas in src/lib/mail-keys.ts refuse unknown fields.
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

/** One batch of 「暗号化する」. The browser calls it again until nothing remains. */
export async function sealStoredMail(): Promise<KeyResult<{ sealed: number; remaining: number }>> {
  const user = await getUser();
  if (!user) return signedOut;
  const result = await sealPlainBatch(createAdminClient(), user.id);
  revalidatePath("/app", "layout");
  return result;
}
