import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fromBase64, toBase64 } from "@/lib/crypto/bytes";
import { challengeAad, openBytes, openMail, type PrivateRecipient } from "@/lib/crypto/envelope";
import { createKeyPair, openStoredKey, wrapPrivateKey, type StoredKey } from "@/lib/crypto/key-wrap";
import { activateKey, countPlainRead, readRetiredKeys, readSealedEnvelope, readStoredKey, registerKey, rewrapKey, sealPlainBatch, SEAL_BATCH_SIZE } from "@/lib/mail-keys";
import { processInboundEmail } from "@/lib/pipeline";
import { KEY_IN_USE_CHANGED, KEY_WRAP_CHANGED } from "@/lib/crypto/key-messages";
import { FakeDb, type Row } from "./fake-db";
import { OTHER, USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

const PASS = "テスト用の合言葉です1234";

const current = (db: FakeDb, userId = USER) => db.rows("user_keys").filter((k) => k.user_id === userId && k.activated_at && !k.retired_at);
/** The key in use as the settings screen shows it when drawn (what the browser sends back). */
const shownKeyId = (db: FakeDb | null, userId = USER) => (db ? ((current(db, userId)[0]?.key_id as string | undefined) ?? null) : null);

async function newRegistration(passphrase = PASS, userId = USER, db: FakeDb | null = null) {
  const pair = await createKeyPair();
  const w = await wrapPrivateKey(pair.pkcs8, passphrase, userId);
  return {
    pair,
    input: { publicKey: toBase64(pair.publicKey), wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations, expectedCurrentKeyId: shownKeyId(db, userId) },
  };
}

const stored = (db: FakeDb, keyId: string) => db.rows("user_keys").find((k) => k.key_id === keyId) as unknown as StoredKey & Row;

/** The browser's side of registration, done against the row as the database holds it. */
async function registerAndActivate(db: FakeDb, passphrase = PASS, userId = USER): Promise<PrivateRecipient> {
  const { input } = await newRegistration(passphrase, userId, db);
  const reg = await registerKey(asAdmin(db), userId, input);
  if (!reg.ok) throw new Error(reg.error);
  const recipient = await openStoredKey(stored(db, reg.keyId), passphrase, userId);
  const answer = await openBytes(recipient, challengeAad(userId, reg.keyId), reg.challenge);
  const act = await activateKey(asAdmin(db), userId, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: input.expectedCurrentKeyId });
  if (!act.ok) throw new Error(act.error);
  return recipient;
}

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
    expect(await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: input.expectedCurrentKeyId })).toEqual({ ok: true, keyId: reg.keyId });
    expect(current(db)).toHaveLength(1);
    expect(stored(db, reg.keyId).challenge_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a wrong answer to the challenge and keeps the key out of use", async () => {
    const db = new FakeDb();
    const { input } = await newRegistration();
    const reg = await registerKey(asAdmin(db), USER, input);
    if (!reg.ok) throw new Error(reg.error);
    const res = await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(new Uint8Array(32)), expectedCurrentKeyId: null });
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
    expect((await activateKey(asAdmin(db), OTHER, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: input.expectedCurrentKeyId })).ok).toBe(false);
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

  it("retires the old key and activates the new one in one database call, never two writes", async () => {
    const db = new FakeDb();
    const first = await registerAndActivate(db);
    const { input } = await newRegistration("あたらしい合言葉ですよ", USER, db);
    const reg = await registerKey(asAdmin(db), USER, input);
    if (!reg.ok) throw new Error(reg.error);
    const recipient = await openStoredKey(stored(db, reg.keyId), "あたらしい合言葉ですよ", USER);
    const answer = await openBytes(recipient, challengeAad(USER, reg.keyId), reg.challenge);
    const updatesBefore = db.callsOn("user_keys", "update").length;
    const rpcBefore = db.rpcCalls.length;

    expect(await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: input.expectedCurrentKeyId })).toEqual({ ok: true, keyId: reg.keyId });
    expect(db.callsOn("user_keys", "update").length).toBe(updatesBefore);
    const calls = db.rpcCalls.slice(rpcBefore);
    expect(calls.map((c) => c.name)).toEqual(["activate_user_key_checked"]);
    // The hash of what the browser opened, for the database to check again (not the stored value
    // echoed back), and the key in use the browser's screen was drawn with.
    const { sha256, toHex } = await import("@/lib/crypto/bytes");
    expect(calls[0].args).toEqual({ p_user_id: USER, p_key_id: reg.keyId, p_challenge_hash: toHex(await sha256(answer)), p_expected_current_key_id: first.keyId });
    expect(current(db).map((k) => k.key_id)).toEqual([reg.keyId]);
    expect(stored(db, first.keyId).retired_at).toBeTruthy();
  });

  it("when the database refuses the activation, the old key stays in use", async () => {
    const db = new FakeDb();
    const first = await registerAndActivate(db);
    const { input } = await newRegistration(PASS, USER, db);
    const reg = await registerKey(asAdmin(db), USER, input);
    if (!reg.ok) throw new Error(reg.error);
    const answer = await openBytes(await openStoredKey(stored(db, reg.keyId), PASS, USER), challengeAad(USER, reg.keyId), reg.challenge);
    db.rpc = (name: string, args?: unknown) => {
      db.rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: { message: "activate_user_key: no matching key is waiting to be activated" } });
    };
    const res = await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: input.expectedCurrentKeyId });
    expect(res.ok).toBe(false);
    expect(current(db).map((k) => k.key_id)).toEqual([first.keyId]);
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
    const res = await rewrapKey(asAdmin(db), USER, { keyId: key.keyId, previousWrappedPrivateKey: row.wrapped_private_key, wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations });
    expect(res.ok).toBe(true);
    const reopened = await openStoredKey(stored(db, key.keyId), "かえた合言葉ですよ!!", USER);
    expect(toBase64(reopened.publicKey)).toBe(toBase64(key.publicKey));
    await expect(openStoredKey(stored(db, key.keyId), PASS, USER)).rejects.toThrow();
  });

  it("refuses a passphrase field and a retired key", async () => {
    const db = new FakeDb();
    const key = await registerAndActivate(db);
    const row = stored(db, key.keyId);
    const base = { keyId: key.keyId, previousWrappedPrivateKey: row.wrapped_private_key, wrappedPrivateKey: row.wrapped_private_key, wrapIv: row.wrap_iv, kdfSalt: row.kdf_salt, kdfIterations: row.kdf_iterations };
    expect((await rewrapKey(asAdmin(db), USER, { ...base, passphrase: PASS })).ok).toBe(false);
    row.retired_at = "2026-11-05T00:00:00Z";
    expect((await rewrapKey(asAdmin(db), USER, base)).ok).toBe(false);
  });

  it("stores a new wrap only over the wrap the browser opened (another tab's change is not overwritten)", async () => {
    const db = new FakeDb();
    const key = await registerAndActivate(db);
    const row = stored(db, key.keyId);
    const opened = row.wrapped_private_key;
    const pkcs8 = await import("@/lib/crypto/key-wrap").then((m) => m.unwrapPrivateKeyBytes(row, PASS, USER));
    // Tab A changes the passphrase first.
    const a = await wrapPrivateKey(pkcs8, "タブAの合言葉ですよ!", USER);
    expect((await rewrapKey(asAdmin(db), USER, { keyId: key.keyId, previousWrappedPrivateKey: opened, wrappedPrivateKey: a.wrapped_private_key, wrapIv: a.wrap_iv, kdfSalt: a.kdf_salt, kdfIterations: a.kdf_iterations })).ok).toBe(true);
    // Tab B opened the same old wrap before that: its change is refused, tab A's wrap stays.
    const b = await wrapPrivateKey(pkcs8, "タブBの合言葉ですよ!", USER);
    const res = await rewrapKey(asAdmin(db), USER, { keyId: key.keyId, previousWrappedPrivateKey: opened, wrappedPrivateKey: b.wrapped_private_key, wrapIv: b.wrap_iv, kdfSalt: b.kdf_salt, kdfIterations: b.kdf_iterations });
    expect(res).toEqual({ ok: false, error: KEY_WRAP_CHANGED });
    expect(stored(db, key.keyId).wrapped_private_key).toBe(a.wrapped_private_key);
    await expect(openStoredKey(stored(db, key.keyId), "タブAの合言葉ですよ!", USER)).resolves.toBeTruthy();
  });
});

