import { fromBase64, sha256, toHex } from "@/lib/crypto/bytes";
import { KEY_IN_USE_CHANGED } from "@/lib/crypto/key-messages";
import { KeyActivationSchema, type KeyResult } from "@/lib/mail-keys";
import type { AdminClient } from "@/lib/supabase/admin";

/** Read-only checks before changing Auth. Activation repeats them under its database lock. */
export async function checkResetKey(db: AdminClient, userId: string, input: unknown): Promise<KeyResult<{ keyId: string }>> {
  const parsed = KeyActivationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "invalid key input" };
  const a = parsed.data;
  try {
    const { data: pending, error } = await db.from("user_keys").select("key_id, challenge_hash").eq("user_id", userId).eq("key_id", a.keyId).is("activated_at", null).is("retired_at", null).maybeSingle();
    if (error) return { ok: false, error: "user_keys lookup failed" };
    if (!pending) return { ok: false, error: "no key is waiting to be activated" };
    if (toHex(await sha256(fromBase64(a.challenge))) !== pending.challenge_hash) return { ok: false, error: "the key did not open its challenge" };
    const current = await db.from("user_keys").select("key_id").eq("user_id", userId).not("activated_at", "is", null).is("retired_at", null).maybeSingle();
    if (current.error) return { ok: false, error: "user_keys lookup failed" };
    if ((current.data?.key_id ?? null) !== a.expectedCurrentKeyId) return { ok: false, error: KEY_IN_USE_CHANGED };
    return { ok: true, keyId: a.keyId };
  } catch {
    return { ok: false, error: "user_keys lookup failed" };
  }
}
