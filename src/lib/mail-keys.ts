/**
 * Registering a user's key, and sealing the mail they stored before it. Server side.
 *
 * The browser makes the key pair and wraps the private key with the passphrase; only the wrapped
 * form reaches this file. A new key is used for nothing until the browser has proved, from the
 * wrapped key read back from the database, that it opens with the passphrase and is the pair of
 * the stored public key (it opens a challenge sealed to that public key). Only then is the key
 * activated, and only an active key seals mail or replaces plaintext.
 *
 * The browser reads its wrapped keys and sealed mail through Server Actions that call the readers
 * here (src/app/app/settings/key-actions.ts): it has no Supabase client of its own.
 *
 * The inputs are strict: an unknown field (a passphrase, say) is refused, never ignored.
 */
import { z } from "zod";
import { fromBase64, randomBytes, sha256, toHex } from "@/lib/crypto/bytes";
import { challengeAad, importPublicKey, keyIdOf, sealBytes, type EnvelopeV1 } from "@/lib/crypto/envelope";
import { KEY_IN_USE_CHANGED, KEY_WRAP_CHANGED } from "@/lib/crypto/key-messages";
import type { Json } from "@/lib/db/database.types";
import { forwardingConfirmUrl } from "@/lib/forwarding";
import { closedBody, currentSealKey, domainOf } from "@/lib/mail-seal";
import type { AdminClient } from "@/lib/supabase/admin";

export const MIN_KDF_ITERATIONS = 600_000;
const MAX_KDF_ITERATIONS = 10_000_000;
export const SEAL_BATCH_SIZE = 50;
/** Retired keys the browser tries the passphrase on when it opens the key (newest first). */
export const MAX_RETIRED_KEYS_TRIED = 3;

const b64 = z.string().max(4096);
const keyIdField = z.string().regex(/^[0-9a-f]{32}$/);
const uuidField = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/**
 * What the browser sends to register a key. There is no field for the passphrase.
 * `expectedCurrentKeyId` is the key in use when the screen was drawn (null: none yet). A screen
 * left open from before another tab or device made a key sends a stale value and is refused, so
 * it can never retire the key in use without the user having seen it (「作り直す」).
 */
export const KeyRegistrationSchema = z
  .object({
    publicKey: b64,
    wrappedPrivateKey: b64,
    wrapIv: b64,
    kdfSalt: b64,
    kdfIterations: z.number().int().min(MIN_KDF_ITERATIONS).max(MAX_KDF_ITERATIONS),
    expectedCurrentKeyId: keyIdField.nullable(),
  })
  .strict();
export type KeyRegistration = z.infer<typeof KeyRegistrationSchema>;

/** The answer to the registration challenge: the bytes the browser opened, base64. */
export const KeyActivationSchema = z.object({ keyId: keyIdField, challenge: b64, expectedCurrentKeyId: keyIdField.nullable() }).strict();
export type KeyActivation = z.infer<typeof KeyActivationSchema>;

/**
 * A new wrap of the same private key (the passphrase changed). `previousWrappedPrivateKey` is the
 * wrap the browser opened with the old passphrase: the new one is stored only over that one, never
 * over a wrap it has not seen (another tab's change, say).
 */
export const KeyRewrapSchema = z
  .object({
    keyId: keyIdField,
    previousWrappedPrivateKey: b64,
    wrappedPrivateKey: b64,
    wrapIv: b64,
    kdfSalt: b64,
    kdfIterations: z.number().int().min(MIN_KDF_ITERATIONS).max(MAX_KDF_ITERATIONS),
  })
  .strict();
export type KeyRewrap = z.infer<typeof KeyRewrapSchema>;

/** Which stored key the browser wants to open: the one in use (null), or one by id. */
export const KeyReadSchema = z.object({ keyId: keyIdField.nullable() }).strict();
export type KeyRead = z.infer<typeof KeyReadSchema>;

/** Which sealed mail the browser wants to open. */
export const SealedMailReadSchema = z.object({ emailId: uuidField }).strict();
export type SealedMailRead = z.infer<typeof SealedMailReadSchema>;

export type KeyResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** A key as the browser needs it to open it with the passphrase. Nothing else of the row leaves the server. */
export interface StoredKeyColumns {
  key_id: string;
  public_key: string;
  wrapped_private_key: string;
  wrap_iv: string;
  kdf_salt: string;
  kdf_iterations: number;
}
const STORED_KEY_COLUMNS = "key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations";

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

/** The id of the key in use, or null when there is none. Throws when it cannot tell. */
async function currentKeyId(db: AdminClient, userId: string): Promise<string | null> {
  const { data, error } = await db.from("user_keys").select("key_id").eq("user_id", userId).not("activated_at", "is", null).is("retired_at", null).maybeSingle();
  if (error) throw new Error(`user_keys lookup failed: ${error.message}`);
  return data?.key_id ?? null;
}

