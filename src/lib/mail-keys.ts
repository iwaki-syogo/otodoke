/**
 * Registering a user's key, and sealing the mail they stored before it. Server side.
 *
 * The browser makes the key pair and wraps the private key with the passphrase; only the wrapped
 * form reaches this file. A new key is used for nothing until the browser has proved, from the
 * wrapped key read back from the database, that it opens with the passphrase and is the pair of
 * the stored public key (it opens a challenge sealed to that public key). Only then is the key
 * activated, and only an active key seals mail or replaces plaintext.
 *
 * The inputs are strict: an unknown field (a passphrase, say) is refused, never ignored.
 */
import { z } from "zod";
import { fromBase64, randomBytes, sha256, toHex } from "@/lib/crypto/bytes";
import { challengeAad, importPublicKey, keyIdOf, sealBytes, type EnvelopeV1 } from "@/lib/crypto/envelope";
import { forwardingConfirmUrl } from "@/lib/forwarding";
import { closedBody, currentSealKey, domainOf } from "@/lib/mail-seal";
import type { AdminClient } from "@/lib/supabase/admin";

export const MIN_KDF_ITERATIONS = 600_000;
const MAX_KDF_ITERATIONS = 10_000_000;
export const SEAL_BATCH_SIZE = 50;

const b64 = z.string().max(4096);

/** What the browser sends to register a key. There is no field for the passphrase. */
export const KeyRegistrationSchema = z
  .object({
    publicKey: b64,
    wrappedPrivateKey: b64,
    wrapIv: b64,
    kdfSalt: b64,
    kdfIterations: z.number().int().min(MIN_KDF_ITERATIONS).max(MAX_KDF_ITERATIONS),
  })
  .strict();
export type KeyRegistration = z.infer<typeof KeyRegistrationSchema>;

/** The answer to the registration challenge: the bytes the browser opened, base64. */
export const KeyActivationSchema = z.object({ keyId: z.string().regex(/^[0-9a-f]{32}$/), challenge: b64 }).strict();
export type KeyActivation = z.infer<typeof KeyActivationSchema>;

/** A new wrap of the same private key (the passphrase changed). */
export const KeyRewrapSchema = z
  .object({
    keyId: z.string().regex(/^[0-9a-f]{32}$/),
    wrappedPrivateKey: b64,
    wrapIv: b64,
    kdfSalt: b64,
    kdfIterations: z.number().int().min(MIN_KDF_ITERATIONS).max(MAX_KDF_ITERATIONS),
  })
  .strict();
export type KeyRewrap = z.infer<typeof KeyRewrapSchema>;

export type KeyResult<T> = ({ ok: true } & T) | { ok: false; error: string };

function checkWrap(wrappedPrivateKey: string, wrapIv: string, kdfSalt: string): void {
  // A P-256 PKCS#8 is about 138 bytes; the GCM tag adds 16.
  const wrapped = fromBase64(wrappedPrivateKey);
  if (wrapped.length < 64 || wrapped.length > 512) throw new Error("wrapped key has an unexpected size");
  if (fromBase64(wrapIv).length !== 12) throw new Error("wrap iv must be 12 bytes");
  if (fromBase64(kdfSalt).length !== 16) throw new Error("salt must be 16 bytes");
}

