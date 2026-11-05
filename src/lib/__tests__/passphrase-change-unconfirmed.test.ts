import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "@/lib/crypto/bytes";
import { createKeyPair, wrapPrivateKey } from "@/lib/crypto/key-wrap";
import { FakeDb } from "./fake-db";

/**
 * Changing the passphrase: once the new wrap is saved, a failure to read it back is not told as
 * 「うまくいきませんでした」 (the user would retry with the old passphrase, which no longer opens it).
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const OLD = "まえの合言葉ですよ123";
const NEW = "あたらしい合言葉です456";

const mocks = vi.hoisted(() => ({ db: null as unknown, rewrapOk: true }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => mocks.db }));
vi.mock("@/app/app/settings/key-actions", () => ({
  registerMailKey: vi.fn(),
  activateMailKey: vi.fn(),
  sealStoredMail: vi.fn(),
  rewrapMailKey: vi.fn(async (input: { keyId: string; wrappedPrivateKey: string; wrapIv: string; kdfSalt: string; kdfIterations: number }) => {
    if (!mocks.rewrapOk) return { ok: false, error: "user_keys update failed: boom" };
    const row = (mocks.db as FakeDb).rows("user_keys").find((k) => k.key_id === input.keyId)!;
    Object.assign(row, { wrapped_private_key: input.wrappedPrivateKey, wrap_iv: input.wrapIv, kdf_salt: input.kdfSalt, kdf_iterations: input.kdfIterations });
    return { ok: true, keyId: input.keyId };
  }),
}));

const { changePassphrase, keyErrorText, PassphraseChangeUnconfirmedError } = await import("@/lib/crypto/tab-key");

let db: FakeDb;
beforeEach(async () => {
  db = new FakeDb();
  mocks.db = db;
  mocks.rewrapOk = true;
  const pair = await createKeyPair();
  const w = await wrapPrivateKey(pair.pkcs8, OLD, USER);
  db.rows("user_keys").push({ user_id: USER, key_id: pair.keyId, public_key: toBase64(pair.publicKey), ...w, activated_at: "2026-11-06T00:00:00Z", retired_at: null });
});

/** The read-back after the save fails (the network drops, say): every user_keys read after the first. */
function failReadBack() {
  let reads = 0;
  db.hooks.push((q) => (q.table === "user_keys" && q.op === "select" && ++reads > 1 ? { data: null, error: { message: "network" } } : undefined));
}

describe("changing the passphrase: saved, but not read back", () => {
  it("says it most likely changed and asks to reload and check, not 「うまくいきませんでした」", async () => {
    failReadBack();
    const before = db.rows("user_keys")[0].wrapped_private_key;
    const err = await changePassphrase(USER, OLD, NEW).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PassphraseChangeUnconfirmedError);
    const text = keyErrorText(err);
    expect(text).toContain("読み込み直して");
    expect(text).not.toContain("うまくいきませんでした");
    // It did change: the stored wrap is the new one.
    expect(db.rows("user_keys")[0].wrapped_private_key).not.toBe(before);
  });

  it("negative control: a save the server refused is still told as a failure", async () => {
    mocks.rewrapOk = false;
    const err = await changePassphrase(USER, OLD, NEW).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(PassphraseChangeUnconfirmedError);
    expect(keyErrorText(err)).toBe("うまくいきませんでした。もう一度試してください");
  });

  it("a change that reads back fine resolves", async () => {
    await expect(changePassphrase(USER, OLD, NEW)).resolves.toBeUndefined();
  });
});
