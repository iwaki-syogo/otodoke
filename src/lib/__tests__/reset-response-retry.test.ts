import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { asAdmin } from "./pipeline-fixtures";
import { readStoredKey, registerKey, rewrapKey } from "@/lib/mail-keys";
import { openMail, sealMail, type PrivateRecipient } from "@/lib/crypto/envelope";
import { utf8 } from "@/lib/crypto/bytes";
import { rewrapStoredKey } from "@/lib/crypto/key-wrap";
import * as keyWrap from "@/lib/crypto/key-wrap";
import { FinishResetInputSchema, type FinishResetInput } from "@/lib/login-input";
import { FRESH_AUTH_MS, isFresh } from "@/lib/auth-session";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const ADDRESS = { [A]: "alpha@example.test", [B]: "beta@example.test" };
const state = vi.hoisted(() => ({ owner: "", db: null as unknown as FakeDb, secrets: new Map<string, string>(), lost: false, updates: 0, resetAt: 0 }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
const seal = vi.hoisted(() => ({ schedule: vi.fn() }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: seal.schedule }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => asAdmin(state.db) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: `e30.${Buffer.from(JSON.stringify({ sub: state.owner, amr: [{ method: "otp", timestamp: state.resetAt / 1000 }] })).toString("base64url")}.c2ln` } }, error: null }),
  getUser: async () => ({ data: { user: { id: state.owner, email: state.owner.endsWith("a") ? "alpha@example.test" : "beta@example.test" } }, error: null }),
  updateUser: async ({ password }: { password: string }) => {
    state.updates++;
    if (state.secrets.get(state.owner) === password) return { data: { user: {} }, error: { status: 422, code: "same_password" } };
    state.secrets.set(state.owner, password);
    if (state.lost) { state.lost = false; throw new TypeError("lost answer"); }
    return { data: { user: {} }, error: null };
  },
} }) }));
vi.mock("@/lib/crypto/password-v1", async (original) => {
  const actual = await original<typeof import("@/lib/crypto/password-v1")>();
  return { ...actual, deriveMaster: async (email: string, password: string) => {
    const base = await crypto.subtle.importKey("raw", utf8(actual.normalizePassword(password)), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: utf8(`otodoke/pw/v1|${actual.emailNorm(email)}`), iterations: 1000 }, base, 256);
    return crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveBits", "deriveKey"]);
  } };
});
const tab = vi.hoisted(() => ({ setTabKey: vi.fn(), forgetTabKey: vi.fn() }));
vi.mock("@/lib/crypto/tab-key", () => tab);
const { finishReset } = await import("@/lib/login-auth");
const { finishPasswordReset, disposePasswordReset, preparePasswordReset, flowMessage } = await import("@/lib/crypto/password-flows");

