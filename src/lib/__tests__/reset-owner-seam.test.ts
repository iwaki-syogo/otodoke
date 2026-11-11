import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { asAdmin } from "./pipeline-fixtures";
import { readStoredKey, registerKey } from "@/lib/mail-keys";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const ADDRESS = { [A]: "alpha@example.test", [B]: "beta@example.test" };
const state = vi.hoisted(() => ({ owner: "", db: null as unknown as FakeDb, secrets: new Map<string, string>(), lost: false, updates: 0 }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/seal-later", () => ({ scheduleSealRemaining: () => {} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => asAdmin(state.db) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {
  getSession: async () => ({ data: { session: { access_token: `e30.${Buffer.from(JSON.stringify({ sub: state.owner, amr: [{ method: "otp", timestamp: Date.now() / 1000 }] })).toString("base64url")}.c2ln` } }, error: null }),
  getUser: async () => ({ data: { user: { id: state.owner, email: state.owner.endsWith("a") ? "alpha@example.test" : "beta@example.test" } }, error: null }),
  updateUser: async ({ password }: { password: string }) => {
    state.updates++;
    state.secrets.set(state.owner, password);
    if (state.lost) { state.lost = false; throw new TypeError("lost answer"); }
    return { data: { user: {} }, error: null };
  },
} }) }));
vi.mock("@/lib/crypto/password-v1", async (original) => {
  const actual = await original<typeof import("@/lib/crypto/password-v1")>();
  return { ...actual, deriveMaster: async () => crypto.subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveBits", "deriveKey"]) };
});
const { finishReset } = await import("@/lib/login-auth");
const { finishPasswordReset } = await import("@/lib/crypto/password-flows");

beforeEach(() => {
  state.owner = A;
  state.secrets = new Map([[A, "old-alpha"], [B, "old-beta"]]);
  state.updates = 0;
  state.lost = false;
  state.db = new FakeDb({ user_keys: [
    { user_id: A, key_id: "a".repeat(32), activated_at: "2026-11-01", retired_at: null },
    { user_id: B, key_id: "b".repeat(32), activated_at: "2026-11-01", retired_at: null },
  ] });
});

function ports(end = finishReset) {
  return {
    readMailKey: (input: { keyId: string | null }) => readStoredKey(asAdmin(state.db), state.owner, input),
    registerMailKey: (input: unknown) => registerKey(asAdmin(state.db), state.owner, input),
    finishReset: end,
  };
}
const reset = (end = finishReset) => finishPasswordReset({ email: ADDRESS[A], userId: A, password: "new made-up password" }, ports(end));
const active = () => state.db.rows("user_keys").filter((k) => k.activated_at && !k.retired_at);

describe("reset owner and pending-key seam", () => {
  it("rejects switching to B after A opened the challenge without changing either secret or active key", async () => {
    const before = structuredClone(active());
    const result = await reset(async (input) => { state.owner = B; return finishReset(input); });
    expect(state.updates).toBe(0);
    expect(result).toEqual({ ok: false, code: "signed_out" });
    expect([...state.secrets]).toEqual([[A, "old-alpha"], [B, "old-beta"]]);
    expect(active()).toEqual(before);
  });

  it("rejects an email mismatch for the same user before changing the secret", async () => {
    expect(await reset((input) => finishReset({ ...(input as object), expectedEmailNorm: ADDRESS[B] }))).toEqual({ ok: false, code: "signed_out" });
    expect(state.updates).toBe(0);
    expect(active().map((k) => k.key_id)).toEqual(["a".repeat(32), "b".repeat(32)]);
  });

  it.each(["challenge", "owner", "current"] as const)("rejects a changed %s before changing the secret", async (kind) => {
    const before = structuredClone(active());
    const result = await reset((input) => {
      const value = input as { keyId: string };
      if (kind === "owner") state.db.rows("user_keys").find((k) => k.key_id === value.keyId)!.user_id = B;
      return finishReset({ ...(input as object), ...(kind === "challenge" ? { challenge: Buffer.alloc(32, 99).toString("base64") } : kind === "current" ? { expectedCurrentKeyId: null } : {}) });
    });
    expect(result).toEqual({ ok: false, code: kind === "challenge" ? "key_challenge_failed" : kind === "owner" ? "key_not_pending" : "key_in_use_changed" });
    expect(state.updates).toBe(0);
    expect(active()).toEqual(before);
  });

  it("completes an ordinary reset while keeping B's secret and key", async () => {
    expect(await reset()).toEqual({ ok: true });
    expect(state.updates).toBe(1);
    expect(state.secrets.get(B)).toBe("old-beta");
    expect(active().filter((k) => k.user_id === A)).toHaveLength(1);
    expect(active().find((k) => k.user_id === A)!.key_id).not.toBe("a".repeat(32));
    expect(active().find((k) => k.user_id === B)!.key_id).toBe("b".repeat(32));
  });

  it("retries after the Auth update answer was lost and activates one key", async () => {
    state.lost = true;
    expect(await reset()).toEqual({ ok: false, code: "secret_change_unknown" });
    expect(active().find((k) => k.user_id === A)!.key_id).toBe("a".repeat(32));
    expect(await reset()).toEqual({ ok: true });
    expect(active().filter((k) => k.user_id === A)).toHaveLength(1);
    expect(state.db.rows("user_keys").filter((k) => !k.activated_at)).toHaveLength(0);
  });
});
