import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "@/lib/crypto/bytes";
import { challengeAad, openBytes } from "@/lib/crypto/envelope";
import { createKeyPair, openStoredKey, wrapPrivateKey, type StoredKey } from "@/lib/crypto/key-wrap";
import { activateKey, AUTO_SEAL_MAX_BATCHES, registerKey, SEAL_BATCH_SIZE, sealRemainingPlain } from "@/lib/mail-keys";
import { FakeDb, type Row } from "./fake-db";
import { USER, asAdmin } from "./pipeline-fixtures";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * Old plaintext mail is sealed by the server by itself (only the public key is needed): the helper
 * (bounded, never throws) and every place that schedules it. Nothing is pressed any more.
 */

const PASS = "テスト用の合言葉です1234";

const mocks = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  afterThrows: false,
  db: null as unknown,
  fresh: vi.fn(),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void> | void) => {
    if (mocks.afterThrows) throw new Error("`after` was called outside a request scope");
    mocks.afterCallbacks.push(cb);
  },
  connection: async () => {},
  NextResponse: { json: (b: unknown) => Response.json(b) },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => "abcdefghjk@in.example.test" }));
vi.mock("@/lib/auth-session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth-session")>()), freshCookieSession: mocks.fresh }));

const current = (db: FakeDb) => db.rows("user_keys").filter((k) => k.user_id === USER && k.activated_at && !k.retired_at);

async function withKey(db: FakeDb) {
  const pair = await createKeyPair();
  const w = await wrapPrivateKey(pair.pkcs8, PASS, USER);
  const reg = await registerKey(asAdmin(db), USER, { publicKey: toBase64(pair.publicKey), wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations, expectedCurrentKeyId: null });
  if (!reg.ok) throw new Error(reg.error);
  const stored = db.rows("user_keys").find((k) => k.key_id === reg.keyId) as unknown as StoredKey & Row;
  const recipient = await openStoredKey(stored, PASS, USER);
  const answer = await openBytes(recipient, challengeAad(USER, reg.keyId), reg.challenge);
  const act = await activateKey(asAdmin(db), USER, { keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: null });
  if (!act.ok) throw new Error(act.error);
}

function seedPlain(db: FakeDb, n: number) {
  for (let i = 0; i < n; i++) {
    db.rows("emails").push({
      id: `e-${String(i).padStart(4, "0")}`,
      user_id: USER,
      message_id: `<m${i}@example.test>`,
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
      created_at: "2026-10-01T00:00:00Z",
    });
  }
}

const plainLeft = (db: FakeDb) => db.rows("emails").filter((e) => e.body_state === "plain").length;