beforeEach(() => {
  tab.setTabKey.mockReset();
  tab.forgetTabKey.mockReset();
  seal.schedule.mockReset();
  state.resetAt = Date.now();
  state.owner = A;
  state.secrets = new Map([[A, "old-alpha"], [B, "old-beta"]]);
  state.updates = 0;
  state.lost = false;
  state.db = new FakeDb({ user_keys: [
    { user_id: A, key_id: "a".repeat(32), activated_at: "2026-11-01", retired_at: null },
    { user_id: B, key_id: "b".repeat(32), activated_at: "2026-11-01", retired_at: null },
  ] });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function ports(end = finishReset) {
  return {
    readMailKey: (input: { keyId: string | null }) => readStoredKey(asAdmin(state.db), state.owner, input),
    registerMailKey: (input: unknown) => registerKey(asAdmin(state.db), state.owner, input),
    finishReset: end,
  };
}
const INPUT = { email: ADDRESS[A], userId: A, password: "new made-up password" };
const invoke = (scope: ReturnType<typeof ports>, password = INPUT.password) => finishPasswordReset({ ...INPUT, password }, scope);
const active = () => state.db.rows("user_keys").filter((k) => k.activated_at && !k.retired_at);

describe("reset retry after a lost successful response", () => {
  it("recovers the same completed request after sixteen minutes without writes or losing newly delivered mail", async () => {
    const { scope, requests } = lostSuccess();
    expect(await invoke(scope)).toEqual({ ok: false, code: "other" });
    const key = active().find((row) => row.user_id === A)!;
    const mail = { subject: "Synthetic dispatch notice", from_name: "Example shop", from_address: "shop@example.test", text: "Synthetic mail sent after reset", html: null };
    const sealed = await sealMail({ keyId: String(key.key_id), publicKey: Uint8Array.from(Buffer.from(String(key.public_key), "base64")) }, A, "late-retry-mail", mail);
    const keysBefore = structuredClone(state.db.rows("user_keys"));
    const secretsBefore = new Map(state.secrets);
    const rpcsBefore = state.db.rpcCalls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(state.resetAt + FRESH_AUTH_MS + 60_000);
    expect(isFresh([{ method: "otp", at: state.resetAt }], "reset")).toBe(false);

    expect(await invoke(scope)).toEqual({ ok: true });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(state.db.rows("user_keys")).toEqual(keysBefore);
    expect(state.secrets).toEqual(secretsBefore);
    expect(state.db.rpcCalls).toHaveLength(rpcsBefore);
    expect(state.updates).toBe(1);
    // The existing sealing follow-up runs on both the first success and its recovered response.
    expect(seal.schedule).toHaveBeenCalledTimes(2);
    const opened = tab.setTabKey.mock.calls.at(-1)![1] as PrivateRecipient;
    expect(opened.keyId).toBe(key.key_id);
    expect(await openMail(opened, A, "late-retry-mail", sealed)).toEqual(mail);
  });

  it("keeps the activated key and opens mail delivered between the lost response and retry", async () => {
    let lose = true;
    const scope = ports(async (input) => {
      const done = await finishReset(input);
      expect(done.ok).toBe(true);
      if (lose) { lose = false; throw new TypeError("successful response lost"); }
      return done;
    });
    const input = { email: ADDRESS[A], userId: A, password: "new made-up password" };
    expect(await finishPasswordReset(input, scope)).toEqual({ ok: false, code: "other" });
    const key = active().find((row) => row.user_id === A)!;
    const firstKey = String(key.key_id);
    const mail = { subject: "Synthetic dispatch notice", from_name: "Example shop", from_address: "shop@example.test", text: "Synthetic mail sent after reset", html: null };
    const sealed = await sealMail({ keyId: firstKey, publicKey: Uint8Array.from(Buffer.from(String(key.public_key), "base64")) }, A, "synthetic-mail", mail);
    expect(await finishPasswordReset(input, scope)).toEqual({ ok: true });
    expect(active().find((row) => row.user_id === A)!.key_id).toBe(firstKey);
    const opened = tab.setTabKey.mock.calls.at(-1)![1] as PrivateRecipient;
    expect(opened.keyId).toBe(firstKey);
    expect(await openMail(opened, A, "synthetic-mail", sealed)).toEqual(mail);
    expect(state.db.rows("user_keys").filter((row) => row.user_id === A)).toHaveLength(2);
    expect(state.updates).toBe(1);
  });
});

/** Lose only the transport answer after the real server has activated the key. */
function lostSuccess() {
  const requests: FinishResetInput[] = [];
  let lose = true;
  const scope = ports(async (input) => {
    requests.push(input as FinishResetInput);
    const result = await finishReset(input);
    if (result.ok && lose) { lose = false; throw new TypeError("successful response lost"); }
    return result;
  });
  return { scope, requests };
}

describe("expired reset completion boundaries", () => {
  it("rejects an unfinished pending request after the reset window without changing Auth or keys", async () => {
    let request!: FinishResetInput;
    const scope = ports(async (input) => { request = FinishResetInputSchema.parse(input); return { ok: false, code: "network" }; });
    expect(await invoke(scope)).toEqual({ ok: false, code: "network" });
    const before = structuredClone(state.db.rows("user_keys"));
    const rpcs = state.db.rpcCalls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(state.resetAt + FRESH_AUTH_MS + 60_000);
    expect(await finishReset(request)).toEqual({ ok: false, code: "reset_expired" });
    expect(state.db.rows("user_keys")).toEqual(before);
    expect(state.db.rpcCalls).toHaveLength(rpcs);
    expect(state.updates).toBe(0);
    expect(state.secrets.get(A)).toBe("old-alpha");
    expect(seal.schedule).not.toHaveBeenCalled();
  });

  it.each([
    ["cookie owner", "signed_out"],
    ["expected owner", "signed_out"],
    ["expected email", "signed_out"],
    ["challenge", "key_challenge_failed"],
    ["original wrap", "key_wrap_changed"],
    ["missing wrap", "key_wrap_changed"],
    ["current key", "key_in_use_changed"],
  ] as const)("still rejects a different %s after the window, with no Auth or key writes", async (changed, code) => {
    const { scope, requests } = lostSuccess();
    expect(await invoke(scope)).toEqual({ ok: false, code: "other" });
    const request = { ...requests[0] };
    if (changed === "cookie owner") state.owner = B;
    if (changed === "expected owner") request.expectedUserId = B;
    if (changed === "expected email") request.expectedEmailNorm = ADDRESS[B];
    if (changed === "challenge") request.challenge = Buffer.alloc(32, 99).toString("base64");
    if (changed === "original wrap") request.expectedWrappedPrivateKey = Buffer.alloc(154, 99).toString("base64");
    if (changed === "missing wrap") delete request.expectedWrappedPrivateKey;
    if (changed === "current key") expect(await invoke(ports(), "a later reset password")).toEqual({ ok: true });
    const before = structuredClone(state.db.rows("user_keys"));
    const secrets = new Map(state.secrets);
    const updates = state.updates;
    const rpcs = state.db.rpcCalls.length;
    const followUps = seal.schedule.mock.calls.length;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(state.resetAt + FRESH_AUTH_MS + 60_000);
    expect(await finishReset(request)).toEqual({ ok: false, code });
    expect(state.db.rows("user_keys")).toEqual(before);
    expect(state.secrets).toEqual(secrets);
    expect(state.updates).toBe(updates);
    expect(state.db.rpcCalls).toHaveLength(rpcs);
    expect(seal.schedule).toHaveBeenCalledTimes(followUps);
  });
});

describe("reset operation boundaries", () => {
  it("a screen disposed during key generation sends no registration that can replace a newer pending key", async () => {
    const create = keyWrap.createWrappedKey;
    let generating!: () => void;
    let releaseGeneration!: () => void;
    let pending!: () => void;
    let releaseNew!: () => void;
    const generationStarted = new Promise<void>((resolve) => { generating = resolve; });
    const generationGate = new Promise<void>((resolve) => { releaseGeneration = resolve; });
    const newPending = new Promise<void>((resolve) => { pending = resolve; });
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
    vi.spyOn(keyWrap, "createWrappedKey").mockImplementationOnce(async (...args) => {
      const made = await create(...args);
      generating();
      await generationGate;
      return made;
    });
    const oldScope = ports();
    const oldRegister = vi.fn(oldScope.registerMailKey);
    oldScope.registerMailKey = oldRegister;
    const oldRun = invoke(oldScope);
    await generationStarted;
    disposePasswordReset(oldScope);
    const newScope = ports(async (input) => { pending(); await newGate; return finishReset(input); });
    const newRun = invoke(newScope, "newer screen password");
    await newPending;
    const newerKey = state.db.rows("user_keys").find((row) => row.user_id === A && !row.activated_at)!.key_id;
    releaseGeneration();
    const oldResult = await oldRun;
    releaseNew();
    const newResult = await newRun;
    expect(oldRegister.mock.calls.length).toBe(0);
    expect(oldResult).toEqual({ ok: false, code: "signed_out" });
    expect(newResult).toEqual({ ok: true });
    expect(active().find((row) => row.user_id === A)!.key_id).toBe(newerKey);
    expect(state.updates).toBe(1);
  });

  it("StrictMode setup-cleanup-setup leaves the same screen ready to submit", async () => {
    const scope = ports();
    preparePasswordReset(scope);
    disposePasswordReset(scope);
    preparePasswordReset(scope);
    expect(await invoke(scope)).toEqual({ ok: true });
    expect(state.updates).toBe(1);
  });

  it("reuses the same pending key after the Auth update answer was lost", async () => {
    state.lost = true;
    const scope = ports();
    expect(await invoke(scope)).toEqual({ ok: false, code: "secret_change_unknown" });
    const pending = state.db.rows("user_keys").find((row) => row.user_id === A && !row.activated_at)!;
    expect(await invoke(scope)).toEqual({ ok: true });
    expect(active().find((row) => row.user_id === A)!.key_id).toBe(pending.key_id);
    expect(state.db.rows("user_keys").filter((row) => row.user_id === A)).toHaveLength(2);
  });

  it("recovers when the activation RPC committed but its response was lost", async () => {
    const rpc = state.db.rpc.bind(state.db);
    let lose = true;
    vi.spyOn(state.db, "rpc").mockImplementation(async (name, args) => {
      const result = await rpc(name, args);
      if (name === "activate_user_key_checked" && lose) { lose = false; throw new TypeError("activation response lost"); }
      return result;
    });
    const scope = ports();
    expect(await invoke(scope)).toEqual({ ok: false, code: "key_failed" });
    const keyId = active().find((row) => row.user_id === A)!.key_id;
    expect(await invoke(scope)).toEqual({ ok: true });
    expect(active().find((row) => row.user_id === A)!.key_id).toBe(keyId);
    expect(state.updates).toBe(1);
  });

  it("concurrent calls in one screen register and activate only one key", async () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scope = ports(async (input) => { entered(); await gate; return finishReset(input); });
    const first = invoke(scope);
    await waiting;
    const second = invoke(scope);
    release();
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(state.updates).toBe(1);
    expect(state.db.rows("user_keys").filter((row) => row.user_id === A)).toHaveLength(2);
    expect(state.db.rpcCalls.filter((call) => call.name === "activate_user_key_checked")).toHaveLength(1);
  });

  it.each([0, FRESH_AUTH_MS + 60_000])("a changed password cannot turn an unresolved retry into another key rotation after %i ms", async (elapsed) => {
    const { scope } = lostSuccess();
    expect((await invoke(scope)).ok).toBe(false);
    const before = structuredClone(state.db.rows("user_keys"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(state.resetAt + elapsed);
    expect(await invoke(scope, "a different new password")).toEqual({ ok: false, code: "reset_retry_changed" });
    expect(flowMessage("reset_retry_changed")).toBe("同じ新しいパスワードで、もう一度お試しください。");
    expect(state.db.rows("user_keys")).toEqual(before);
    expect(state.updates).toBe(1);
    expect(await invoke(scope)).toEqual({ ok: true });
  });

  it("a changed cookie owner still fails I1 before Auth or key writes", async () => {
    const { scope } = lostSuccess();
    expect((await invoke(scope)).ok).toBe(false);
    const before = structuredClone(state.db.rows("user_keys"));
    state.owner = B;
    expect(await invoke(scope)).toEqual({ ok: false, code: "signed_out" });
    expect(state.db.rows("user_keys")).toEqual(before);
    expect(state.secrets.get(B)).toBe("old-beta");
    expect(state.updates).toBe(1);
  });

  it("a later operation cannot have its current key retired by the older retry", async () => {
    const { scope } = lostSuccess();
    expect((await invoke(scope)).ok).toBe(false);
    expect(await invoke(ports(), "another operation password")).toEqual({ ok: true });
    const before = structuredClone(state.db.rows("user_keys"));
    const updates = state.updates;
    expect(await invoke(scope)).toEqual({ ok: false, code: "key_in_use_changed" });
    expect(state.db.rows("user_keys")).toEqual(before);
    expect(state.updates).toBe(updates);
  });

  it("the client rechecks the current key after server success and never restores an outdated tab key", async () => {
    const scope = ports(async (input) => {
      const result = await finishReset(input);
      expect(result.ok).toBe(true);
      expect(await invoke(ports(), "a later operation password")).toEqual({ ok: true });
      return result;
    });
    expect(await invoke(scope)).toEqual({ ok: false, code: "key_in_use_changed" });
    const current = active().find((row) => row.user_id === A)!;
    expect(tab.setTabKey).toHaveBeenCalledTimes(1);
    expect((tab.setTabKey.mock.calls[0][1] as PrivateRecipient).keyId).toBe(current.key_id);
    expect(state.updates).toBe(2);
  });

  it.each([0, FRESH_AUTH_MS + 60_000])("the server rejects an old request after a same-key rewrap without rewriting Auth after %i ms", async (elapsed) => {
    const { scope, requests } = lostSuccess();
    expect((await invoke(scope)).ok).toBe(false);
    const request = requests[0];
    const stored = await readStoredKey(asAdmin(state.db), A, { keyId: null });
    if (!stored.ok || !stored.key) throw new Error("missing test key");
    const { deriveMaster, kekFor, newKdfSalt, authSecretHex } = await import("@/lib/crypto/password-v1");
    const oldMaster = await deriveMaster(INPUT.email, INPUT.password);
    const newMaster = await deriveMaster(INPUT.email, "password changed afterwards");
    const salt = newKdfSalt();
    const wrap = await rewrapStoredKey(stored.key, await kekFor(oldMaster, stored.key.kdf_salt), await kekFor(newMaster, salt), salt, A);
    expect((await rewrapKey(asAdmin(state.db), A, { keyId: stored.key.key_id, previousWrappedPrivateKey: stored.key.wrapped_private_key, wrappedPrivateKey: wrap.wrapped_private_key, wrapIv: wrap.wrap_iv, kdfSalt: wrap.kdf_salt, kdfIterations: wrap.kdf_iterations })).ok).toBe(true);
    const changedSecret = await authSecretHex(newMaster);
    state.secrets.set(A, changedSecret);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(state.resetAt + elapsed);
    expect(await finishReset(request)).toEqual({ ok: false, code: "key_wrap_changed" });
    expect(state.secrets.get(A)).toBe(changedSecret);
    expect(state.updates).toBe(1);
  });

  it("an active key still requires the challenge, original wrap, and expected owner", async () => {
    const { scope, requests } = lostSuccess();
    expect((await invoke(scope)).ok).toBe(false);
    const request = requests[0];
    expect(await finishReset({ ...request, challenge: Buffer.alloc(32, 99).toString("base64") })).toEqual({ ok: false, code: "key_challenge_failed" });
    const { expectedWrappedPrivateKey: _wrap, ...withoutWrap } = request;
    expect(_wrap).toBeDefined();
    expect(await finishReset(withoutWrap)).toEqual({ ok: false, code: "key_wrap_changed" });
    expect(await finishReset({ ...request, expectedEmailNorm: ADDRESS[B] })).toEqual({ ok: false, code: "signed_out" });
    expect(state.updates).toBe(1);
  });

  it("disposing the screen drops recovery and a late success cannot restore its tab key", async () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scope = ports(async (input) => { const result = await finishReset(input); entered(); await gate; return result; });
    const running = invoke(scope);
    await waiting;
    disposePasswordReset(scope);
    release();
    expect(await running).toEqual({ ok: false, code: "signed_out" });
    expect(tab.setTabKey).not.toHaveBeenCalled();
    const before = structuredClone(state.db.rows("user_keys"));
    expect(await invoke(scope)).toEqual({ ok: false, code: "signed_out" });
    expect(state.db.rows("user_keys")).toEqual(before);
  });

  it("a new effect setup does not revive the old disposed operation", async () => {
    let entered!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const scope = ports(async (input) => { const result = await finishReset(input); entered(); await gate; return result; });
    preparePasswordReset(scope);
    const running = invoke(scope);
    await waiting;
    disposePasswordReset(scope);
    preparePasswordReset(scope);
    release();
    expect(await running).toEqual({ ok: false, code: "signed_out" });
    expect(tab.setTabKey).not.toHaveBeenCalled();
    expect(state.updates).toBe(1);
  });
});
