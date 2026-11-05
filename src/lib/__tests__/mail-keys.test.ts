import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "@/lib/crypto/bytes";
import { challengeAad, openBytes, openMail, type PrivateRecipient } from "@/lib/crypto/envelope";
import { createKeyPair, openStoredKey, wrapPrivateKey, type StoredKey } from "@/lib/crypto/key-wrap";
import { activateKey, registerKey, rewrapKey, sealPlainBatch, SEAL_BATCH_SIZE } from "@/lib/mail-keys";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, type Row } from "./fake-db";
import { OTHER, USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const PASS = "テスト用の合言葉です1234";

async function newRegistration(passphrase = PASS, userId = USER) {
  const pair = await createKeyPair();
  const w = await wrapPrivateKey(pair.pkcs8, passphrase, userId);
  return { pair, input: { publicKey: toBase64(pair.publicKey), wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations } };
}

const stored = (db: FakeDb, keyId: string) => db.rows("user_keys").find((k) => k.key_id === keyId) as unknown as StoredKey & Row;

/** The browser's side of registration, done against the row as the database holds it. */
async function registerAndActivate(db: FakeDb, passphrase = PASS, userId = USER): Promise<PrivateRecipient> {
  const { input } = await newRegistration(passphrase, userId);
  const reg = await registerKey(asAdmin(db), userId, input);
  if (!reg.ok) throw new Error(reg.error);
  const recipient = await openStoredKey(stored(db, reg.keyId), passphrase, userId);
  const answer = await openBytes(recipient, challengeAad(userId, reg.keyId), reg.challenge);
  const act = await activateKey(asAdmin(db), userId, { keyId: reg.keyId, challenge: toBase64(answer) });
  if (!act.ok) throw new Error(act.error);
  return recipient;
}

const current = (db: FakeDb, userId = USER) => db.rows("user_keys").filter((k) => k.user_id === userId && k.activated_at && !k.retired_at);

describe("key registration", () => {
  it("stores the key as pending, and puts it in use only after the challenge comes back opened", async () => {
    const db = new FakeDb();
    const { input, pair } = await newRegistration();
    const reg = await registerKey(asAdmin(db), USER, input);
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    expect(reg.keyId).toBe(pair.keyId);
    expect(current(db)).toHaveLength(0);

    // Until then a mail is dropped, not sealed to the unproven key.
    await processInboundEmail(asAdmin(db), { ...mailOf("2026-11-03T01:00:00Z"), messageId: "m1" }, { precomputed: precomputed(reading({ relevance: "order", order_number: sure("ORD-1") })) });
    expect(db.rows("emails")[0].body_state).toBe("dropped");

    const recipient = await openStoredKey(stored(db, reg.keyId), PASS, USER);
    const answer = await openBytes(recipient, challengeAad(USER, reg.keyId), reg.challenge);
    expect(await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(answer) })).toEqual({ ok: true, keyId: reg.keyId });
    expect(current(db)).toHaveLength(1);
    expect(stored(db, reg.keyId).challenge_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a wrong answer to the challenge and keeps the key out of use", async () => {
    const db = new FakeDb();
    const { input } = await newRegistration();
    const reg = await registerKey(asAdmin(db), USER, input);
    if (!reg.ok) throw new Error(reg.error);
    const res = await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(new Uint8Array(32)) });
    expect(res.ok).toBe(false);
    expect(current(db)).toHaveLength(0);
  });

  it("refuses another user's answer", async () => {
    const db = new FakeDb();
    const { input } = await newRegistration();
    const reg = await registerKey(asAdmin(db), USER, input);
    if (!reg.ok) throw new Error(reg.error);
    const recipient = await openStoredKey(stored(db, reg.keyId), PASS, USER);
    const answer = await openBytes(recipient, challengeAad(USER, reg.keyId), reg.challenge);
    expect((await activateKey(asAdmin(db), OTHER, { keyId: reg.keyId, challenge: toBase64(answer) })).ok).toBe(false);
    expect(current(db, USER)).toHaveLength(0);
  });

  it("a wrapped key that does not open with the passphrase never reaches activation", async () => {
    const db = new FakeDb();
    const { input } = await newRegistration();
    const reg = await registerKey(asAdmin(db), USER, input);
    if (!reg.ok) throw new Error(reg.error);
    await expect(openStoredKey(stored(db, reg.keyId), "ちがう合言葉ですよ12", USER)).rejects.toThrow();
  });

  it("refuses a passphrase field, too few rounds, a bad public key, a bad salt", async () => {
    const db = new FakeDb();
    const { input } = await newRegistration();
    const bad = [
      { ...input, passphrase: PASS },
      { ...input, kdfIterations: 100_000 },
      { ...input, publicKey: toBase64(fromBase64(input.publicKey).subarray(0, 33)) },
      { ...input, kdfSalt: toBase64(new Uint8Array(8)) },
      { ...input, wrapIv: "not base64!" },
    ];
    for (const b of bad) expect((await registerKey(asAdmin(db), USER, b)).ok, JSON.stringify(Object.keys(b))).toBe(false);
    expect(db.rows("user_keys")).toHaveLength(0);
  });

  it("a new key (forgotten passphrase) retires the old one; only one is ever in use", async () => {
    const db = new FakeDb();
    const first = await registerAndActivate(db);
    const second = await registerAndActivate(db, "あたらしい合言葉ですよ");
    expect(first.keyId).not.toBe(second.keyId);
    expect(current(db).map((k) => k.key_id)).toEqual([second.keyId]);
    expect(db.rows("user_keys").find((k) => k.key_id === first.keyId)?.retired_at).toBeTruthy();
  });

  it("an unfinished registration is replaced by the next one", async () => {
    const db = new FakeDb();
    await registerKey(asAdmin(db), USER, (await newRegistration()).input);
    await registerKey(asAdmin(db), USER, (await newRegistration()).input);
    expect(db.rows("user_keys").filter((k) => !k.activated_at)).toHaveLength(1);
  });
});