/**
 * Store a new key as pending and answer a challenge sealed to its public key. A pending key from
 * an earlier, unfinished try is replaced. The key in use (if any) stays in use until activation.
 * Refused when the key in use is not the one the browser's screen was drawn with.
 */
export async function registerKey(db: AdminClient, userId: string, input: unknown): Promise<KeyResult<{ keyId: string; challenge: EnvelopeV1 }>> {
  try {
    const k = KeyRegistrationSchema.parse(input);
    const publicKey = fromBase64(k.publicKey);
    await importPublicKey(publicKey); // a point on the curve, or it throws
    checkWrap(k.wrappedPrivateKey, k.wrapIv, k.kdfSalt);
    const keyId = await keyIdOf(publicKey);

    // Checked again, atomically, when the key is put in use (activate_user_key_checked).
    if ((await currentKeyId(db, userId)) !== k.expectedCurrentKeyId) throw new Error(KEY_IN_USE_CHANGED);

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

/**
 * Put the pending key in use once its challenge came back opened. The old key (if any) is retired,
 * but only if it is still the one the browser expected (checked by the database, under a lock).
 */
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

    // Retire the old key and activate this one in one database call (activate_user_key_checked,
    // supabase/migrations/20261106150000), so a mail read in between never finds no key in use
    // and gets dropped instead of sealed. Under a lock, the function checks that the answer's hash
    // matches the stored one and that the key in use is still the one this browser expected.
    const { data: activated, error: activateError } = await db.rpc("activate_user_key_checked", {
      p_user_id: userId,
      p_key_id: a.keyId,
      p_challenge_hash: answerHash,
      p_expected_current_key_id: a.expectedCurrentKeyId,
    });
    if (activateError) throw new Error(activateError.message.includes(KEY_IN_USE_CHANGED) ? KEY_IN_USE_CHANGED : `user_keys activate failed: ${activateError.message}`);
    if (activated !== a.keyId) throw new Error("the key was not activated");
    return { ok: true, keyId: a.keyId };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Store a new wrap of the key in use, over the wrap the browser opened and nothing else. The
 * browser checked the new one opens before sending it.
 */
export async function rewrapKey(db: AdminClient, userId: string, input: unknown): Promise<KeyResult<{ keyId: string }>> {
  try {
    const r = KeyRewrapSchema.parse(input);
    checkWrap(r.wrappedPrivateKey, r.wrapIv, r.kdfSalt);
    const { data, error } = await db
      .from("user_keys")
      .update({ wrapped_private_key: r.wrappedPrivateKey, wrap_iv: r.wrapIv, kdf_salt: r.kdfSalt, kdf_iterations: r.kdfIterations })
      .eq("user_id", userId)
      .eq("key_id", r.keyId)
      .eq("wrapped_private_key", r.previousWrappedPrivateKey)
      .not("activated_at", "is", null)
      .is("retired_at", null)
      .select("key_id");
    if (error) throw new Error(`user_keys update failed: ${error.message}`);
    if (!data || data.length !== 1) {
      // Tell a wrap changed meanwhile apart from a key that is not in use.
      const inUse = await currentKeyId(db, userId);
      throw new Error(inUse === r.keyId ? KEY_WRAP_CHANGED : "no key in use with this id");
    }
    return { ok: true, keyId: r.keyId };
  } catch (err) {
    return fail(err);
  }
}

/**
 * One stored key of this user, as the browser needs it to open it: the key in use (keyId null),
 * or a key by id (a pending one being checked, or a retired one for mail sealed before it).
 */
export async function readStoredKey(db: AdminClient, userId: string, input: unknown): Promise<KeyResult<{ key: StoredKeyColumns | null }>> {
  try {
    const { keyId } = KeyReadSchema.parse(input);
    const query = db.from("user_keys").select(STORED_KEY_COLUMNS).eq("user_id", userId);
    const { data, error } = await (keyId ? query.eq("key_id", keyId) : query.not("activated_at", "is", null).is("retired_at", null)).maybeSingle();
    if (error) throw new Error(`user_keys lookup failed: ${error.message}`);
    return { ok: true, key: data };
  } catch (err) {
    return fail(err);
  }
}

/** This user's retired keys, newest first, at most MAX_RETIRED_KEYS_TRIED. */
export async function readRetiredKeys(db: AdminClient, userId: string): Promise<KeyResult<{ keys: StoredKeyColumns[] }>> {
  try {
    const { data, error } = await db
      .from("user_keys")
      .select(STORED_KEY_COLUMNS)
      .eq("user_id", userId)
      .not("retired_at", "is", null)
      .order("retired_at", { ascending: false })
      .limit(MAX_RETIRED_KEYS_TRIED);
    if (error) throw new Error(`user_keys lookup failed: ${error.message}`);
    return { ok: true, keys: data ?? [] };
  } catch (err) {
    return fail(err);
  }
}

/**
 * The envelope of one of this user's sealed mails, for the browser to open. Only the envelope:
 * the server cannot open it, and nothing else of the row is needed there.
 */
export async function readSealedEnvelope(db: AdminClient, userId: string, input: unknown): Promise<KeyResult<{ envelope: Json | null }>> {
  try {
    const { emailId } = SealedMailReadSchema.parse(input);
    const { data, error } = await db.from("emails").select("body_envelope").eq("id", emailId).eq("user_id", userId).eq("body_state", "sealed").maybeSingle();
    if (error) throw new Error(`emails lookup failed: ${error.message}`);
    return { ok: true, envelope: data?.body_envelope ?? null };
  } catch (err) {
    return fail(err);
  }
}

/** Marks the anonymized sample mails the demo loader stores (public fixtures, not the user's mail). */
export const SAMPLE_PROVIDER_ID = "demo:%";

/**
 * This user's read mail still in plaintext, counted by the database. The public sample mails are
 * left out: they are anonymized fixtures from the repository, not the user's mail. `after`: only
 * rows whose id sorts after it (the 「暗号化する」 cursor).
 *
 * Counted as all minus samples, so a row with no provider id (null) is never left out.
 */
export async function countPlainRead(db: AdminClient, userId: string, after: string | null = null): Promise<number> {
  const count = async (samplesOnly: boolean) => {
    let query = db.from("emails").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("processing_status", "processed").eq("body_state", "plain");
    if (after) query = query.gt("id", after);
    if (samplesOnly) query = query.like("provider_email_id", SAMPLE_PROVIDER_ID);
    const { count: n, error } = await query;
    if (error) throw new Error(`emails count failed: ${error.message}`);
    return n ?? 0;
  };
  return (await count(false)) - (await count(true));
}

/**
 * Where a run of 「暗号化する」 is: the id of the last row the previous batch looked at (null to
 * start). Every row a batch looks at, sealed or not, is behind the cursor afterwards, so rows that
 * cannot be sealed never hold the run back, however many there are.
 */
// An id (hex and hyphens) only: it goes into a PostgREST filter, so nothing else may pass.
export const SealBatchSchema = z.object({ after: z.string().regex(/^[0-9a-f-]{1,36}$/i).nullable() }).strict();
export type SealBatch = z.infer<typeof SealBatchSchema>;

export type SealBatchResult = KeyResult<{ sealed: number; failed: string[]; next: string | null; remaining: number }>;

/**
 * Seal up to SEAL_BATCH_SIZE of this user's read mails that are still in plaintext, with the key
 * in use, in id order after the cursor. Safe to run again and side by side: a row is written only
 * while it is still plaintext.
 *
 * A row that cannot be sealed does not stop the run: it is answered in `failed` and left behind
 * the cursor (`next`), which the browser passes back. `remaining` counts what is still plaintext
 * after `next`, samples left out (0: this run is done).
 */
export async function sealPlainBatch(db: AdminClient, userId: string, input: unknown = { after: null }): Promise<SealBatchResult> {
  try {
    const { after } = SealBatchSchema.parse(input);
    const key = await currentSealKey(db, userId);
    if (!key) throw new Error("no key in use");
    let query = db
      .from("emails")
      .select("id, classification, subject, from_name, from_address, from_domain, text_body, html_body, forwarding_confirm_url")
      .eq("user_id", userId)
      .eq("processing_status", "processed")
      .eq("body_state", "plain");
    if (after) query = query.gt("id", after);
    const { data: rows, error } = await query.order("id", { ascending: true }).limit(SEAL_BATCH_SIZE);
    if (error) throw new Error(`emails lookup failed: ${error.message}`);

    let sealed = 0;
    const failed: string[] = [];
    for (const row of rows) {
      try {
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
        if (writeError) throw new Error(writeError.message);
        sealed += written?.length ?? 0;
      } catch (err) {
        // Only the id and the database's message: never the mail.
        console.error("seal: a row could not be sealed", row.id, err instanceof Error ? err.message : "unknown error");
        failed.push(row.id);
      }
    }
    const next = rows.length > 0 ? rows[rows.length - 1].id : after;
    return { ok: true, sealed, failed, next, remaining: await countPlainRead(db, userId, next) };
  } catch (err) {
    return fail(err);
  }
}