function fail(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/**
 * Store a new key as pending and answer a challenge sealed to its public key. A pending key from
 * an earlier, unfinished try is replaced. The key in use (if any) stays in use until activation.
 */
export async function registerKey(db: AdminClient, userId: string, input: unknown): Promise<KeyResult<{ keyId: string; challenge: EnvelopeV1 }>> {
  try {
    const k = KeyRegistrationSchema.parse(input);
    const publicKey = fromBase64(k.publicKey);
    await importPublicKey(publicKey); // a point on the curve, or it throws
    checkWrap(k.wrappedPrivateKey, k.wrapIv, k.kdfSalt);
    const keyId = await keyIdOf(publicKey);

    const { error: clearError } = await db.from("user_keys").delete().eq("user_id", userId).is("activated_at", null);
    if (clearError) throw new Error(`user_keys cleanup failed: ${clearError.message}`);

    const challenge = randomBytes(32);
    const { error } = await db.from("user_keys").insert({
      user_id: userId,
      key_id: keyId,
      public_key: k.publicKey,
      wrapped_private_key: k.wrappedPrivateKey,
      wrap_iv: k.wrapIv,
      kdf_salt: k.kdfSalt,
      kdf_iterations: k.kdfIterations,
      challenge_hash: toHex(await sha256(challenge)),
    });
    if (error) throw new Error(`user_keys insert failed: ${error.message}`);
    return { ok: true, keyId, challenge: await sealBytes({ keyId, publicKey }, challengeAad(userId, keyId), challenge) };
  } catch (err) {
    return fail(err);
  }
}

/** Put the pending key in use once its challenge came back opened. The old key (if any) is retired. */
export async function activateKey(db: AdminClient, userId: string, input: unknown): Promise<KeyResult<{ keyId: string }>> {
  try {
    const a = KeyActivationSchema.parse(input);
    const { data: pending, error } = await db
      .from("user_keys")
      .select("key_id, challenge_hash")
      .eq("user_id", userId)
      .eq("key_id", a.keyId)
      .is("activated_at", null)
      .maybeSingle();
    if (error) throw new Error(`user_keys lookup failed: ${error.message}`);
    if (!pending) throw new Error("no key is waiting to be activated");
    const answer = fromBase64(a.challenge);
    const answerHash = toHex(await sha256(answer));
    if (answer.length !== 32 || answerHash !== pending.challenge_hash) {
      throw new Error("the key did not open its challenge");
    }

    // Retire the old key and activate this one in one database call (activate_user_key), so a
    // mail read in between never finds no key in use and gets dropped instead of sealed. The
    // function checks the answer's hash against the stored one again, under a lock.
    const { data: activated, error: activateError } = await db.rpc("activate_user_key", {
      p_user_id: userId,
      p_key_id: a.keyId,
      p_challenge_hash: answerHash,
    });
    if (activateError) throw new Error(`user_keys activate failed: ${activateError.message}`);
    if (activated !== a.keyId) throw new Error("the key was not activated");
    return { ok: true, keyId: a.keyId };
  } catch (err) {
    return fail(err);
  }
}

/** Store a new wrap of the key in use. The browser checked it opens before sending it. */
export async function rewrapKey(db: AdminClient, userId: string, input: unknown): Promise<KeyResult<{ keyId: string }>> {
  try {
    const r = KeyRewrapSchema.parse(input);
    checkWrap(r.wrappedPrivateKey, r.wrapIv, r.kdfSalt);
    const { data, error } = await db
      .from("user_keys")
      .update({ wrapped_private_key: r.wrappedPrivateKey, wrap_iv: r.wrapIv, kdf_salt: r.kdfSalt, kdf_iterations: r.kdfIterations })
      .eq("user_id", userId)
      .eq("key_id", r.keyId)
      .not("activated_at", "is", null)
      .is("retired_at", null)
      .select("key_id");
    if (error) throw new Error(`user_keys update failed: ${error.message}`);
    if (!data || data.length !== 1) throw new Error("no key in use with this id");
    return { ok: true, keyId: r.keyId };
  } catch (err) {
    return fail(err);
  }
}

/** Read mail of this user still in plaintext, counted by the database. */
export async function countPlainRead(db: AdminClient, userId: string): Promise<number> {
  const { count, error } = await db
    .from("emails")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("processing_status", "processed")
    .eq("body_state", "plain");
  if (error) throw new Error(`emails count failed: ${error.message}`);
  return count ?? 0;
}

/**
 * Seal up to SEAL_BATCH_SIZE of this user's read mails that are still in plaintext, with the key
 * in use. Safe to run again and side by side: a row is written only while it is still plaintext.
 * Answers how many were sealed and how many remain.
 */
export async function sealPlainBatch(db: AdminClient, userId: string): Promise<KeyResult<{ sealed: number; remaining: number }>> {
  try {
    const key = await currentSealKey(db, userId);
    if (!key) throw new Error("no key in use");
    const { data: rows, error } = await db
      .from("emails")
      .select("id, classification, subject, from_name, from_address, from_domain, text_body, html_body, forwarding_confirm_url")
      .eq("user_id", userId)
      .eq("processing_status", "processed")
      .eq("body_state", "plain")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(SEAL_BATCH_SIZE);
    if (error) throw new Error(`emails lookup failed: ${error.message}`);

    let sealed = 0;
    for (const row of rows) {
      const mail = { subject: row.subject, from_name: row.from_name, from_address: row.from_address, text: row.text_body, html: row.html_body };
      const confirmUrl =
        row.forwarding_confirm_url ??
        (row.classification === "forwarding_confirmation" ? (forwardingConfirmUrl(row.text_body ?? "") ?? forwardingConfirmUrl(row.html_body ?? "")) : null);
      const { data: written, error: writeError } = await db
        .from("emails")
        .update({
          ...(await closedBody(key, userId, row.id, mail, false)),
          from_domain: row.from_domain ?? domainOf(row.from_address),
          forwarding_confirm_url: confirmUrl,
        })
        .eq("id", row.id)
        .eq("user_id", userId)
        .eq("body_state", "plain")
        .select("id");
      if (writeError) throw new Error(`emails seal failed: ${writeError.message}`);
      sealed += written?.length ?? 0;
    }
    return { ok: true, sealed, remaining: await countPlainRead(db, userId) };
  } catch (err) {
    return fail(err);
  }
}
