import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement, type ReactNode } from "react";
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

const { GET, POST } = await import("@/app/auth/confirm/route");
const { SubmitButton } = await import("@/components/pending-button");
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

/** Opens a link to /auth/confirm (a path with its query), as a mail's button does; the Location. */
async function open(url: string): Promise<string> {
  const res = await GET(new NextRequest(new URL(url, "https://otodoke.app")));
  expect(res.status).toBe(307);
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
    // The link is not offered again: the page has no token now (its one form signs out, R3-35).
    expect(findAll(back, (n) => n.tag === "form" && n.attrs.action === "/auth/confirm")).toHaveLength(0);
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

/**
 * [Review R3-28] A URL made with someone's own token and link=refused (they ask for a login mail
 * to their address and take its token_hash). GET /auth/confirm passed its whole query on, so a
 * person signed in saw 「このリンクは使えませんでした。」, a refusal that did not happen, right
 * above 「別のアカウントでログインする」, which posts that token and signs in to their account.
 *
 * Two stops, each tested on its own: either one alone closes the way, so a test that follows the
 * made URL from end to end stays green with one of them gone.
 * - The page says nothing when its URL carries a token: the answer to a refused switch never does.
 * - GET /auth/confirm carries only the link's token_hash, type and next.
 */
describe("[R3-28] a URL made with someone's token and link=refused", () => {
  const MADE = "TOKEN-OF-THE-ONE-WHO-MADE-THE-URL";
  beforeEach(() => signedInAs("a@example.com"));

  it("the page says nothing when its URL carries a token (the page on its own)", async () => {
    const made = await continuePage(`/auth/continue?token_hash=${MADE}&type=email&link=refused`);
    expect(notices(made)).toHaveLength(0);
    expect(textOf(made)).not.toContain("使えませんでした");
    // The switch button is as before: it was always there for a link with a token.
    expect(fieldsOf(formOf(made, "別のアカウントでログインする"))).toMatchObject({ token_hash: MADE, intent: "switch_account" });
    // A token without a type draws no switch button; nothing is said either.
    expect(notices(await continuePage(`/auth/continue?token_hash=${MADE}&link=refused`))).toHaveLength(0);
  });

  it("GET /auth/confirm carries the link's token_hash, type and next, and never link=refused (the route on its own)", async () => {
    const carried = new URL(await open(`/auth/confirm?token_hash=${MADE}&type=email&next=%2Fapp%2Fsettings&link=refused`), "https://otodoke.app");
    expect(carried.pathname).toBe("/auth/continue");
    expect([...carried.searchParams]).toEqual([
      ["token_hash", MADE],
      ["type", "email"],
      ["next", "/app/settings"],
    ]);
    // The mark alone, or anything else a link holds, is not carried either.
    expect(await open("/auth/confirm?link=refused")).toBe("/auth/continue");
    expect(await open("/auth/confirm?link=refused&error=x&token_hash=t&type=email")).toBe("/auth/continue?token_hash=t&type=email");
    // A field written twice keeps both, in order: the page takes the first, as before.
    const twice = new URL(await open("/auth/confirm?token_hash=first&token_hash=second&type=email"), "https://otodoke.app");
    expect(twice.searchParams.getAll("token_hash")).toEqual(["first", "second"]);
  });

  it("opened from the mail's button, the made URL shows no refusal", async () => {
    const location = await open(`/auth/confirm?token_hash=${MADE}&type=email&link=refused`);
    expect(notices(await continuePage(location))).toHaveLength(0);
  });

  it("a refused switch still comes back saying so: its answer carries no token", async () => {
    const location = await post({ token_hash: TOKEN, type: "email", next: "/app/settings", intent: "switch_account" });
    expect(new URL(location, "https://otodoke.app").searchParams.has("token_hash")).toBe(false);
    expect(notices(await continuePage(location))).toHaveLength(1);
  });
});

/**
 * [Review R3-35] After a refused switch the page said what failed but not what to do: someone who
 * wants the other account signs out first, then asks for a new link. 「ログアウト」 sits under the
 * notice, only with it. It posts to /auth/signout as the button in 設定 does, with the same word,
 * and shows the press as the other buttons do (SubmitButton).
 */
describe("[R3-35] 「ログアウト」 under the notice of a refused switch", () => {
  beforeEach(() => signedInAs("a@example.com"));

  /** The forms that sign out. */
  const signOuts = (root: HtmlNode) => findAll(root, (n) => n.tag === "form" && n.attrs.action === "/auth/signout");

  /** Elements of a type in the page's tree as returned (components are not called). */
  function elementsOf(node: ReactNode, type: unknown): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    const walk = (n: ReactNode) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!isValidElement<{ children?: ReactNode }>(n)) return;
      if (n.type === type) out.push(n as ReactElement<Record<string, unknown>>);
      walk(n.props.children);
    };
    walk(node);
    return out;
  }

  /** The word on 設定's sign-out button, from its source. */
  const settingsSignOut = () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/app/settings/page.tsx"), "utf8");
    const form = /<form action="\/auth\/signout" method="post">([\s\S]*?)<\/form>/.exec(source);
    expect(form, "設定 signs out with a form").not.toBeNull();
    const word = />\s*([^<>{}]+?)\s*<\/(?:button|SubmitButton)>/.exec(form![1]);
    expect(word, "設定's sign-out button has a word").not.toBeNull();
    return word![1];
  };

  it("comes with the notice, under it, as the one way to sign out", async () => {
    const back = await continuePage(await post(fieldsOf(formOf(await continuePage(linkAt()), "別のアカウントでログインする"))));
    const forms = signOuts(back);
    expect(forms).toHaveLength(1);
    expect(forms[0].attrs.method).toBe("post");
    expect(findAll(forms[0], (n) => n.tag === "button").map((b) => [b.attrs.type, textOf(b).trim()])).toEqual([["submit", "ログアウト"]]);
    // In the page's order: the notice, 「ログアウト」, then 「荷物を見る」.
    const [notice] = notices(back);
    const [toList] = findAll(back, (n) => n.tag === "a" && textOf(n).trim() === "荷物を見る");
    expect(findAll(back, (n) => n === notice || n === forms[0] || n === toList)).toEqual([notice, forms[0], toList]);
  });

  it("is 設定's sign-out: the same word, the same route and method", async () => {
    expect(settingsSignOut()).toBe("ログアウト");
    const button = findAll(signOuts(await continuePage("/auth/continue?link=refused"))[0], (n) => n.tag === "button");
    expect(textOf(button[0]).trim()).toBe(settingsSignOut());
  });

  it("shows the press with the shared SubmitButton, for a form that leaves the page", async () => {
    const tree = await ContinuePage({ searchParams: Promise.resolve({ link: "refused" }) });
    const buttons = elementsOf(tree as ReactNode, SubmitButton);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].props).toMatchObject({ leavesPage: true, pendingLabel: "ログアウトしています…", children: "ログアウト" });
  });

  it("is not there without the notice", async () => {
    // The switch offered, nothing refused; no mark; a made URL with a token and the mark.
    for (const url of [linkAt(), "/auth/continue", "/auth/continue?link=other", `/auth/continue?token_hash=${TOKEN}&type=email&link=refused`]) {
      const page = await continuePage(url);
      expect(signOuts(page), url).toHaveLength(0);
      expect(textOf(page), url).not.toContain("ログアウト");
    }
    mocks.user = null;
    expect(signOuts(await continuePage("/auth/continue?link=refused"))).toHaveLength(0);
  });
});

