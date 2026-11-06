import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { safeNextPath } from "@/lib/safe-next";

/**
 * Review A-2: where the browser goes right after login. safeNextPath's answer is the Location of
 * POST /auth/confirm, and the hidden `next` of the /auth/continue form that posts there. It must be
 * a path on this site whatever a link says: "/.//x.example" used to come back as "//x.example",
 * which a browser reads as another site.
 */

const SITE = "https://otodoke.app";

/** The site a browser lands on for a Location header sent by POST /auth/confirm. */
const lands = (location: string) => new URL(location, `${SITE}/auth/confirm`).origin;

const HOSTILE: Array<[string, string]> = [
  ["a dot segment before an empty one (review A-2)", "/.//x.example"],
  ["two dots before an empty one", "/..//x.example"],
  ["dots after a real segment", "/app/..//x.example"],
  ["more dots than segments", "/app/../..//x.example"],
  ["encoded dots", "/%2e%2e//x.example"],
  ["encoded dots in capitals", "/%2E%2E//x.example"],
  ["a backslash after a dot", "/./\\x.example"],
  ["a backslash as the separator", "/.\\/x.example"],
  ["backslashes only", "/app\\..\\..\\\\x.example"],
  ["an encoded slash", "/%2F/x.example"],
  ["an encoded slash in lower case", "/%2f/x.example"],
  ["an encoded backslash", "/%5C/x.example"],
  ["an encoded backslash in lower case", "/%5c/x.example"],
  ["a doubly encoded slash", "/%252F/x.example"],
  ["a triply encoded slash", "/%25252F/x.example"],
  ["a doubly encoded backslash", "/%255C/x.example"],
  ["an encoded dot and slash", "/%2E%2F/x.example"],
  ["a dot and an encoded slash", "/.%2F/x.example"],
  ["an encoded dot segment, then an encoded slash", "/%2e/%2f/x.example"],
  ["a tab", "/\t/x.example"],
  ["a newline", "/\n/x.example"],
  ["CR LF", "/\r\n/x.example"],
  ["a tab before a backslash", "/\t\\x.example"],
  ["an encoded tab", "/%09/x.example"],
  ["an encoded newline", "/%0A/x.example"],
  ["an encoded newline in lower case", "/%0a/x.example"],
  ["an encoded CR LF", "/%0D%0A/x.example"],
  ["a doubly encoded tab", "/%2509/x.example"],
  ["the other site in capitals", "/.//X.EXAMPLE"],
  ["two slashes", "//x.example"],
  ["a slash and a backslash", "/\\x.example"],
  ["a full URL", "https://x.example"],
  ["a full URL in capitals", "HTTPS://X.EXAMPLE/app"],
  ["a slash nested deeper than any server decodes", `/%${"25".repeat(20)}2F/x.example`],
];

const NOT_A_PATH: Array<[string, string | null]> = [
  ["nothing", null],
  ["empty", ""],
  ["a bare host", "x.example"],
  ["a script URL", "javascript:alert(1)"],
  ["a leading space", " /app"],
];

const UUID = "0b6c1c1e-2f2a-4b8a-9d55-3f1e2a7c9b10";

/** [what, value, what comes back]: every place the app sends a person to after login. */
const LEGIT: Array<[string, string, string]> = [
  ["the parcel list", "/app", "/app"],
  ["a month of the calendar", "/app/calendar?m=2026-11", "/app/calendar?m=2026-11"],
  ["a parcel", `/app/parcels/${UUID}`, `/app/parcels/${UUID}`],
  ["a parcel's edit page", `/app/parcels/${UUID}/edit`, `/app/parcels/${UUID}/edit`],
  ["settings at a fragment", "/app/settings#demo", "/app/settings#demo"],
  ["a query and a fragment", "/app/settings?x=1#y", "/app/settings?x=1#y"],
  ["several query values", "/app/delivered?m=2026-10&s=40", "/app/delivered?m=2026-10&s=40"],
  ["a Japanese query as typed", "/app/spend?c=食品", "/app/spend?c=%E9%A3%9F%E5%93%81"],
  ["a Japanese query, encoded", "/app/spend?c=%E9%A3%9F%E5%93%81", "/app/spend?c=%E9%A3%9F%E5%93%81"],
  ["a Japanese path, encoded", "/app/%E8%8D%B7%E7%89%A9", "/app/%E8%8D%B7%E7%89%A9"],
  ["encoded slashes in the query", "/app?q=a%2F%2Fb", "/app?q=a%2F%2Fb"],
  ["a percent sign in the query", "/app?q=100%25", "/app?q=100%25"],
  ["the top page", "/", "/"],
];

