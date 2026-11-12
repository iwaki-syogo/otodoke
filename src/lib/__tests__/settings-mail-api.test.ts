import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const STAMP = "2026-11-12T01:00:00.123456+00:00";
const NEWER = "2026-11-12T01:00:00.123457+00:00";
const DOMAIN = "shop.example.test";
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (sub = USER) => `${b64({ alg: "ES256" })}.${b64({ sub, amr: [{ method: "otp", timestamp: 1 }] })}.c2ln`;
const mocks = vi.hoisted(() => ({ getUser: vi.fn(), db: null as unknown, admin: vi.fn(), permission: vi.fn() }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { mocks.admin(); return mocks.db; } }));
vi.mock("@/lib/ai-consent", async (importActual) => ({
  ...await importActual<typeof import("@/lib/ai-consent")>(), readingAllowed: mocks.permission,
}));

const handlers = await import("@/app/api/mail/handler");
const STEPS = ["forget-sender", "dismiss-intake"] as const;
type Step = typeof STEPS[number];
const good = (step: Step): Record<string, string> => step === "forget-sender" ? { domain: DOMAIN } : { limited_at: STAMP };
const run = (step: Step, request: Request) => step === "forget-sender" ? handlers.forgetSenderStep(request) : handlers.dismissIntakeStep(request);

