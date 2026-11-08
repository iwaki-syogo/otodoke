import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The iOS app's mail endpoints (src/app/api/mail/**): a Bearer token checked by Supabase Auth
 * (any valid session, no freshness), strict bodies, fixed codes. docs/api/mail.md describes the same.
 */

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (sub = "user-1") => `${b64url({ alg: "ES256" })}.${b64url({ sub, amr: [{ method: "otp", timestamp: 1 }] })}.c2ln`;
const ID = "123e4567-e89b-12d3-a456-426614174000";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), mark: vi.fn(), read: vi.fn(), process: vi.fn(), rows: { current: [] as unknown[] } }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/pipeline", () => ({ processInboundEmail: mocks.process, MailBeingReadError: class extends Error {} }));
// A chainable stand-in for the emails query of the waiting mail.
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "or", "order"]) chain[m] = () => chain;
  chain.limit = () => Promise.resolve({ data: mocks.rows.current, error: null });
  return { createAdminClient: () => chain };
});
vi.mock("@/lib/mail-run", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/mail-run")>();
  return { ...actual, runMarkWronglyDropped: mocks.mark, runReadWaitingMail: mocks.read };
});

const routes = {
  "mark-parcel": await import("@/app/api/mail/mark-parcel/route"),
  "read-waiting": await import("@/app/api/mail/read-waiting/route"),
};
type Step = keyof typeof routes;
const STEPS = Object.keys(routes) as Step[];
const GOOD: Record<Step, unknown> = { "mark-parcel": { id: ID }, "read-waiting": {} };

async function call(step: Step, { token, body = GOOD[step], raw }: { token?: string | null; body?: unknown; raw?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  const bearer = token === undefined ? jwt() : token;
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
  const res = await routes[step].POST(new Request(`https://otodoke.app/api/mail/${step}`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, cache: res.headers.get("cache-control") };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  for (const fn of [mocks.getUser, mocks.mark, mocks.read, mocks.process]) fn.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "me@example.com" } }, error: null });
  mocks.mark.mockResolvedValue({ ok: true, outcome: "remembered" });
  mocks.read.mockResolvedValue({ ok: true, read: 3, overLimit: false });
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
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: 401 when Supabase Auth refuses the token or names another user", async (step) => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 403, code: "bad_jwt" } });
    expect(await call(step)).toMatchObject({ status: 401, json: { ok: false, code: "unauthorized" } });
    mocks.getUser.mockResolvedValue({ data: { user: { id: "someone-else" } }, error: null });
    expect(await call(step)).toMatchObject({ status: 401, cache: "no-store" });
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(STEPS)("%s: 503 unavailable when Supabase Auth cannot be asked", async (step) => {
    mocks.getUser.mockRejectedValue(new TypeError("fetch failed"));
    expect(await call(step)).toEqual({ status: 503, json: { ok: false, code: "unavailable" }, cache: "no-store" });
  });

  it.each(STEPS)("%s: a session from a code or link is enough (no freshness)", async (step) => {
    expect((await call(step)).status).toBe(200);
  });
});

