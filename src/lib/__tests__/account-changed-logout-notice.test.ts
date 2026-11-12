import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_CHANGED_LOGOUT_NOTICE } from "@/lib/account-changed-text";
import { accountChangedPath } from "@/lib/action-identity";
import { findAll, parseHtml, textOf } from "./html-tree";

const A = { id: "00000000-0000-4000-8000-00000000000a", email: "a@example.test" };
const B = { id: "00000000-0000-4000-8000-00000000000b", email: "b@example.test" };
const ORIGIN = "https://app.example.test";
type Search = { next?: string | string[]; notice?: string | string[] };

const auth = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  getUser: vi.fn(), getSession: vi.fn(), signOut: vi.fn(), from: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  // The cookie client's verified current account is the only replaced boundary.
  createClient: async () => ({
    auth: { getUser: auth.getUser, getSession: auth.getSession, signOut: auth.signOut },
    from: auth.from,
  }),
}));

const { POST } = await import("@/app/auth/signout/route");
const AccountChangedPage = (await import("@/app/account-changed/page")).default;

function pageQuery(url: URL): Search {
  const result: Search = {};
  for (const key of ["next", "notice"] as const) {
    const values = url.searchParams.getAll(key);
    if (values.length) result[key] = values.length === 1 ? values[0] : values;
  }
  return result;
}

function post(expected?: string) {
  const data = new FormData();
  if (expected !== undefined) data.set("expectedUserId", expected);
  return POST(new NextRequest(`${ORIGIN}/auth/signout`, { method: "POST", body: data }));
}

function recoveryTarget(response: Response) {
  expect(response.status).toBe(303);
  const location = response.headers.get("location");
  if (!location) throw new Error("the stopped POST must redirect to a fresh GET");
  const target = new URL(location);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe("/account-changed");
  expect(target.searchParams.get("next")).toBe("/app/settings");
  return target;
}

const explanationOf = (html: string) => findAll(parseHtml(html), (node) => node.tag === "p").map(textOf)[0] ?? "";
const renderPage = async (query: Search) => renderToStaticMarkup(await AccountChangedPage({ searchParams: Promise.resolve(query) }));

function expectSafeGet(html: string, href: string) {
  expect(findAll(parseHtml(html), (node) => node.tag === "a").map((node) => node.attrs.href)).toEqual([href]);
  expect(html).not.toMatch(/<form|<input|expectedUserId|\/auth\/signout/);
}

