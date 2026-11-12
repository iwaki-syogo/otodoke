import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getUser: vi.fn(), deleteUser: vi.fn(), getUserById: vi.fn() }));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ auth: { admin: { deleteUser: mocks.deleteUser, getUserById: mocks.getUserById } } }) }));
const { POST } = await import("@/app/api/account/delete/route");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (sub = "owner") => `${b64({ alg: "ES256" })}.${b64({ sub, amr: [{ method: "otp", timestamp: 1 }] })}.c2ln`;

async function call({ bearer = token(), body = '{"confirm":"delete-account"}' }: { bearer?: string | null; body?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (bearer !== null) headers.set("authorization", `Bearer ${bearer}`);
  const res = await POST(new Request("https://otodoke.app/api/account/delete", { method: "POST", headers, body }));
  return { status: res.status, json: await res.json(), cache: res.headers.get("cache-control") };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.getUser.mockResolvedValue({ data: { user: { id: "owner" } }, error: null });
  mocks.deleteUser.mockResolvedValue({ data: { user: { id: "owner" } }, error: null });
  mocks.getUserById.mockResolvedValue({ data: { user: { id: "owner" } }, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("native account deletion", () => {
  it.each([null, "", "invalid"])("rejects an absent or malformed Bearer token: %s", async (bearer) => {
    expect(await call({ bearer })).toEqual({ status: 401, json: { ok: false, code: "unauthorized" }, cache: "no-store" });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
  it("verifies the same token's user and refuses a mismatch", async () => {
    expect((await call({ bearer: token("other") })).status).toBe(401);
    expect(mocks.getUser).toHaveBeenCalledWith(token("other"));
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
  it("refuses a token rejected by Auth", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
    expect((await call()).status).toBe(401);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
  it("an Auth outage is unavailable and never deletes", async () => {
    mocks.getUser.mockRejectedValue(new TypeError("fetch failed"));
    expect(await call()).toEqual({ status: 503, json: { ok: false, code: "unavailable" }, cache: "no-store" });
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
  it.each(["", "{}", '{"confirm":"yes"}', '{"confirm":"delete-account","userId":"other"}', "[]", "{", `{"confirm":"${"x".repeat(1024)}"}`])("requires only the explicit Web confirmation: %s", async (body) => {
    expect((await call({ body })).status).toBe(400);
    expect(mocks.deleteUser).not.toHaveBeenCalled();
  });
  it("deletes the verified owner for good using the shared function, including an old OTP session as on Web", async () => {
    expect(await call()).toEqual({ status: 200, json: { ok: true }, cache: "no-store" });
    expect(mocks.deleteUser).toHaveBeenCalledExactlyOnceWith("owner", false);
  });
  it("recognizes a completed deletion after a lost/error response, without retrying it", async () => {
    mocks.deleteUser.mockResolvedValue({ error: { status: 504, message: "timeout" } });
    mocks.getUserById.mockResolvedValue({ data: { user: null }, error: { status: 404, code: "user_not_found" } });
    expect((await call()).status).toBe(200);
    expect(mocks.deleteUser).toHaveBeenCalledTimes(1);
    expect(mocks.getUserById).toHaveBeenCalledWith("owner");
  });
  it("a failure keeps all details out of the response and log", async () => {
    mocks.deleteUser.mockResolvedValue({ error: { status: 500, message: "private server detail" } });
    expect(await call()).toEqual({ status: 500, json: { ok: false, code: "delete_failed" }, cache: "no-store" });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("private");
  });
  it("a throw is a fixed failure", async () => {
    mocks.deleteUser.mockRejectedValue(new Error("private server detail"));
    expect((await call()).json).toEqual({ ok: false, code: "delete_failed" });
  });
});