beforeEach(() => {
  mocks.afterCallbacks.length = 0;
  mocks.afterThrows = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sealRemainingPlain", () => {
  it("seals everything in batches and stops at 0", async () => {
    const db = new FakeDb();
    await withKey(db);
    seedPlain(db, 120);
    const res = await sealRemainingPlain(asAdmin(db), USER);
    expect(res).toMatchObject({ sealed: 120, failed: 0, remaining: 0, stopped: "done", batches: 3 });
    expect(plainLeft(db)).toBe(0);
    // Again: nothing to do, nothing rewritten, one batch looked at.
    const before = db.callsOn("emails", "update").length;
    expect(await sealRemainingPlain(asAdmin(db), USER)).toMatchObject({ sealed: 0, remaining: 0, stopped: "done", batches: 1 });
    expect(db.callsOn("emails", "update").length).toBe(before);
  });

  it("respects maxBatches and goes on where it stopped on the next call", async () => {
    const db = new FakeDb();
    await withKey(db);
    seedPlain(db, SEAL_BATCH_SIZE * 3 + 5);
    const first = await sealRemainingPlain(asAdmin(db), USER, { maxBatches: 2 });
    expect(first).toMatchObject({ sealed: SEAL_BATCH_SIZE * 2, batches: 2, stopped: "limit" });
    expect(first.remaining).toBe(SEAL_BATCH_SIZE + 5);
    expect(plainLeft(db)).toBe(SEAL_BATCH_SIZE + 5);
    const second = await sealRemainingPlain(asAdmin(db), USER, { maxBatches: 2 });
    expect(second).toMatchObject({ sealed: SEAL_BATCH_SIZE + 5, remaining: 0, stopped: "done" });
    expect(plainLeft(db)).toBe(0);
  });

  it("by default stops after AUTO_SEAL_MAX_BATCHES batches (400 rows)", async () => {
    expect(AUTO_SEAL_MAX_BATCHES * SEAL_BATCH_SIZE).toBe(400);
    const db = new FakeDb();
    await withKey(db);
    seedPlain(db, 430);
    const res = await sealRemainingPlain(asAdmin(db), USER);
    expect(res).toMatchObject({ sealed: 400, batches: AUTO_SEAL_MAX_BATCHES, stopped: "limit", remaining: 30 });
  });

  it("is a no-op without a key: nothing is written, nothing is logged as an error", async () => {
    const db = new FakeDb();
    seedPlain(db, 5);
    const res = await sealRemainingPlain(asAdmin(db), USER);
    expect(res).toMatchObject({ sealed: 0, stopped: "no_key" });
    expect(plainLeft(db)).toBe(5);
    expect(db.callsOn("emails", "update")).toHaveLength(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("never throws on a database error (the key lookup, the read, or a client that throws)", async () => {
    const db = new FakeDb();
    await withKey(db);
    seedPlain(db, 3);
    db.hooks.unshift((q) => (q.table === "emails" && q.op === "select" ? { data: null, error: { message: "boom" } } : undefined));
    expect(await sealRemainingPlain(asAdmin(db), USER)).toMatchObject({ sealed: 0, stopped: "error" });
    expect(plainLeft(db)).toBe(3);

    const throwing = { from: () => { throw new Error("connection reset"); } } as never;
    await expect(sealRemainingPlain(throwing, USER)).resolves.toMatchObject({ sealed: 0, stopped: "error" });
  });
});

describe("scheduleSealRemaining (after)", () => {
  it("schedules one callback that seals with the given client, and never throws when after is unavailable", async () => {
    const { scheduleSealRemaining } = await import("@/lib/seal-later");
    const db = new FakeDb();
    await withKey(db);
    seedPlain(db, 4);
    scheduleSealRemaining(USER, asAdmin(db));
    expect(mocks.afterCallbacks).toHaveLength(1);
    expect(plainLeft(db)).toBe(4);
    await mocks.afterCallbacks[0]();
    expect(plainLeft(db)).toBe(0);

    // Negative control: outside a request `after` throws; the caller is not failed by it.
    mocks.afterThrows = true;
    expect(() => scheduleSealRemaining(USER, asAdmin(db))).not.toThrow();
  });

  it("a callback whose client cannot be made does not reject", async () => {
    const { scheduleSealRemaining } = await import("@/lib/seal-later");
    scheduleSealRemaining(USER, { from: () => { throw new Error("down"); } } as never);
    await expect(mocks.afterCallbacks[0]()).resolves.toBeUndefined();
  });
});

describe("each trigger schedules it", () => {
  it("the /app page schedules it for the signed-in user, and renders without a key or plaintext", async () => {
    mocks.db = new FakeDb({ parcels: [], emails: [] });
    const Page = (await import("@/app/app/page")).default;
    parseHtml(renderToStaticMarkup(await Page()));
    expect(mocks.afterCallbacks).toHaveLength(1);
    // The callback is a no-op here: no key, nothing plain, nothing thrown.
    await expect(mocks.afterCallbacks[0]()).resolves.toBeUndefined();
  });

  it("the settings password page schedules it, and the sealing runs when the key and plaintext are there", async () => {
    const db = new FakeDb();
    db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: 0 } : undefined));
    mocks.db = db;
    await withKey(db);
    seedPlain(db, 3);
    const Page = (await import("@/app/app/settings/password/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Page()));
    expect(mocks.afterCallbacks).toHaveLength(1);
    // The page itself shows no card, count or button for the plaintext mail.
    expect(textOf(root)).not.toContain("暗号化されていないメール");
    expect(findAll(root, (n) => n.tag === "button" && textOf(n) === "暗号化する")).toHaveLength(0);
    await mocks.afterCallbacks[0]();
    expect(plainLeft(db)).toBe(0);
    expect(current(db)).toHaveLength(1);
  });

  it("activateMailKey schedules it after a successful activation only", async () => {
    const mod = await vi.importActual<typeof import("@/lib/mail-keys")>("@/lib/mail-keys");
    const db = new FakeDb();
    mocks.db = db;
    mocks.fresh.mockResolvedValue({ ok: true, session: { userId: USER } });
    const { activateMailKey } = await import("@/app/app/settings/key-actions");
    // A failing activation (no key waiting) schedules nothing.
    const failed = await activateMailKey({ keyId: "a".repeat(32), challenge: toBase64(new Uint8Array(32)), expectedCurrentKeyId: null });
    expect(failed.ok).toBe(false);
    expect(mocks.afterCallbacks).toHaveLength(0);

    // A successful one does, and the older plaintext is sealed once the callback runs.
    const pair = await createKeyPair();
    const w = await wrapPrivateKey(pair.pkcs8, PASS, USER);
    const reg = await mod.registerKey(asAdmin(db), USER, { publicKey: toBase64(pair.publicKey), wrappedPrivateKey: w.wrapped_private_key, wrapIv: w.wrap_iv, kdfSalt: w.kdf_salt, kdfIterations: w.kdf_iterations, expectedCurrentKeyId: null });
    if (!reg.ok) throw new Error(reg.error);
    seedPlain(db, 6);
    const recipient = await openStoredKey(db.rows("user_keys").find((k) => k.key_id === reg.keyId) as unknown as StoredKey & Row, PASS, USER);
    const answer = await openBytes(recipient, challengeAad(USER, reg.keyId), reg.challenge);
    const ok = await activateMailKey({ keyId: reg.keyId, challenge: toBase64(answer), expectedCurrentKeyId: null });
    expect(ok).toEqual({ ok: true, keyId: reg.keyId });
    expect(mocks.afterCallbacks).toHaveLength(1);
    expect(plainLeft(db)).toBe(6);
    await mocks.afterCallbacks[0]();
    expect(plainLeft(db)).toBe(0);
  });
});