describe("changing the passphrase", () => {
  it("rewraps the same key: old mail still opens with the new passphrase", async () => {
    const db = new FakeDb();
    const key = await registerAndActivate(db);
    const row = stored(db, key.keyId);
    const pkcs8 = await import("@/lib/crypto/key-wrap").then((m) => m.unwrapPrivateKeyBytes(row, PASS, USER));
    const w = await wrapPrivateKey(pkcs8, "かえた合言葉ですよ!!", USER);
    const res = await rewrapKey(asAdmin(db), USER, { keyId: key.keyId, wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations });
    expect(res.ok).toBe(true);
    const reopened = await openStoredKey(stored(db, key.keyId), "かえた合言葉ですよ!!", USER);
    expect(toBase64(reopened.publicKey)).toBe(toBase64(key.publicKey));
    await expect(openStoredKey(stored(db, key.keyId), PASS, USER)).rejects.toThrow();
  });

  it("refuses a passphrase field and a retired key", async () => {
    const db = new FakeDb();
    const key = await registerAndActivate(db);
    const row = stored(db, key.keyId);
    const base = { keyId: key.keyId, wrappedPrivateKey: row.wrapped_private_key, wrapIv: row.wrap_iv, kdfSalt: row.kdf_salt, kdfIterations: row.kdf_iterations };
    expect((await rewrapKey(asAdmin(db), USER, { ...base, passphrase: PASS })).ok).toBe(false);
    row.retired_at = "2026-11-05T00:00:00Z";
    expect((await rewrapKey(asAdmin(db), USER, base)).ok).toBe(false);
  });
});