function request(step: Step, { token = jwt(), body = good(step), raw }: { token?: string | null; body?: unknown; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return new Request(`https://otodoke.app/api/mail/${step}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) });
}

async function call(step: Step, options: Parameters<typeof request>[1] = {}) {
  const response = await run(step, request(step, options));
  return { status: response.status, json: await response.json(), cache: response.headers.get("cache-control") };
}

function seed() {
  return new FakeDb({
    screen_events: [
      { id: "mine", user_id: USER, from_domain: DOMAIN, flagged_at: STAMP },
      { id: "mine-too", user_id: USER, from_domain: DOMAIN, flagged_at: STAMP },
      { id: "other-owner", user_id: OTHER, from_domain: DOMAIN, flagged_at: STAMP },
      { id: "other-domain", user_id: USER, from_domain: "elsewhere.test", flagged_at: STAMP },
    ],
    mail_intake_notices: [{ user_id: USER, limited_at: STAMP }, { user_id: OTHER, limited_at: STAMP }],
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("unexpected external request"); }));
  mocks.db = seed();
  mocks.admin.mockReset();
  mocks.permission.mockReset().mockResolvedValue("not_granted");
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: USER, email: "test@example.com" } }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("native settings actions authenticate before writing", () => {
  it.each(STEPS)("%s: requires a verified bearer and never falls back to cookies", async (step) => {
    for (const token of [null, "", "not-a-jwt", "a.b"]) {
      expect(await call(step, { token })).toEqual({ status: 401, json: { ok: false, code: "unauthorized" }, cache: "no-store" });
    }
    expect(mocks.getUser).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: rejects a refused token or a subject different from Auth's user", async (step) => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 401 } });
    expect((await call(step)).status).toBe(401);
    expect((await call(step, { token: jwt(OTHER) })).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: distinguishes unavailable Auth from signed out", async (step) => {
    mocks.getUser.mockRejectedValueOnce(new TypeError("offline"));
    expect(await call(step)).toEqual({ status: 503, json: { ok: false, code: "unavailable" }, cache: "no-store" });
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: { status: 503 } });
    expect((await call(step)).status).toBe(503);
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: accepts an old valid code-login session without reading permission", async (step) => {
    expect(await call(step)).toEqual({ status: 200, json: { ok: true }, cache: "no-store" });
    expect(mocks.getUser).toHaveBeenCalledWith(jwt());
    expect(mocks.permission).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: rejects unknown fields including a supplied owner, non-JSON, empty and oversized bodies", async (step) => {
    for (const raw of ["", "not json", "null", "[]", "{}", JSON.stringify({ ...good(step), userId: OTHER }), JSON.stringify({ ...good(step), pad: "x".repeat(2000) })]) {
      expect(await call(step, { raw })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" }, cache: "no-store" });
    }
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: reports a body read failure as a fixed error without writing", async (step) => {
    const input = request(step);
    vi.spyOn(input, "text").mockRejectedValueOnce(new Error("private request detail"));
    const response = await run(step, input);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: "invalid_input" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private request detail");
  });

  it.each(STEPS)("%s: accepts 1024 characters and refuses 1025 without another write", async (step) => {
    const raw = JSON.stringify(good(step)).padEnd(1024, " ");
    expect((await call(step, { raw })).status).toBe(200);
    expect((await call(step, { raw: `${raw} ` })).status).toBe(400);
    expect(mocks.admin).toHaveBeenCalledTimes(1);
  });
});

describe("forget-sender uses the shared Web operation", () => {
  it("clears all matching marks for the token's owner only", async () => {
    expect((await call("forget-sender")).status).toBe(200);
    const db = mocks.db as FakeDb;
    expect(db.rows("screen_events").map((row) => [row.id, row.flagged_at])).toEqual([
      ["mine", null], ["mine-too", null], ["other-owner", STAMP], ["other-domain", STAMP],
    ]);
    expect(db.callsOn("screen_events", "update")[0].filters).toEqual(expect.arrayContaining([
      { method: "eq", args: ["user_id", USER] }, { method: "eq", args: ["from_domain", DOMAIN] },
      { method: "not", args: ["flagged_at", "is", null] },
    ]));
  });

  it.each(["gmail.com", "x", "x".repeat(255), "legacy_domain", " Shop.Example "])("can remove a legitimate old mark on %s without applying today's remembering rules", async (domain) => {
    const db = mocks.db as FakeDb;
    db.rows("screen_events")[0].from_domain = domain;
    expect((await call("forget-sender", { body: { domain } })).status).toBe(200);
    expect(db.rows("screen_events")[0].flagged_at).toBeNull();
    expect((await call("forget-sender", { body: { domain } })).status).toBe(200);
  });

  it.each(["", "x".repeat(256), null, 12])("rejects an invalid domain %j without writes", async (domain) => {
    expect((await call("forget-sender", { body: { domain } })).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

describe("dismiss-intake preserves the original timestamp", () => {
  it("deletes only this owner's displayed microsecond timestamp and is idempotent", async () => {
    expect((await call("dismiss-intake")).status).toBe(200);
    const db = mocks.db as FakeDb;
    expect(db.rows("mail_intake_notices")).toEqual([{ user_id: OTHER, limited_at: STAMP }]);
    expect(db.callsOn("mail_intake_notices", "delete")[0].filters).toEqual([
      { method: "eq", args: ["user_id", USER] }, { method: "eq", args: ["limited_at", STAMP] },
    ]);
    expect((await call("dismiss-intake")).status).toBe(200);
  });

  it("keeps a new notice one microsecond after the acknowledged old one", async () => {
    const db = mocks.db as FakeDb;
    db.rows("mail_intake_notices")[0].limited_at = NEWER;
    expect((await call("dismiss-intake")).status).toBe(200);
    expect(db.rows("mail_intake_notices")).toEqual([{ user_id: USER, limited_at: NEWER }, { user_id: OTHER, limited_at: STAMP }]);
  });

  it.each(["1900-01-01T00:00:00Z", "2026-11-12T10:00:00.123456+09:00", "2026-11-12T00:00:00+15:59"])("accepts and forwards valid raw timestamps unchanged: %s", async (stamp) => {
    expect((await call("dismiss-intake", { body: { limited_at: stamp } })).status).toBe(200);
    expect((mocks.db as FakeDb).callsOn("mail_intake_notices", "delete")[0].filters.at(-1)).toEqual({ method: "eq", args: ["limited_at", stamp] });
  });

  it.each(["", null, 12, "not-a-date", "2026-11-12", "2026-11-12T00:00:00", "2026-02-30T00:00:00Z", "0000-01-01T00:00:00Z", "2026-11-12T00:00:00+16:00"])("rejects invalid limited_at %j without writes", async (stamp) => {
    expect((await call("dismiss-intake", { body: { limited_at: stamp } })).status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
  });
});

describe("failed writes never look successful", () => {
  it.each(STEPS)("%s: reports a database client creation failure with a fixed 500 code", async (step) => {
    mocks.admin.mockImplementationOnce(() => { throw new Error("private client detail"); });
    const code = step === "forget-sender" ? "forget_failed" : "dismiss_failed";
    expect(await call(step)).toEqual({ status: 500, json: { ok: false, code }, cache: "no-store" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private client detail");
  });

  it.each(STEPS)("%s: handles a database error or throw with a fixed 500 code", async (step) => {
    const db = mocks.db as FakeDb;
    const table = step === "forget-sender" ? "screen_events" : "mail_intake_notices";
    const code = step === "forget-sender" ? "forget_failed" : "dismiss_failed";
    const before = structuredClone(db.rows(table));
    db.hooks.push((q) => q.table === table ? { data: null, error: { message: "private database detail" } } : undefined);
    expect(await call(step)).toEqual({ status: 500, json: { ok: false, code }, cache: "no-store" });
    expect(db.rows(table)).toEqual(before);
    db.hooks.splice(0, db.hooks.length, () => { throw new Error("private database detail"); });
    expect(await call(step)).toEqual({ status: 500, json: { ok: false, code }, cache: "no-store" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private database detail");
  });
});

describe("POST route delegation", () => {
  it("exposes both native settings endpoints through the tested handlers", async () => {
    const forget = await import("@/app/api/mail/forget-sender/route");
    const dismiss = await import("@/app/api/mail/dismiss-intake/route");
    for (const [step, route] of [["forget-sender", forget], ["dismiss-intake", dismiss]] as const) {
      const response = await route.POST(request(step));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(Object.keys(route)).toEqual(["POST"]);
    }
  });
});
