import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The iOS app's sample endpoints (src/app/api/demo/**): a Bearer token checked by Supabase Auth
 * (any valid session, no freshness), strict bodies, fixed codes. docs/api/demo.md describes the same.
 * The concurrent-load guard through the API is in load-demo-concurrent.test.ts.
 */

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (sub = "user-1") => `${b64url({ alg: "ES256" })}.${b64url({ sub, amr: [{ method: "otp", timestamp: 1 }] })}.c2ln`;

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), load: vi.fn(), clear: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ admin: true }) }));
vi.mock("@/lib/demo-run", () => ({ runLoadDemo: mocks.load, runClearAllParcels: mocks.clear }));

const routes = {
  load: await import("@/app/api/demo/load/route"),
  clear: await import("@/app/api/demo/clear/route"),
};
type Step = keyof typeof routes;
const STEPS = Object.keys(routes) as Step[];
const GOOD: Record<Step, unknown> = { load: {}, clear: { confirm: "yes" } };

async function call(step: Step, { token, body = GOOD[step], raw }: { token?: string | null; body?: unknown; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const bearer = token === undefined ? jwt() : token;
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
  const res = await routes[step].POST(new Request(`https://otodoke.app/api/demo/${step}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
  mocks.load.mockResolvedValue({ ok: true, processed: 97, busy: false });
  mocks.clear.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("who may call", () => {
  it.each(STEPS)("%s: 401 without a Bearer token, or with one that is not a JWT", async (step) => {
    for (const token of [null, "", "not-a-jwt", "a.b"]) {
      expect(await call(step, { token })).toEqual({ status: 401, json: { ok: false, code: "unauthorized" }, cache: "no-store" });
    }
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: 401 when Supabase Auth refuses the token, and nothing runs", async (step) => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 403, code: "bad_jwt" } });
    expect(await call(step)).toMatchObject({ status: 401, json: { ok: false, code: "unauthorized" } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "someone-else" } }, error: null });
    expect(await call(step)).toMatchObject({ status: 401 });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: 503 unavailable when Supabase Auth cannot be asked", async (step) => {
    mocks.getUser.mockRejectedValue(new TypeError("fetch failed"));
    expect(await call(step)).toMatchObject({ status: 503, json: { ok: false, code: "unavailable" } });
  });

  it.each(STEPS)("%s: a session from a code or link is enough (no freshness)", async (step) => {
    expect((await call(step)).status).toBe(200);
  });
});

describe("load", () => {
  it("runs the load for the token's user and answers processed and busy", async () => {
    expect(await call("load")).toEqual({ status: 200, json: { ok: true, processed: 97, busy: false }, cache: "no-store" });
    expect(mocks.load.mock.calls[0][1]).toBe("user-1");
    mocks.load.mockResolvedValue({ ok: true, processed: 2, busy: true });
    expect(await call("load")).toMatchObject({ status: 200, json: { ok: true, processed: 2, busy: true } });
  });

  it("accepts an empty body", async () => {
    expect(await call("load", { raw: "" })).toMatchObject({ status: 200, json: { ok: true } });
  });

  it("400 invalid_input for a field, a body that is not JSON, or too long; nothing runs", async () => {
    for (const raw of [JSON.stringify({ userId: "someone-else" }), "{not json", JSON.stringify({ pad: "x".repeat(5000) }), "[]"]) {
      expect(await call("load", { raw })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" }, cache: "no-store" });
    }
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("500 demo_failed when the load fails, with the code only", async () => {
    mocks.load.mockResolvedValue({ ok: false, processed: 3, message: "connection reset" });
    const res = await call("load");
    expect(res).toEqual({ status: 500, json: { ok: false, code: "demo_failed" }, cache: "no-store" });
  });
});

describe("clear", () => {
  it("confirm yes: clears the token's user and answers ok", async () => {
    expect(await call("clear")).toEqual({ status: 200, json: { ok: true }, cache: "no-store" });
    expect(mocks.clear.mock.calls[0][1]).toBe("user-1");
  });

  it("400 clear_confirm when confirm is missing or anything but yes; nothing is removed", async () => {
    for (const body of [{}, { confirm: "no" }, { confirm: "YES" }, { confirm: true }, { confirm: null }]) {
      expect(await call("clear", { body })).toEqual({ status: 400, json: { ok: false, code: "clear_confirm" }, cache: "no-store" });
    }
    expect(await call("clear", { raw: "" })).toMatchObject({ status: 400, json: { code: "clear_confirm" } });
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("400 invalid_input for an unknown field or a body that is not JSON", async () => {
    expect(await call("clear", { body: { confirm: "yes", userId: "x" } })).toMatchObject({ status: 400, json: { code: "invalid_input" } });
    expect(await call("clear", { raw: "{not json" })).toMatchObject({ status: 400, json: { code: "invalid_input" } });
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("500 clear_failed when the delete fails or throws", async () => {
    mocks.clear.mockResolvedValue("db down");
    expect(await call("clear")).toEqual({ status: 500, json: { ok: false, code: "clear_failed" }, cache: "no-store" });
    mocks.clear.mockRejectedValue(new Error("boom"));
    expect(await call("clear")).toMatchObject({ status: 500, json: { code: "clear_failed" } });
  });
});

describe("source guards", () => {
  it("the load route has maxDuration 300 and next.config traces the fixtures for it", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/api/demo/load/route.ts", "utf8")).toMatch(/export const maxDuration = 300;/);
    const config = readFileSync("next.config.ts", "utf8");
    expect(config).toMatch(/"\/api\/demo\/load": \["\.\/fixtures\/demo\/\*\*\/\*\.json", "\.\/fixtures\/demo-history\/\*\*\/\*\.json"\]/);
  });
});