describe("「暗号化する」: sealing mail stored before encryption", () => {
  function seedPlain(db: FakeDb, n: number) {
    for (let i = 0; i < n; i++) {
      db.rows("emails").push({
        id: `e-${String(i).padStart(4, "0")}`,
        user_id: USER,
        message_id: i % 10 === 0 ? `demo:shop/${i}` : `<m${i}@example.test>`,
        subject: `件名${i}`,
        from_name: "テスト店",
        from_address: "Shop@Example.TEST",
        from_domain: null,
        text_body: `本文${i}`,
        html_body: null,
        classification: "order",
        processing_status: "processed",
        body_state: "plain",
        body_envelope: null,
        forwarding_confirm_url: null,
        created_at: `2026-10-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`,
      });
    }
  }

  it("seals every read mail in batches of 50 until 0 remain, and each opens with the key", async () => {
    const db = new FakeDb();
    const key = await registerAndActivate(db);
    seedPlain(db, 120);
    // Unread mail stays plaintext (it must be read again); another user's mail is not touched.
    db.rows("emails").push({ id: "e-unread", user_id: USER, message_id: "u", subject: "未読", text_body: "x", processing_status: "over_limit", body_state: "plain", body_envelope: null, created_at: "2026-10-01T00:00:00Z" });
    db.rows("emails").push({ id: "e-other", user_id: OTHER, message_id: "o", subject: "他人", text_body: "x", processing_status: "processed", body_state: "plain", body_envelope: null, created_at: "2026-10-01T00:00:00Z" });

    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await sealPlainBatch(asAdmin(db), USER);
      if (!res.ok) throw new Error(res.error);
      expect(res.sealed).toBeLessThanOrEqual(SEAL_BATCH_SIZE);
      seen.push(res.remaining);
      if (res.remaining === 0) break;
    }
    expect(seen).toEqual([70, 20, 0]);

    const mine = db.rows("emails").filter((e) => e.user_id === USER && e.processing_status === "processed");
    expect(mine).toHaveLength(120);
    for (const e of mine) {
      expect(e.body_state).toBe("sealed");
      for (const c of ["subject", "from_name", "from_address", "text_body", "html_body"]) expect(e[c]).toBeNull();
      expect(e.from_domain).toBe("example.test");
    }
    const sample = mine.find((e) => e.id === "e-0042")!;
    expect(await openMail(key, USER, "e-0042", sample.body_envelope)).toEqual({ subject: "件名42", from_name: "テスト店", from_address: "Shop@Example.TEST", text: "本文42", html: null });
    expect(db.find("emails", "e-unread")).toMatchObject({ body_state: "plain", subject: "未読" });
    expect(db.find("emails", "e-other")).toMatchObject({ body_state: "plain", subject: "他人" });

    // Again: nothing to do, nothing rewritten.
    const before = db.callsOn("emails", "update").length;
    expect(await sealPlainBatch(asAdmin(db), USER)).toEqual({ ok: true, sealed: 0, remaining: 0 });
    expect(db.callsOn("emails", "update").length).toBe(before);
  });

  it("does not seal a row twice when another tab sealed it in between", async () => {
    const db = new FakeDb();
    await registerAndActivate(db);
    seedPlain(db, 3);
    let raced = false;
    db.hooks.push((q, d) => {
      if (!raced && q.table === "emails" && q.op === "update") {
        raced = true;
        Object.assign(d.find("emails", "e-0000")!, { body_state: "sealed", body_envelope: { other: "tab" }, subject: null, from_name: null, from_address: null, text_body: null });
      }
    });
    const res = await sealPlainBatch(asAdmin(db), USER);
    expect(res).toEqual({ ok: true, sealed: 2, remaining: 0 });
    expect(db.find("emails", "e-0000")!.body_envelope).toEqual({ other: "tab" });
  });

  it("keeps the Gmail approval link of an old confirmation in plaintext", async () => {
    const db = new FakeDb();
    await registerAndActivate(db);
    db.rows("emails").push({ id: "e-gmail", user_id: USER, message_id: "g", subject: "Gmail Forwarding Confirmation", from_address: "forwarding-noreply@google.com", text_body: "https://mail-settings.google.com/mail/vf-abc", classification: "forwarding_confirmation", processing_status: "processed", body_state: "plain", body_envelope: null, created_at: "2026-10-01T00:00:00Z" });
    await sealPlainBatch(asAdmin(db), USER);
    expect(db.find("emails", "e-gmail")).toMatchObject({ body_state: "sealed", text_body: null, forwarding_confirm_url: "https://mail-settings.google.com/mail/vf-abc", from_domain: "google.com" });
  });

  it("refuses without a key in use", async () => {
    const db = new FakeDb();
    seedPlain(db, 2);
    const res = await sealPlainBatch(asAdmin(db), USER);
    expect(res.ok).toBe(false);
    expect(db.rows("emails").every((e) => e.body_state === "plain")).toBe(true);
  });
});