beforeEach(() => {
  vi.resetAllMocks();
  auth.user = B;
  auth.getUser.mockImplementation(async () => ({ data: { user: auth.user }, error: null }));
  auth.getSession.mockImplementation(async () => ({ data: { session: auth.user ? {
    access_token: `synthetic.${Buffer.from(JSON.stringify({ sub: auth.user.id, amr: [] })).toString("base64url")}.synthetic`,
  } : null }, error: null }));
  // Calling signOut would actually clear this test cookie session, so preserving B is observable.
  auth.signOut.mockImplementation(async () => { auth.user = null; return { error: null }; });
  auth.from.mockImplementation(() => { throw new Error("this recovery must not access application data"); });
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("external requests are forbidden"); }));
});
afterEach(() => {
  try {
    expect(auth.from).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});

describe("logout recovery after the displayed account changed", () => {
  it("keeps cookie B after A's stale POST and tells B to reopen the screen to log out", async () => {
    const target = recoveryTarget(await post(A.id));
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.user).toEqual(B);

    // Use the route's real Location query, not a hand-made logout flag that could hide a broken seam.
    // readCookieSession is real too: it verifies the synthetic token against this same auth boundary.
    const html = renderToStaticMarkup(await AccountChangedPage({ searchParams: Promise.resolve(pageQuery(target)) }));
    expect(html).toContain(B.email);
    expect(html).not.toContain(A.email);
    expect(html).toContain('href="/app/settings"');
    expect(html).toContain("このアカウントで画面を開き直す</a>");
    expect(html).not.toMatch(/<form|<input|expectedUserId|\/auth\/signout/);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.user).toEqual(B);
    expect(auth.from).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    const explanation = explanationOf(html);
    // Assert the next action rather than pinning the provisional full sentence.
    expect(explanation).toMatch(/ログアウト/);
    expect(explanation).toMatch(/ログイン/);
    expect(explanation).toMatch(/画面/);
    expect(explanation).toMatch(/開き直/);
    expect(explanation.trim().length).toBeGreaterThan(0);
    expect(explanation).toBe(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expect(target.searchParams.get("notice")).toBe("logout");
  });

  it.each([undefined, "", "not-a-user-id", "00000000-0000-4000-8000-00000000000c"])("still refuses missing, malformed, or wrong-user precondition %j", async (expected) => {
    const target = recoveryTarget(await post(expected));
    expect(auth.user).toEqual(B);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(target.searchParams.get("notice")).toBe("logout");
    const html = await renderPage(pageQuery(target));
    expect(explanationOf(html)).toBe(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expect(html).toContain(B.email);
    expectSafeGet(html, "/app/settings");
    expect(auth.user).toEqual(B);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each([A, B])("still logs out the verified same person $email locally with a 303", async (user) => {
    auth.user = user;
    const response = await post(user.id);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/`);
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
    expect(auth.user).toBeNull();
  });

  it("keeps the existing login exit for a POST with no current session", async () => {
    auth.user = null;
    const response = await post(A.id);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${ORIGIN}/login`);
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(auth.user).toBeNull();
  });

  it("keeps another operation generic and removes old POST inputs from its fresh GET", async () => {
    const target = new URL(accountChangedPath("/app/settings/delete?confirm=delete-account&expectedUserId=old#old"), ORIGIN);
    expect(target.searchParams.has("notice")).toBe(false);
    const html = await renderPage(pageQuery(target));
    expect(explanationOf(html)).toContain("操作を止めました");
    expect(explanationOf(html)).not.toContain("ログアウト");
    expect(html).not.toContain(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expect(html).toContain(B.email);
    expect(html).not.toMatch(/confirm=|#old/);
    expectSafeGet(html, "/app/settings/delete");
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("keeps the logout notice through an unknown-session safe GET retry, then verifies B again", async () => {
    const target = recoveryTarget(await post(A.id));
    auth.getSession.mockRejectedValueOnce(new Error("synthetic session lookup unavailable"));
    const unknownHtml = await renderPage(pageQuery(target));
    expect(unknownHtml).toContain("現在のアカウントを確認できませんでした");
    expect(unknownHtml).not.toContain(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expect(unknownHtml).not.toContain(B.email);
    expect(unknownHtml).not.toContain("現在ログインしていません");
    const links = findAll(parseHtml(unknownHtml), (node) => node.tag === "a");
    expect(links).toHaveLength(1);
    expect(textOf(links[0])).toBe("もう一度確認する");
    const retry = new URL(links[0].attrs.href, ORIGIN);
    expect(retry.pathname).toBe("/account-changed");
    expect(retry.searchParams.get("next")).toBe("/app/settings");
    expect(retry.searchParams.get("notice")).toBe("logout");
    expectSafeGet(unknownHtml, `${retry.pathname}${retry.search}`);

    const verifiedHtml = await renderPage(pageQuery(retry));
    expect(explanationOf(verifiedHtml)).toBe(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expect(verifiedHtml).toContain(B.email);
    expectSafeGet(verifiedHtml, "/app/settings");
    expect(auth.getSession).toHaveBeenCalledTimes(2);
    expect(auth.user).toEqual(B);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("does not claim an account remains signed in after the GET verifies signed out", async () => {
    const target = recoveryTarget(await post(A.id));
    auth.user = null;
    const html = await renderPage(pageQuery(target));
    expect(html).toContain("現在ログインしていません");
    expect(html).not.toContain(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expect(html).not.toContain(B.email);
    expect(explanationOf(html)).not.toContain("ログアウト");
    expectSafeGet(html, "/login?next=%2Fapp%2Fsettings");
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each([
    { label: "missing", notice: undefined },
    { label: "empty", notice: "" },
    { label: "unknown", notice: "not-logout" },
    { label: "case changed", notice: "Logout" },
    { label: "single-value array", notice: ["logout"] },
    { label: "repeated marker array", notice: ["logout", "logout"] },
    { label: "mixed marker array", notice: ["logout", "unknown"] },
  ])("does not treat a $label marker as a verified logout notice", async ({ notice }) => {
    const html = await renderPage({ next: "/app/settings", notice });
    expect(html).toContain(B.email);
    expect(explanationOf(html)).toContain("操作を止めました");
    expect(explanationOf(html)).not.toContain("ログアウト");
    expect(html).not.toContain(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expectSafeGet(html, "/app/settings");
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each([
    { label: "external URL", next: "https://outside.example.test/path" },
    { label: "protocol relative URL", next: "//outside.example.test/path" },
    { label: "old auth POST", next: "/auth/signout" },
    { label: "recovery loop", next: "/account-changed?notice=logout" },
    { label: "login loop", next: "/login" },
    { label: "query array", next: ["/app/settings", "/app/settings/delete"] },
  ])("keeps a $label next value on a safe app GET", async ({ next }) => {
    const html = await renderPage({ next, notice: "logout" });
    expect(explanationOf(html)).toBe(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expectSafeGet(html, "/app");
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it.each([
    { label: "unknown string", notice: "unknown" },
    { label: "query array", notice: ["logout", "unknown"] },
  ])("does not carry an untrusted $label marker through an unknown-session retry", async ({ notice }) => {
    auth.getSession.mockRejectedValueOnce(new Error("synthetic session lookup unavailable"));
    const html = await renderPage({ next: "/app/settings?confirm=old", notice });
    expect(html).not.toContain(ACCOUNT_CHANGED_LOGOUT_NOTICE);
    expect(html).not.toContain(B.email);
    expectSafeGet(html, accountChangedPath("/app/settings"));
    const retry = new URL(findAll(parseHtml(html), (node) => node.tag === "a")[0].attrs.href, ORIGIN);
    expect(retry.searchParams.has("notice")).toBe(false);
    expect(auth.signOut).not.toHaveBeenCalled();
  });

  it("keeps the provisional notice nonempty and expresses the next logout step", () => {
    expect(ACCOUNT_CHANGED_LOGOUT_NOTICE.trim().length).toBeGreaterThan(0);
    for (const meaning of [/ログイン/, /画面/, /開き直/, /ログアウト/]) expect(ACCOUNT_CHANGED_LOGOUT_NOTICE).toMatch(meaning);
  });

  it("renders a replacement from the one notice constant without a second inline copy", async () => {
    const replacement = "合成の案内です。ログイン中の画面を開き直して、ログアウトしてください。";
    vi.doMock("@/lib/account-changed-text", () => ({ ACCOUNT_CHANGED_LOGOUT_NOTICE: replacement }));
    vi.resetModules();
    try {
      const RewordedPage = (await import("@/app/account-changed/page")).default;
      const html = renderToStaticMarkup(await RewordedPage({ searchParams: Promise.resolve({ next: "/app/settings", notice: "logout" }) }));
      expect(explanationOf(html)).toBe(replacement);
      expect(html).not.toContain(ACCOUNT_CHANGED_LOGOUT_NOTICE);
      expect(html).toContain(B.email);
      expectSafeGet(html, "/app/settings");
      expect(auth.signOut).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@/lib/account-changed-text");
      vi.resetModules();
    }
  });
});