/**
 * [Review R3-36] A next into /auth/ (safe-next-path.test.ts has every spelling): a link made with
 * someone's token and next=/auth/continue?link=refused ended a login that worked on a refusal
 * that did not happen; a refused switch whose next held a token led 「荷物を見る」 to that token's
 * switch. Every way after login now leads to /app.
 */
describe("[R3-36] a next into /auth/", () => {
  const MADE = "TOKEN-OF-THE-ONE-WHO-MADE-THE-URL";
  const madeLink = `/auth/confirm?token_hash=${MADE}&type=email&next=${encodeURIComponent("/auth/continue?link=refused")}`;
  const WORKS = { data: { user: {}, session: {} }, error: null };

  it("a switch that works from the made link lands on the parcels, not on a refusal", async () => {
    signedInAs("a@example.com");
    const page = await continuePage(await open(madeLink));
    mocks.verifyOtp.mockResolvedValue(WORKS);
    expect(await post(fieldsOf(formOf(page, "別のアカウントでログインする")))).toBe("/app");
  });

  it("「ログインする」 from the made link, signed out, lands on the parcels too", async () => {
    const page = await continuePage(await open(madeLink));
    mocks.verifyOtp.mockResolvedValue(WORKS);
    expect(await post(fieldsOf(formOf(page, "ログインする")))).toBe("/app");
  });

  it("「荷物を見る」 on the made link goes to the parcels", async () => {
    signedInAs("a@example.com");
    expect(links(await continuePage(await open(madeLink)))).toEqual([["/app", "荷物を見る"]]);
  });

  it("a refused switch whose next held a token: 「荷物を見る」 goes to the parcels, never to that token", async () => {
    signedInAs("a@example.com");
    const location = await post({ token_hash: TOKEN, type: "email", next: `/auth/continue?token_hash=${MADE}&type=email`, intent: "switch_account" });
    expect(location).toBe("/auth/continue?link=refused");
    const back = await continuePage(location);
    expect(notices(back)).toHaveLength(1);
    expect(links(back)).toEqual([["/app", "荷物を見る"]]);
    expect(textOf(back)).not.toContain(MADE);
  });
});