describe("mark-parcel", () => {
  it.each(["remembered", "shared", "forwarded", "own"])("answers outcome %s", async (outcome) => {
    mocks.mark.mockResolvedValue({ ok: true, outcome });
    expect(await call("mark-parcel")).toEqual({ status: 200, json: { ok: true, outcome }, cache: "no-store" });
  });

  it("takes the user and address from the token, not from the body", async () => {
    await call("mark-parcel");
    expect(mocks.mark.mock.calls[0].slice(1)).toEqual(["user-1", "me@example.com", ID]);
    expect(await call("mark-parcel", { body: { id: ID, userId: "someone-else" } })).toMatchObject({ status: 400, json: { code: "invalid_input" } });
  });

  it("400 invalid_input for a bad id, a missing id, a non-string, an unknown field or non-JSON; nothing runs", async () => {
    for (const body of [{ id: "nope" }, {}, { id: 5 }, { id: ID, extra: 1 }, { id: `${ID}x` }]) {
      expect(await call("mark-parcel", { body })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" }, cache: "no-store" });
    }
    expect(await call("mark-parcel", { raw: "{not json" })).toMatchObject({ status: 400 });
    expect(await call("mark-parcel", { raw: "" })).toMatchObject({ status: 400 });
    expect(await call("mark-parcel", { raw: JSON.stringify({ id: ID, pad: "x".repeat(5000) }) })).toMatchObject({ status: 400 });
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it("404 not_found when there is no such dropped mail of the user", async () => {
    mocks.mark.mockResolvedValue({ ok: false, code: "not_found" });
    expect(await call("mark-parcel")).toEqual({ status: 404, json: { ok: false, code: "not_found" }, cache: "no-store" });
  });

  it("500 mark_failed for a database failure or a throw, logging the code only", async () => {
    mocks.mark.mockResolvedValue({ ok: false, code: "mark_failed", message: "secret subject text" });
    expect(await call("mark-parcel")).toEqual({ status: 500, json: { ok: false, code: "mark_failed" }, cache: "no-store" });
    mocks.mark.mockResolvedValue({ ok: false, code: "lookup_failed", message: "secret subject text" });
    expect(await call("mark-parcel")).toMatchObject({ status: 500, json: { code: "mark_failed" } });
    mocks.mark.mockRejectedValue(new Error("secret subject text"));
    expect(await call("mark-parcel")).toMatchObject({ status: 500, json: { code: "mark_failed" } });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });
});

describe("read-waiting", () => {
  it("reads for the token's user and answers the counts", async () => {
    expect(await call("read-waiting")).toEqual({ status: 200, json: { ok: true, read: 3, over_limit: false }, cache: "no-store" });
    expect(mocks.read.mock.calls[0][1]).toBe("user-1");
    mocks.read.mockResolvedValue({ ok: true, read: 1, overLimit: true });
    expect(await call("read-waiting")).toMatchObject({ status: 200, json: { ok: true, read: 1, over_limit: true } });
  });

  it("accepts an empty body; 400 invalid_input for a field or non-JSON", async () => {
    expect((await call("read-waiting", { raw: "" })).status).toBe(200);
    for (const raw of [JSON.stringify({ userId: "x" }), "{not json", "[]"]) {
      expect(await call("read-waiting", { raw })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" }, cache: "no-store" });
    }
  });

  it("500 read_failed when reading fails or throws, with no mail text in the log", async () => {
    mocks.read.mockResolvedValue({ ok: false, stage: "read", message: "secret subject text", read: 1, overLimit: false });
    expect(await call("read-waiting")).toEqual({ status: 500, json: { ok: false, code: "read_failed" }, cache: "no-store" });
    mocks.read.mockRejectedValue(new Error("secret subject text"));
    expect(await call("read-waiting")).toMatchObject({ status: 500, json: { code: "read_failed" } });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret");
  });

  it("stops at over_limit exactly as the web action does (the cap is the pipeline's), through the real shared function", async () => {
    const { runReadWaitingMail } = await vi.importActual<typeof import("@/lib/mail-run")>("@/lib/mail-run");
    mocks.read.mockImplementation((db: never, userId: string) => runReadWaitingMail(db, userId));
    const mail = (n: number) => ({ id: `e${n}`, provider_email_id: `p${n}`, message_id: `<m${n}>`, from_address: "a@b.c", from_name: null, subject: "s", sent_at: "2026-11-01T00:00:00Z", text_body: "t", html_body: null });
    mocks.rows.current = [mail(1), mail(2), mail(3)];
    mocks.process.mockResolvedValueOnce({ kind: "processed" }).mockResolvedValueOnce({ kind: "over_limit", emailId: "e2", limit: "user" }).mockResolvedValue({ kind: "processed" });
    expect(await call("read-waiting")).toEqual({ status: 200, json: { ok: true, read: 1, over_limit: true }, cache: "no-store" });
    expect(mocks.process).toHaveBeenCalledTimes(2);
    expect(mocks.process.mock.calls[0][1]).toMatchObject({ userId: "user-1" });
  });
});

describe("source guards", () => {
  it("read-waiting has maxDuration 300, mark-parcel none, and next.config traces the fixtures for read-waiting", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/app/api/mail/read-waiting/route.ts", "utf8")).toMatch(/export const maxDuration = 300;/);
    expect(readFileSync("src/app/api/mail/mark-parcel/route.ts", "utf8")).not.toContain("maxDuration");
    const config = readFileSync("next.config.ts", "utf8");
    expect(config).toMatch(/"\/api\/mail\/read-waiting": \["\.\/fixtures\/demo\/\*\*\/\*\.json", "\.\/fixtures\/demo-history\/\*\*\/\*\.json"\]/);
  });
});
