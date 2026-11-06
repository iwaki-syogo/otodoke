/**
 * Review C (C-1), turned into a regression test: the first-time form 「合言葉を決める」 and the
 * 「作り直す」 form used to send the same requests. A settings tab opened before a key existed (or on
 * another device) still shows 「決める」; pressing it — even with the SAME passphrase — retired the
 * key in use without the 「前のメールが開けなくなる」 acknowledgment, and mail sealed to that key no
 * longer opened through the app.
 *
 * Now the browser sends the key in use its screen was drawn with (null for 「決める」) and the
 * server refuses a stale one, at registration and again atomically at activation. And a retired
 * key (made again on purpose) still opens the mail sealed to it, with the passphrase it had.
 */
import { describe, expect, it } from "vitest";
import { toBase64 } from "@/lib/crypto/bytes";
import { challengeAad, openBytes, openMail, WrongKeyError } from "@/lib/crypto/envelope";
import { KEY_IN_USE_CHANGED } from "@/lib/crypto/key-messages";
import { createKeyPair, openStoredKey, wrapPrivateKey, type StoredKey } from "@/lib/crypto/key-wrap";
import { activateKey, readRetiredKeys, registerKey } from "@/lib/mail-keys";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const PASS = "テスト用の合言葉です1234";

/** What tab-key.ts createMailKey sends, from a screen drawn when `shown` was the key in use. */
async function createMailKeyLikeTheBrowser(db: FakeDb, passphrase: string, shown: string | null) {
  const pair = await createKeyPair();
  const w = await wrapPrivateKey(pair.pkcs8, passphrase, USER);
  const reg = await registerKey(asAdmin(db), USER, {
    publicKey: toBase64(pair.publicKey),
    wrappedPrivateKey: w.wrapped_private_key,
    wrapIv: w.wrap_iv,
    kdfSalt: w.kdf_salt,
    kdfIterations: w.kdf_iterations,
    expectedCurrentKeyId: shown,
  });
  if (!reg.ok) return { reg, act: null, keyId: null };
  const row = db.rows("user_keys").find((k) => k.key_id === reg.keyId) as unknown as StoredKey;
  const recipient = await openStoredKey(row, passphrase, USER);
  const answer = await openBytes(recipient, challengeAad(USER, reg.keyId), reg.challenge);
  const act = await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: shown });
  return { reg, act, keyId: reg.keyId };
}

/** What tab-key.ts unlock() opens: the key in use. */
async function unlockLikeTheBrowser(db: FakeDb, passphrase: string) {
  const row = db.rows("user_keys").find((k) => k.user_id === USER && k.activated_at && !k.retired_at) as unknown as StoredKey;
  return openStoredKey(row, passphrase, USER);
}

const inUse = (db: FakeDb) => db.rows("user_keys").filter((k) => k.user_id === USER && k.activated_at && !k.retired_at).map((k) => k.key_id);

async function sealedMail(db: FakeDb) {
  await processInboundEmail(asAdmin(db), { ...mailOf("2026-11-03T01:00:00Z"), messageId: "<m1@example.test>" }, { precomputed: precomputed(reading({ relevance: "order", order_number: sure("ORD-1") })) });
  return db.rows("emails")[0] as Row;
}

describe("review C: a stale 「決める」 no longer replaces the key in use", () => {
  it("is refused when a key is in use, and the mail sealed to it still opens", async () => {
    const db = new FakeDb();
    const first = await createMailKeyLikeTheBrowser(db, PASS, null); // phone: 決める
    expect(first.act?.ok).toBe(true);
    const mail = await sealedMail(db);
    expect(mail.body_state).toBe("sealed");
    expect((mail.body_envelope as { kid: string }).kid).toBe(first.keyId);

    // PC tab opened before the phone set the key still shows 「合言葉を決める」. Same passphrase.
    const second = await createMailKeyLikeTheBrowser(db, PASS, null);
    expect(second.reg).toEqual({ ok: false, error: KEY_IN_USE_CHANGED });
    expect(inUse(db)).toEqual([first.keyId]);
    expect(db.rows("user_keys").find((k) => k.key_id === first.keyId)?.retired_at ?? null).toBeNull();

    const tabKey = await unlockLikeTheBrowser(db, PASS);
    expect((await openMail(tabKey, USER, String(mail.id), mail.body_envelope)).subject).toBe(mailOf("2026-11-03T01:00:00Z").subject);
  });

  it("is refused at activation too, when another tab made a key between registration and activation", async () => {
    const db = new FakeDb();
    // Tab B registers from a screen with no key...
    const pair = await createKeyPair();
    const w = await wrapPrivateKey(pair.pkcs8, PASS, USER);
    const regB = await registerKey(asAdmin(db), USER, { publicKey: toBase64(pair.publicKey), wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations, expectedCurrentKeyId: null });
    if (!regB.ok) throw new Error(regB.error);
    const rowB = { ...(db.rows("user_keys").find((k) => k.key_id === regB.keyId) as unknown as StoredKey) };
    const answerB = await openBytes(await openStoredKey(rowB, PASS, USER), challengeAad(USER, regB.keyId), regB.challenge);
    // ...tab A makes and activates its key meanwhile. A's registration removed B's pending row; B's
    // insert lands after A's activation in this interleaving (B checked before A activated), so put
    // it back as the database would hold it.
    const a = await createMailKeyLikeTheBrowser(db, PASS, null);
    expect(a.act?.ok).toBe(true);
    db.rows("user_keys").push({ ...rowB, activated_at: null, retired_at: null });
    // ...then B activates, still expecting no key: refused by the database's check.
    const actB = await activateKey(asAdmin(db), USER, { keyId: regB.keyId, challenge: toBase64(answerB), expectedCurrentKeyId: null });
    expect(actB).toEqual({ ok: false, error: KEY_IN_USE_CHANGED });
    expect(inUse(db)).toEqual([a.keyId]);
  });

  it("「作り直す」 from an up-to-date screen still works, and the retired key still opens the old mail", async () => {
    const db = new FakeDb();
    const first = await createMailKeyLikeTheBrowser(db, PASS, null);
    const mail = await sealedMail(db);
    const second = await createMailKeyLikeTheBrowser(db, "あたらしい合言葉ですよ", first.keyId);
    expect(second.act?.ok).toBe(true);
    expect(inUse(db)).toEqual([second.keyId]);

    // The key in use does not open it (sealed to the first key)...
    const tabKey = await unlockLikeTheBrowser(db, "あたらしい合言葉ですよ");
    await expect(openMail(tabKey, USER, String(mail.id), mail.body_envelope)).rejects.toBeInstanceOf(WrongKeyError);
    // ...the retired key does, read back the way the browser reads it, with the passphrase it had.
    const retired = await readRetiredKeys(asAdmin(db), USER);
    if (!retired.ok) throw new Error(retired.error);
    expect(retired.keys.map((k) => k.key_id)).toEqual([first.keyId]);
    const old = await openStoredKey(retired.keys[0], PASS, USER);
    expect((await openMail(old, USER, String(mail.id), mail.body_envelope)).subject).toBe(mailOf("2026-11-03T01:00:00Z").subject);
  });
});
