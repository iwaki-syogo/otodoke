import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findAll, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Review R3-23] Signed in as one account, 「別のアカウントでログインする」 with a link that cannot be
 * used (a used one, say) came back to 「ログインしています」 without a word. Now that button's form
 * posts intent=switch_account, and when /auth/confirm refuses its link in a browser that is signed
 * in, the continue page comes back with link=refused and says 「このリンクは使えませんでした。」.
 *
 * Every other refused link in a signed-in browser comes back as before, without a word (the person
 * is signed in, as they meant to be): 「ログインする」 pressed again in a page drawn before signing
 * in, an old link in another tab. The mark is only shown: the way into the app is the link's next
 * either way, and the check that the post comes from this site is as it was.
 */

const TOKEN = "token-hash-from-the-mail";
const NOTICE = "このリンクは使えませんでした。";
const SAME_SITE = { host: "otodoke.app", origin: "https://otodoke.app", "sec-fetch-site": "same-origin" };
const OTHER_SITE = { host: "otodoke.app", origin: "https://evil.example", "sec-fetch-site": "cross-site" };

const mocks = vi.hoisted(() => ({
  user: null as null | { id: string; email?: string },
  verifyOtp: vi.fn(),
  getUser: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => mocks.user,
  createClient: async () => ({ auth: { verifyOtp: mocks.verifyOtp, getUser: mocks.getUser } }),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});

const { POST } = await import("@/app/auth/confirm/route");
const ContinuePage = (await import("@/app/auth/continue/page")).default as unknown as (p: {
  searchParams: Promise<Record<string, string | string[]>>;
}) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;

/** What supabase-js answers for a used, expired or replaced link. */
const REFUSED = { data: { user: null, session: null }, error: { name: "AuthApiError", status: 403, code: "otp_expired", message: "Email link is invalid or has expired" } };

const signedInAs = (email: string) => {
  mocks.user = { id: `id-${email}`, email };
};

beforeEach(() => {
  mocks.user = null;
  mocks.verifyOtp.mockReset();
  mocks.verifyOtp.mockResolvedValue(REFUSED);
  mocks.getUser.mockReset();
  mocks.getUser.mockImplementation(async () => ({ data: { user: mocks.user }, error: mocks.user ? null : { message: "Auth session missing!" } }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** /auth/continue at a URL (a path with its query), as Next hands the query to the page. */
async function continuePage(url: string): Promise<HtmlNode> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(url, "https://otodoke.app").searchParams) {
    const had = params[key];
    params[key] = had === undefined ? value : [...(Array.isArray(had) ? had : [had]), value];
  }
  return parseHtml(renderToStaticMarkup(await ContinuePage({ searchParams: Promise.resolve(params) })));
}

const linkAt = (next = "/app") => `/auth/continue?token_hash=${TOKEN}&type=email&next=${encodeURIComponent(next)}`;

/** The form whose button reads `label`. */
function formOf(root: HtmlNode, label: string): HtmlNode {
  const found = findAll(root, (n) => n.tag === "form" && findAll(n, (b) => b.tag === "button" && textOf(b).trim() === label).length > 0);
  expect(found, label).toHaveLength(1);
  return found[0];
}

/** What the form posts: its hidden fields. */
const fieldsOf = (form: HtmlNode) => Object.fromEntries(findAll(form, (n) => n.tag === "input" && n.attrs.type === "hidden").map((i) => [i.attrs.name, i.attrs.value]));

/** POST /auth/confirm with these fields; the Location it answers. */
async function post(fields: Record<string, string>, headers: Record<string, string> = SAME_SITE): Promise<string> {
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  const res = await POST(new NextRequest("https://otodoke.app/auth/confirm", { method: "POST", body, headers }));
  expect(res.status).toBe(303);
  return res.headers.get("location")!;
}

const notices = (root: HtmlNode) => findAll(root, (n) => textOf(n).trim() === NOTICE && n.children.every((c) => typeof c === "string"));
const links = (root: HtmlNode) => findAll(root, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()]);
const heading = (root: HtmlNode) => findAll(root, (n) => n.tag === "h1").map((h) => textOf(h).trim());

describe("「別のアカウントでログインする」 with a link that cannot be used", () => {
  beforeEach(() => signedInAs("a@example.com"));

  it("comes back to 「ログインしています」 and says 「このリンクは使えませんでした。」", async () => {
    const location = await post(fieldsOf(formOf(await continuePage(linkAt()), "別のアカウントでログインする")));
    expect(location).toBe("/auth/continue?link=refused");
    const back = await continuePage(location);
    expect(heading(back)).toEqual(["ログインしています"]);
    expect(textOf(back)).toContain("a@example.com");
    expect(notices(back)).toHaveLength(1);
    expect(links(back)).toEqual([["/app", "荷物を見る"]]);
    // The link is not offered again: the page has no token now.
    expect(findAll(back, (n) => n.tag === "form")).toHaveLength(0);
  });

  it("still leads where the link was going, and only to a path on this site", async () => {
    const calendar = "/app/calendar?m=2026-11";
    const location = await post(fieldsOf(formOf(await continuePage(linkAt(calendar)), "別のアカウントでログインする")));
    expect(location).toBe(`/auth/continue?next=${encodeURIComponent(calendar)}&link=refused`);
    const back = await continuePage(location);
    expect(links(back)).toEqual([[calendar, "荷物を見る"]]);
    expect(notices(back)).toHaveLength(1);

    const hostile = await post({ token_hash: TOKEN, type: "email", next: "https://evil.example/", intent: "switch_account" });
    expect(hostile).toBe("/auth/continue?link=refused");
    expect(links(await continuePage(hostile))).toEqual([["/app", "荷物を見る"]]);
  });

  it("switches as before when the link works, with no mark", async () => {
    mocks.verifyOtp.mockResolvedValue({ data: { user: {}, session: {} }, error: null });
    expect(await post(fieldsOf(formOf(await continuePage(linkAt("/app/settings")), "別のアカウントでログインする")))).toBe("/app/settings");
  });
});

describe("every other refused link in a signed-in browser comes back without a word, as before", () => {
  it("「ログインする」 pressed in a page drawn before signing in (the same link, used up by that sign-in, or an old one in another tab)", async () => {
    const drawnSignedOut = await continuePage(linkAt());
    const form = formOf(drawnSignedOut, "ログインする");
    expect(fieldsOf(form)).not.toHaveProperty("intent");
    signedInAs("a@example.com");
    const location = await post(fieldsOf(form));
    expect(location).toBe("/auth/continue");
    const back = await continuePage(location);
    expect(heading(back)).toEqual(["ログインしています"]);
    expect(notices(back)).toHaveLength(0);
    expect(textOf(back)).not.toContain("使えませんでした");
  });

  it("keeps the next as before", async () => {
    signedInAs("a@example.com");
    expect(await post({ token_hash: TOKEN, type: "email", next: "/app/settings" })).toBe("/auth/continue?next=%2Fapp%2Fsettings");
  });
});

describe("what does not change with the switch's intent", () => {
  const SWITCH = { token_hash: TOKEN, type: "email", next: "/app", intent: "switch_account" };

  it("nobody signed in: the login page's link_invalid", async () => {
    expect(await post(SWITCH)).toBe("/login?error=link_invalid");
  });

  it("a limit or an outage: the login page says so, as before (the link may still work)", async () => {
    signedInAs("a@example.com");
    mocks.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: { name: "AuthApiError", status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" } });
    expect(await post(SWITCH)).toBe("/login?error=link_limited");
    mocks.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: { name: "AuthRetryableFetchError", status: 503, code: undefined, message: "Service Unavailable" } });
    expect(await post(SWITCH)).toBe("/login?error=link_failed");
  });

  it("another site's form: refused before verifyOtp, the session not read", async () => {
    signedInAs("a@example.com");
    expect(await post(SWITCH, OTHER_SITE)).toBe("/login?error=link_invalid");
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
    expect(mocks.getUser).not.toHaveBeenCalled();
  });
});

describe("the continue page", () => {
  it("keeps the button's name, and only its form posts the intent", async () => {
    signedInAs("a@example.com");
    const signedIn = await continuePage(linkAt());
    expect(findAll(signedIn, (n) => n.tag === "button").map((b) => textOf(b).trim())).toEqual(["別のアカウントでログインする"]);
    expect(fieldsOf(formOf(signedIn, "別のアカウントでログインする"))).toEqual({ token_hash: TOKEN, type: "email", next: "/app", intent: "switch_account" });
    expect(notices(signedIn)).toHaveLength(0);

    mocks.user = null;
    expect(fieldsOf(formOf(await continuePage(linkAt()), "ログインする"))).toEqual({ token_hash: TOKEN, type: "email", next: "/app" });
  });

  it("says 「このリンクは使えませんでした。」 for link=refused only, and only to someone signed in", async () => {
    signedInAs("a@example.com");
    expect(notices(await continuePage("/auth/continue?link=refused"))).toHaveLength(1);
    expect(notices(await continuePage("/auth/continue?link=other"))).toHaveLength(0);
    expect(notices(await continuePage("/auth/continue"))).toHaveLength(0);

    mocks.user = null;
    const signedOut = await continuePage("/auth/continue?link=refused");
    expect(notices(signedOut)).toHaveLength(0);
    expect(heading(signedOut)).toEqual(["Otodoke にログインしますか？"]);
  });
});
