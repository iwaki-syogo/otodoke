import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The iOS app's mail endpoints (src/app/api/mail/**): a Bearer token checked by Supabase Auth
 * (any valid session, no freshness), strict bodies, fixed codes. docs/api/mail.md describes the same.
 */

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (sub = "user-1") => `${b64url({ alg: "ES256" })}.${b64url({ sub, amr: [{ method: "otp", timestamp: 1 }] })}.c2ln`;
const ID = "123e4567-e89b-12d3-a456-426614174000";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), mark: vi.fn(), read: vi.fn(), readAfter: vi.fn(), process: vi.fn(), consent: vi.fn(), rows: { current: [] as unknown[] } }));

vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/pipeline", () => ({ processInboundEmail: mocks.process, MailBeingReadError: class MailBeingReadError extends Error {} }));
// A chainable stand-in for the emails query of the waiting mail.
vi.mock("@/lib/supabase/admin", () => {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "select", "eq", "or", "order"]) chain[m] = () => chain;
  chain.maybeSingle = () => mocks.consent();
  const answer = (data: unknown) => {
    const result = Object.assign(Promise.resolve({ data, error: null }), { setHeader: () => result });
    return result;
  };
  chain.limit = () => answer(mocks.rows.current);
  chain.rpc = (name: string) => {
    if (name !== "begin_sample_load") throw new Error(`unexpected test RPC ${name}`);
    return answer("00000000-0000-4000-8000-000000000001");
  };
  return { createAdminClient: () => chain };
});
vi.mock("@/lib/ai-consent-run", () => ({ runReadAfterConsent: mocks.readAfter }));
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
  for (const fn of [mocks.getUser, mocks.mark, mocks.read, mocks.readAfter, mocks.process]) fn.mockReset();
  mocks.consent.mockReset().mockResolvedValue({ data: { decision: "granted", decided_at: "2026-11-12T00:00:00Z", text_version: "v1" }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: "user-1", email: "me@example.com" } }, error: null });
  mocks.mark.mockResolvedValue({ ok: true, outcome: "remembered" });
  mocks.read.mockResolvedValue({ ok: true, read: 3, overLimit: false, unavailable: false });
  mocks.readAfter.mockResolvedValue({ ok: true, read: 0, overLimit: false, unavailable: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
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
  it("passes the request start from before authentication and body reading to the automatic reader", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-11-12T00:00:01Z");
    vi.setSystemTime(start);
    mocks.getUser.mockImplementationOnce(async () => {
      vi.setSystemTime(start + 100_000);
      return { data: { user: { id: "user-1", email: "me@example.com" } }, error: null };
    });
    const stamp = "2026-11-12T00:00:00.123456Z";
    const request = new Request("https://otodoke.app/api/mail/read-waiting", { method: "POST", headers: { authorization: `Bearer ${jwt()}`, "content-type": "application/json" }, body: JSON.stringify({ after_consent: stamp }) });
    vi.spyOn(request, "text").mockImplementationOnce(async () => {
      vi.setSystemTime(start + 150_001);
      return JSON.stringify({ after_consent: stamp });
    });
    mocks.readAfter.mockResolvedValueOnce({ ok: false, stage: "read", message: "ai_consent_backlog_time_limit", read: 0, overLimit: false, unavailable: false, onlyBusy: false });
    const response = await routes["read-waiting"].POST(request);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ ok: false, code: "read_failed", read: 0 });
    expect(mocks.readAfter.mock.calls[0].slice(1)).toEqual(["user-1", stamp, start]);
    expect(Date.now() - start).toBe(150_001);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("after_consent routes to the one-shot reader with the token user's raw microsecond timestamp", async () => {
    const stamp = "2026-11-12T00:00:00.123456+00:00";
    mocks.readAfter.mockResolvedValue({ ok: true, read: 4, overLimit: false, unavailable: false });
    expect(await call("read-waiting", { body: { after_consent: stamp } })).toEqual({ status: 200, json: { ok: true, read: 4, over_limit: false, busy: false, stopped: false }, cache: "no-store" });
    expect(mocks.readAfter).toHaveBeenCalledTimes(1);
    expect(mocks.readAfter.mock.calls[0].slice(1)).toEqual(["user-1", stamp, expect.any(Number)]);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("valid old and offset timestamps have no age cutoff; a stale or duplicate claim is a successful no-op", async () => {
    for (const stamp of ["1900-01-01T00:00:00Z", "2026-11-12T09:00:00.123456+09:00", "2026-11-12T00:00:00+15:59"]) {
      expect(await call("read-waiting", { body: { after_consent: stamp } })).toEqual({ status: 200, json: { ok: true, read: 0, over_limit: false, busy: false, stopped: false }, cache: "no-store" });
      expect(mocks.readAfter.mock.calls.at(-1)?.slice(1)).toEqual(["user-1", stamp, expect.any(Number)]);
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("a malformed or out-of-range after_consent is invalid_input before either reading path starts", async () => {
    for (const stamp of [null, 123, "", "not-a-date", "2026-11-12", "2026-11-12T00:00:00", "2026-02-30T00:00:00Z", "0000-01-01T00:00:00Z", "2026-11-12T00:00:00+16:00"]) {
      expect(await call("read-waiting", { body: { after_consent: stamp } })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" }, cache: "no-store" });
    }
    expect(mocks.readAfter).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("automatic reading retains the caller and consent checks, and reports read failures and daily limits as before", async () => {
    const body = { after_consent: "2026-11-12T00:00:00.123456Z" };
    expect((await call("read-waiting", { body, token: null })).status).toBe(401);
    mocks.consent.mockResolvedValueOnce({ data: { decision: "declined" }, error: null });
    expect((await call("read-waiting", { body })).status).toBe(403);
    expect(mocks.readAfter).not.toHaveBeenCalled();
    mocks.readAfter.mockResolvedValueOnce({ ok: false, stage: "read", read: 1, overLimit: false, unavailable: false, onlyBusy: false, message: "fixed failure" });
    expect(await call("read-waiting", { body })).toMatchObject({ status: 500, json: { ok: false, code: "read_failed", read: 1 } });
    mocks.readAfter.mockResolvedValueOnce({ ok: true, read: 2, overLimit: true, unavailable: false });
    expect(await call("read-waiting", { body })).toMatchObject({ status: 200, json: { ok: true, read: 2, over_limit: true } });
  });

  it("403 ai_consent_required for an unanswered or declined choice, and 503 unavailable for a failed consent read", async () => {
    for (const data of [null, { decision: "declined" }]) {
      mocks.consent.mockResolvedValue({ data, error: null });
      expect(await call("read-waiting")).toEqual({ status: 403, json: { ok: false, code: "ai_consent_required" }, cache: "no-store" });
    }
    mocks.consent.mockResolvedValue({ data: null, error: { message: "offline" } });
    expect(await call("read-waiting")).toEqual({ status: 503, json: { ok: false, code: "unavailable" }, cache: "no-store" });
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("reads for the token's user and answers the counts", async () => {
    expect(await call("read-waiting")).toEqual({ status: 200, json: { ok: true, read: 3, over_limit: false, busy: false, stopped: false }, cache: "no-store" });
    expect(mocks.read.mock.calls[0][1]).toBe("user-1");
    mocks.read.mockResolvedValue({ ok: true, read: 1, overLimit: true, unavailable: false });
    expect(await call("read-waiting")).toMatchObject({ status: 200, json: { ok: true, read: 1, over_limit: true, busy: false } });
  });

  it("answers 200 with stopped:true when Claude is stopped, and keeps every other field as it was (not read_failed)", async () => {
    mocks.read.mockResolvedValue({ ok: true, read: 2, overLimit: false, unavailable: true });
    expect(await call("read-waiting")).toEqual({ status: 200, json: { ok: true, read: 2, over_limit: false, busy: false, stopped: true }, cache: "no-store" });
    // Even with an earlier real failure in the same run: the stop is what the person needs to hear.
    mocks.read.mockResolvedValue({ ok: false, stage: "read", message: "x", read: 1, overLimit: false, unavailable: true, onlyBusy: false });
    expect(await call("read-waiting")).toMatchObject({ status: 200, json: { ok: true, stopped: true } });
  });

  it("negative control: without stopped a real failure is still 500 read_failed", async () => {
    mocks.read.mockResolvedValue({ ok: false, stage: "read", message: "x", read: 1, overLimit: false, unavailable: false, onlyBusy: false });
    expect(await call("read-waiting")).toMatchObject({ status: 500, json: { code: "read_failed" } });
  });

  it("accepts an empty body; 400 invalid_input for a field or non-JSON", async () => {
    expect((await call("read-waiting", { raw: "" })).status).toBe(200);
    for (const raw of [JSON.stringify({ userId: "x" }), "{not json", "[]"]) {
      expect(await call("read-waiting", { raw })).toEqual({ status: 400, json: { ok: false, code: "invalid_input" }, cache: "no-store" });
    }
  });

  it("500 read_failed when reading fails or throws, with no mail text in the log", async () => {
    mocks.read.mockResolvedValue({ ok: false, stage: "read", message: "secret subject text", read: 1, overLimit: false, onlyBusy: false });
    expect(await call("read-waiting")).toEqual({ status: 500, json: { ok: false, code: "read_failed", read: 1 }, cache: "no-store" });
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
    expect(await call("read-waiting")).toEqual({ status: 200, json: { ok: true, read: 1, over_limit: true, busy: false, stopped: false }, cache: "no-store" });
    expect(mocks.process).toHaveBeenCalledTimes(2);
    expect(mocks.process.mock.calls[0][1]).toMatchObject({ userId: "user-1" });
  });
});

describe("concurrent read and user scoping (real shared functions, FakeDb)", () => {
  const mail = (n: number, user: string, status = "over_limit") => ({ id: `e${n}`, user_id: user, body_state: "plain", processing_status: status, provider_email_id: `p${n}`, message_id: `<m${n}>`, from_address: "a@b.c", from_name: null, subject: "s", sent_at: `2026-11-0${n}T00:00:00Z`, text_body: "t", html_body: null, created_at: "2026-11-01T00:00:00Z" });

  it("another read holding a mail is busy:true, not a failure; a real failure beside it is read_failed", async () => {
    const { runReadWaitingMail } = await vi.importActual<typeof import("@/lib/mail-run")>("@/lib/mail-run");
    const { MailBeingReadError } = await import("@/lib/pipeline");
    mocks.read.mockImplementation((db: never, userId: string) => runReadWaitingMail(db, userId));
    mocks.rows.current = [mail(1, "user-1"), mail(2, "user-1")];
    mocks.process.mockResolvedValueOnce({ kind: "processed" }).mockRejectedValueOnce(new MailBeingReadError("busy"));
    expect(await call("read-waiting")).toEqual({ status: 200, json: { ok: true, read: 1, over_limit: false, busy: true, stopped: false }, cache: "no-store" });
    mocks.process.mockResolvedValueOnce({ kind: "processed" }).mockRejectedValueOnce(new Error("boom"));
    expect(await call("read-waiting")).toEqual({ status: 500, json: { ok: false, code: "read_failed", read: 1 }, cache: "no-store" });
  });

  it("runReadWaitingMail never hands another user's waiting mail to the pipeline", async () => {
    const { runReadWaitingMail } = await vi.importActual<typeof import("@/lib/mail-run")>("@/lib/mail-run");
    const { FakeDb } = await import("./fake-db");
    const db = new FakeDb({ emails: [mail(1, "user-1"), mail(2, "user-2"), mail(3, "user-2", "failed")] }, Date.now());
    mocks.process.mockResolvedValue({ kind: "processed" });
    expect(await runReadWaitingMail(db as never, "user-1")).toMatchObject({ ok: true, read: 1 });
    expect(mocks.process).toHaveBeenCalledTimes(1);
    expect(mocks.process.mock.calls[0][1]).toMatchObject({ userId: "user-1", providerEmailId: "p1" });
  });

  it("runMarkWronglyDropped does not touch another user's dropped mail", async () => {
    const { runMarkWronglyDropped } = await vi.importActual<typeof import("@/lib/mail-run")>("@/lib/mail-run");
    const { FakeDb } = await import("./fake-db");
    const db = new FakeDb({ screen_events: [{ id: ID, user_id: "user-2", decision: "dropped", from_domain: "shop.example", subject: "s", flagged_at: null }] });
    expect(await runMarkWronglyDropped(db as never, "user-1", "me@example.com", ID)).toEqual({ ok: false, code: "not_found" });
    expect(db.rows("screen_events")[0].flagged_at).toBeNull();
    expect(await runMarkWronglyDropped(db as never, "user-2", "other@example.com", ID)).toEqual({ ok: true, outcome: "remembered" });
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
