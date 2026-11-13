import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountChangedPath } from "@/lib/action-identity";

const ME = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const ORIGIN = "https://app.example.test";

const auth = vi.hoisted(() => ({ getUser: vi.fn(), getSession: vi.fn(), signOut: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: auth.getUser, getSession: auth.getSession, signOut: auth.signOut } }),
}));

const { POST } = await import("@/app/auth/signout/route");

const token = (claims: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const sessionOf = (sub: string) => ({ data: { session: { access_token: token({ sub }) } }, error: null });

function post(expected?: string) {
  const data = new FormData();
  if (expected !== undefined) data.set("expectedUserId", expected);
  return POST(new NextRequest(`${ORIGIN}/auth/signout`, { method: "POST", body: data }));
}

const LOGIN = `${ORIGIN}/login`;
const CHANGED = `${ORIGIN}${accountChangedPath("/app/settings", "logout")}`;

beforeEach(() => {
  vi.resetAllMocks();
  auth.signOut.mockResolvedValue({ error: null });
});

const unreadable = (error: unknown) => async () => ({ data: { user: null }, error });

describe("logout when the current user cannot be read", () => {
  it.each([
    { label: "503", getUser: unreadable({ status: 503 }) },
    { label: "status 0 retryable fetch", getUser: unreadable({ status: 0, name: "AuthRetryableFetchError" }) },
    { label: "429", getUser: unreadable({ status: 429 }) },
    { label: "400 without code", getUser: unreadable({ status: 400 }) },
    { label: "403 session_not_found", getUser: unreadable({ status: 403, code: "session_not_found" }) },
    { label: "getUser throws", getUser: async () => { throw new Error("synthetic network failure"); } },
  ])("clears the cookie of the same person when getUser fails: $label", async ({ getUser }) => {
    auth.getUser.mockImplementation(getUser);
    auth.getSession.mockResolvedValue(sessionOf(ME));
    const response = await post(ME);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(LOGIN);
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });

  it.each([
    { label: "another user's cookie", expected: ME, session: async () => sessionOf(OTHER) },
    { label: "missing expectedUserId", expected: undefined, session: async () => sessionOf(ME) },
    { label: "empty expectedUserId", expected: "", session: async () => sessionOf(ME) },
    { label: "expired session with unreachable refresh", expected: ME, session: async () => ({ data: { session: null }, error: { status: 0 } }) },
    { label: "getSession throws", expected: ME, session: async () => { throw new Error("synthetic cookie failure"); } },
    { label: "access token is not a JWT", expected: ME, session: async () => ({ data: { session: { access_token: "not-a-jwt" } }, error: null }) },
    { label: "access token has no sub", expected: ME, session: async () => ({ data: { session: { access_token: token({ aud: "x" }) } }, error: null }) },
  ])("keeps the cookie and shows the account-changed page: $label", async ({ expected, session }) => {
    auth.getUser.mockImplementation(unreadable({ status: 503 }));
    auth.getSession.mockImplementation(session);
    const response = await post(expected);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(CHANGED);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("goes to login without signing out when there is no cookie session", async () => {
    auth.getUser.mockImplementation(unreadable({ status: 400 }));
    auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const response = await post(ME);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(LOGIN);
    expect(auth.signOut).not.toHaveBeenCalled();
  });
});

describe("logout with a verified user (unchanged branch)", () => {
  it("signs out the matching user and goes to the top page", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: ME } }, error: null });
    const response = await post(ME);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(auth.getSession).not.toHaveBeenCalled();
  });

  it("refuses a user that does not match", async () => {
    auth.getUser.mockResolvedValue({ data: { user: { id: OTHER } }, error: null });
    const response = await post(ME);
    expect(response.headers.get("location")).toBe(CHANGED);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.getSession).not.toHaveBeenCalled();
  });
});