describe("what the browser reads through the Server Actions", () => {
  it("a key: the one in use or one by id, the owner's only, with the columns opening needs and nothing else", async () => {
    const db = new FakeDb();
    const first = await registerAndActivate(db);
    const second = await registerAndActivate(db, "あたらしい合言葉ですよ");
    await registerAndActivate(db, PASS, OTHER);

    const inUse = await readStoredKey(asAdmin(db), USER, { keyId: null });
    if (!inUse.ok) throw new Error(inUse.error);
    expect(inUse.key?.key_id).toBe(second.keyId);
    // Only the columns opening needs are asked for (no challenge hash, no dates, no user id).
    expect(db.callsOn("user_keys", "select").at(-1)?.columns).toBe("key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations");
    const retired = await readStoredKey(asAdmin(db), USER, { keyId: first.keyId });
    expect(retired.ok && retired.key?.key_id).toBe(first.keyId);
    // Another user's key by id: nothing.
    const otherKeyId = current(db, OTHER)[0].key_id as string;
    expect(await readStoredKey(asAdmin(db), USER, { keyId: otherKeyId })).toEqual({ ok: true, key: null });
    // Refuses anything but a key id, and unknown fields.
    for (const bad of [{ keyId: "x" }, { keyId: null, passphrase: PASS }, {}]) expect((await readStoredKey(asAdmin(db), USER, bad)).ok).toBe(false);

    const old = await readRetiredKeys(asAdmin(db), USER);
    expect(old.ok && old.keys.map((k) => k.key_id)).toEqual([first.keyId]);
  });

  it("a sealed mail: its envelope only, the owner's only", async () => {
    const db = new FakeDb();
    await registerAndActivate(db);
    const id = "11111111-2222-4333-8444-555555555555";
    db.rows("emails").push({ id, user_id: USER, body_state: "sealed", body_envelope: { kid: "k" }, processing_status: "processed" });
    expect(await readSealedEnvelope(asAdmin(db), USER, { emailId: id })).toEqual({ ok: true, envelope: { kid: "k" } });
    expect(db.callsOn("emails", "select").at(-1)?.columns).toBe("body_envelope");
    expect(await readSealedEnvelope(asAdmin(db), OTHER, { emailId: id })).toEqual({ ok: true, envelope: null });
    for (const bad of [{ emailId: "e1" }, { emailId: `${id}),or(` }, { emailId: id, x: 1 }]) expect((await readSealedEnvelope(asAdmin(db), USER, bad)).ok).toBe(false);
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
    expect(await sealPlainBatch(asAdmin(db), USER)).toEqual({ ok: true, sealed: 0, failed: [], next: null, remaining: 0 });
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
    expect(res).toEqual({ ok: true, sealed: 2, failed: [], next: "e-0002", remaining: 0 });
    expect(db.find("emails", "e-0000")!.body_envelope).toEqual({ other: "tab" });
  });

  it("a row that cannot be sealed is skipped and counted, and the run still reaches the end", async () => {
    const db = new FakeDb();
    await registerAndActivate(db);
    seedPlain(db, 120);
    // The oldest row (picked first by every batch) and one in the middle refuse to be written.
    const broken = new Set(["e-0000", "e-0070"]);
    db.hooks.push((q) => {
      if (q.table !== "emails" || q.op !== "update") return;
      const id = q.filters.find((f) => f.method === "eq" && f.args[0] === "id")?.args[1];
      if (broken.has(String(id))) return { data: null, error: { message: "new row violates a check" } };
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    // What the browser does: pass back the cursor, call again until 0 remain.
    let after: string | null = null;
    const failed: string[] = [];
    const steps: Array<{ sealed: number; failed: number; remaining: number }> = [];
    for (let i = 0; i < 6; i++) {
      const res = await sealPlainBatch(asAdmin(db), USER, { after });
      if (!res.ok) throw new Error(res.error);
      failed.push(...res.failed);
      after = res.next;
      steps.push({ sealed: res.sealed, failed: res.failed.length, remaining: res.remaining });
      if (res.remaining === 0) break;
    }
    expect(steps).toEqual([
      { sealed: 49, failed: 1, remaining: 70 },
      { sealed: 49, failed: 1, remaining: 20 },
      { sealed: 20, failed: 0, remaining: 0 },
    ]);
    expect(failed.sort()).toEqual(["e-0000", "e-0070"]);
    const plain = db.rows("emails").filter((e) => e.body_state === "plain").map((e) => e.id);
    expect(plain.sort()).toEqual(["e-0000", "e-0070"]);
    // Logged by id only, never the mail.
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/件名|本文|テスト店/);
    log.mockRestore();
  });

  it("more than 200 rows that cannot be sealed do not hold the run back (the cursor moves past them)", async () => {
    const db = new FakeDb();
    await registerAndActivate(db);
    seedPlain(db, 260);
    // Every row but the last 10 refuses to be written: past the old cap of 200 skipped ids.
    db.hooks.push((q) => {
      if (q.table !== "emails" || q.op !== "update") return;
      const id = String(q.filters.find((f) => f.method === "eq" && f.args[0] === "id")?.args[1]);
      if (Number(id.slice(2)) < 250) return { data: null, error: { message: "refused" } };
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let after: string | null = null;
    let failedCount = 0;
    let calls = 0;
    for (;;) {
      const res = await sealPlainBatch(asAdmin(db), USER, { after });
      calls++;
      if (!res.ok) throw new Error(res.error);
      failedCount += res.failed.length;
      expect(res.next).not.toBe(after);
      after = res.next;
      if (res.remaining === 0 || calls > 10) break;
    }
    log.mockRestore();
    expect(calls).toBe(6);
    expect(failedCount).toBe(250);
    expect(db.rows("emails").filter((e) => e.body_state === "sealed").map((e) => e.id).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `e-0${250 + i}`));
  });

  it("negative control: without passing the cursor back, the run never gets past the oldest one", async () => {
    const db = new FakeDb();
    await registerAndActivate(db);
    seedPlain(db, 60);
    db.hooks.push((q) => {
      if (q.table !== "emails" || q.op !== "update") return;
      if (q.filters.some((f) => f.method === "eq" && f.args[0] === "id" && f.args[1] === "e-0000")) return { data: null, error: { message: "refused" } };
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const first = await sealPlainBatch(asAdmin(db), USER);
    const again = await sealPlainBatch(asAdmin(db), USER);
    log.mockRestore();
    if (!first.ok || !again.ok) throw new Error("unexpected");
    expect(first.failed).toEqual(["e-0000"]);
    // The same row is picked first again: only the cursor moves the run past it.
    expect(again.failed).toEqual(["e-0000"]);
  });

  it("refuses a cursor that is not an id (it goes into a PostgREST filter), and the old skip list", async () => {
    const db = new FakeDb();
    await registerAndActivate(db);
    for (const after of ["a,b", "x)", '"q"', "e".repeat(37), ""]) {
      expect((await sealPlainBatch(asAdmin(db), USER, { after })).ok).toBe(false);
    }
    expect((await sealPlainBatch(asAdmin(db), USER, { after: null, other: 1 })).ok).toBe(false);
    expect((await sealPlainBatch(asAdmin(db), USER, { skip: [] })).ok).toBe(false);
  });

  it("does not count the public sample mails as plaintext the operator could read", async () => {
    const db = new FakeDb();
    await registerAndActivate(db);
    seedPlain(db, 4);
    // Two of them were loaded from the repository's anonymized samples (provider id 'demo:…').
    Object.assign(db.find("emails", "e-0001")!, { provider_email_id: "demo:amazon-1.eml" });
    Object.assign(db.find("emails", "e-0003")!, { provider_email_id: "demo:yamato-2.eml" });
    // A real mail with no provider id is still counted (never dropped by a null).
    Object.assign(db.find("emails", "e-0002")!, { provider_email_id: null });
    expect(await countPlainRead(asAdmin(db), USER)).toBe(2);
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

describe("activate_user_key in migration A (exercised on Postgres 17; this pins its grants)", () => {
  const sql = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/20261106120000_mail_encryption_keys.sql"), "utf8");
  const fn = sql.slice(sql.indexOf("create function public.activate_user_key"));

  it("is security definer with an empty search_path, executable by service_role only", () => {
    expect(fn).toMatch(/security definer\s+set search_path = ''/);
    expect(sql).toContain("revoke all on function public.activate_user_key(uuid, text, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.activate_user_key(uuid, text, text) to service_role;");
  });

  it("checks the challenge hash and does both writes in the one call", () => {
    expect(fn).toMatch(/challenge_hash = p_challenge_hash/);
    expect(fn.indexOf("set retired_at")).toBeGreaterThan(0);
    expect(fn.indexOf("set activated_at")).toBeGreaterThan(fn.indexOf("set retired_at"));
    expect(readFileSync(path.resolve(__dirname, "../../../supabase/rollback/20261106120000_mail_encryption_keys.down.sql"), "utf8")).toContain("drop function public.activate_user_key(uuid, text, text);");
  });
});

describe("activate_user_key_checked (migration 20261106150000, exercised on Postgres 17; this pins it)", () => {
  const sql = readFileSync(path.resolve(__dirname, "../../../supabase/migrations/20261106150000_activate_user_key_checked.sql"), "utf8");
  const fn = sql.slice(sql.indexOf("create function public.activate_user_key_checked"));

  it("is security definer with an empty search_path, executable by service_role only", () => {
    expect(fn).toMatch(/security definer\s+set search_path = ''/);
    expect(sql).toContain("revoke all on function public.activate_user_key_checked(uuid, text, text, text) from public, anon, authenticated;");
    expect(sql).toContain("grant execute on function public.activate_user_key_checked(uuid, text, text, text) to service_role;");
  });

  it("checks the key in use against the expected one under the lock, before retiring anything", () => {
    const lock = fn.indexOf("for update");
    const check = fn.indexOf("v_current is distinct from p_expected_current_key_id");
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
    expect(fn.indexOf("set retired_at")).toBeGreaterThan(check);
    // The message the server maps to the screen's words (src/lib/crypto/key-messages.ts).
    expect(fn).toContain(`activate_user_key: ${KEY_IN_USE_CHANGED}`);
    expect(readFileSync(path.resolve(__dirname, "../../../supabase/rollback/20261106150000_activate_user_key_checked.down.sql"), "utf8")).toContain("drop function public.activate_user_key_checked(uuid, text, text, text);");
  });
});