/**
 * [Review R3-36] Nothing after login leads back into /auth/ (nor /auth itself): a next there showed
 * this site's own answer after a login that worked (/auth/continue?link=refused, a refusal that did
 * not happen), or put another person's token behind 「荷物を見る」. Refused however it is written,
 * as far as safeNextPath reads a path (parsed, then its ASCII escapes decoded up to MAX_DECODES).
 */
const INTO_AUTH: Array<[string, string]> = [
  ["the continue page with the refusal's mark", "/auth/continue?link=refused"],
  ["the continue page with someone's token", "/auth/continue?token_hash=OTHER&type=email"],
  ["the confirm route", "/auth/confirm?token_hash=OTHER&type=email"],
  ["the sign-out route", "/auth/signout"],
  ["/auth itself", "/auth"],
  ["/auth/ with nothing after it", "/auth/"],
  ["the continue page at a fragment", "/auth/continue#x"],
  ["in capitals", "/AUTH/CONTINUE?link=refused"],
  ["in mixed case", "/Auth/Continue"],
  ["after a dot segment", "/./auth/continue"],
  ["through a dot segment", "/app/../auth/continue?link=refused"],
  ["through an encoded dot segment", "/app/%2e%2e/auth/continue"],
  ["through a doubly encoded dot segment", "/app/%252e%252e/auth/continue"],
  ["with an encoded slash", "/auth%2Fcontinue?link=refused"],
  ["with an encoded slash in lower case", "/auth%2fcontinue"],
  ["with a doubly encoded slash", "/auth%252Fcontinue"],
  ["with an encoded letter", "/%61uth/continue"],
  ["with a doubly encoded letter in capitals", "/%2541UTH/continue"],
  ["with an encoded question mark", "/auth%3Flink=refused"],
  ["with a backslash", "/auth\\continue"],
  ["with a tab inside", "/au\tth/continue"],
  ["nested deeper than any server decodes", `/%${"25".repeat(20)}61uth/continue`],
];

/** Next to /auth but not in it: kept as they are (only the path counts, and only /auth/). */
const BESIDE_AUTH: Array<[string, string, string]> = [
  ["/auth/ resolved away by its dot segment", "/auth/../app", "/app"],
  ["/auth named in the query", "/app?from=%2Fauth%2Fcontinue", "/app?from=%2Fauth%2Fcontinue"],
  ["/auth named in the fragment", "/app/settings#/auth", "/app/settings#/auth"],
  ["a path that only starts with the letters", "/authors", "/authors"],
];

describe("safeNextPath", () => {
  it.each(HOSTILE)("sends %s to /app", (_what, value) => {
    expect(safeNextPath(value)).toBe("/app");
  });

  it.each(NOT_A_PATH)("sends %s to /app", (_what, value) => {
    expect(safeNextPath(value)).toBe("/app");
  });

  it.each(LEGIT)("keeps %s", (_what, value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });

  it.each(INTO_AUTH)("[R3-36] sends %s to /app", (_what, value) => {
    expect(safeNextPath(value)).toBe("/app");
  });

  it.each(BESIDE_AUTH)("[R3-36] keeps %s", (_what, value, expected) => {
    expect(safeNextPath(value)).toBe(expected);
  });

  it("[R3-36] never answers with a path into /auth/, however it is read", () => {
    for (const [, value] of [...HOSTILE, ...NOT_A_PATH, ...LEGIT, ...INTO_AUTH, ...BESIDE_AUTH]) {
      const location = safeNextPath(value);
      // As the browser resolves the Location, and once more as a server that decodes the path would.
      const resolved = new URL(location, SITE).pathname;
      for (const path of [resolved, new URL(decodeURIComponent(resolved), SITE).pathname]) {
        expect(path.toLowerCase(), JSON.stringify(value)).not.toMatch(/^\/auth(\/|$)/);
      }
    }
  });

  it("never answers with something a browser reads as another site", () => {
    for (const [, value] of [...HOSTILE, ...NOT_A_PATH, ...LEGIT, ...INTO_AUTH, ...BESIDE_AUTH]) {
      const location = safeNextPath(value);
      expect(lands(location), JSON.stringify(value)).toBe(SITE);
      expect(location, JSON.stringify(value)).toMatch(/^\/(?![/\\])/);
    }
  });
});

// A mail's link still carries a next (the mails ask Supabase for /auth/confirm?next=%2Fapp), but
// since password-v1 nothing follows it: GET passes it to /auth/continue (R3-28's three fields),
// the page does not post it, and POST /auth/confirm answers a constant for either kind of link.

const mocks = vi.hoisted(() => ({ cookieVerify: vi.fn(), throwawayVerify: vi.fn() }));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp: mocks.cookieVerify } }), getUser: async () => null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ auth: { verifyOtp: mocks.throwawayVerify, admin: { signOut: async () => ({ data: null, error: null }) } } }),
}));

const { GET, POST } = await import("@/app/auth/confirm/route");
const ContinuePage = (await import("@/app/auth/continue/page")).default as unknown as (p: {
  searchParams: Promise<Record<string, string>>;
}) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;

const TOKEN = "token-hash-from-the-mail";
const SAME_ORIGIN = { host: "otodoke.app", origin: SITE, "sec-fetch-site": "same-origin" };

/** The hidden fields of the /auth/continue form, as the browser will post them. */
async function posted(params: Record<string, string>): Promise<Record<string, string>> {
  const html = renderToStaticMarkup(await ContinuePage({ searchParams: Promise.resolve(params) }));
  return Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2].replaceAll("&amp;", "&")]));
}

async function postConfirm(fields: Record<string, string>): Promise<string | null> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const res = await POST(new NextRequest(`${SITE}/auth/confirm`, { method: "POST", body, headers: SAME_ORIGIN }));
  expect(res.status).toBe(303);
  return res.headers.get("location");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  mocks.cookieVerify.mockReset();
  mocks.cookieVerify.mockResolvedValue({ data: { session: null }, error: null });
  mocks.throwawayVerify.mockReset();
  mocks.throwawayVerify.mockResolvedValue({ data: { session: null }, error: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const EVERY_NEXT: Array<[string, string]> = [...HOSTILE, ...INTO_AUTH, ...LEGIT.map(([what, value]): [string, string] => [what, value])];

describe("a next from a link is never followed", () => {
  it.each(EVERY_NEXT)("POST /auth/confirm answers 「確認できました」 for a confirmation, whatever the next: %s", async (_what, value) => {
    expect(await postConfirm({ token_hash: TOKEN, type: "email", next: value })).toBe("/auth/confirmed");
  });

  it.each(EVERY_NEXT)("POST /auth/confirm answers the reset page for a reset link, whatever the next: %s", async (_what, value) => {
    expect(await postConfirm({ token_hash: TOKEN, type: "recovery", next: value })).toBe("/reset-password");
  });

  it.each(EVERY_NEXT)("/auth/continue does not post the next: %s", async (_what, value) => {
    expect(await posted({ token_hash: TOKEN, type: "email", next: value })).toEqual({ token_hash: TOKEN, type: "email" });
  });

  it.each(HOSTILE.slice(0, 12))("from the mail's link to the Location after the button, on this site: %s", async (_what, value) => {
    for (const type of ["email", "recovery"]) {
      // The mail's button: the link the mails ask for, with the token added (supabase/templates).
      const link = `${SITE}/auth/confirm?next=${encodeURIComponent(value)}&token_hash=${TOKEN}&type=${type}`;
      const opened = (await GET(new NextRequest(link))).headers.get("location")!;
      expect(lands(opened)).toBe(SITE);
      const continueUrl = new URL(opened, SITE);
      expect(continueUrl.pathname).toBe("/auth/continue");
      const location = await postConfirm(await posted(Object.fromEntries(continueUrl.searchParams)));
      expect(location).toBe(type === "recovery" ? "/reset-password" : "/auth/confirmed");
      expect(lands(location!)).toBe(SITE);
    }
  });
});
