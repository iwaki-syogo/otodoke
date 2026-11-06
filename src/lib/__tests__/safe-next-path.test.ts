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

  it("never answers with something a browser reads as another site", () => {
    for (const [, value] of [...HOSTILE, ...NOT_A_PATH, ...LEGIT]) {
      const location = safeNextPath(value);
      expect(lands(location), JSON.stringify(value)).toBe(SITE);
      expect(location, JSON.stringify(value)).toMatch(/^\/(?![/\\])/);
    }
  });
});

// The three places a `next` passes through: the login form's link, /auth/continue's hidden field,
// and the Location of POST /auth/confirm. The route and the action are read here, not changed.

type OtpArgs = { email: string; options?: { emailRedirectTo?: string; captchaToken?: string } };

const mocks = vi.hoisted(() => ({
  otp: [] as OtpArgs[],
  verifyOtp: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-real-ip": "203.0.113.7" }) }));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      verifyOtp: mocks.verifyOtp,
      signInWithOtp: async (args: OtpArgs) => {
        mocks.otp.push(args);
        return { error: null };
      },
    },
  }),
  getUser: async () => null,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));

const { GET, POST } = await import("@/app/auth/confirm/route");
const { sendMagicLink } = await import("@/app/login/actions");
const ContinuePage = (await import("@/app/auth/continue/page")).default as unknown as (p: {
  searchParams: Promise<Record<string, string>>;
}) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;

const TOKEN = "token-hash-from-the-mail";
const SAME_ORIGIN = { host: "otodoke.app", origin: SITE, "sec-fetch-site": "same-origin" };

/** The hidden `next` of the /auth/continue form, as the browser will post it. */
async function hiddenNext(params: Record<string, string>): Promise<string> {
  const html = renderToStaticMarkup(await ContinuePage({ searchParams: Promise.resolve(params) }));
  const match = /<input type="hidden" name="next" value="([^"]*)"\/>/.exec(html);
  if (!match) throw new Error(`no hidden next in ${html}`);
  return match[1].replaceAll("&amp;", "&");
}

async function postConfirm(next: string): Promise<string | null> {
  const body = new FormData();
  body.set("token_hash", TOKEN);
  body.set("type", "email");
  body.set("next", next);
  const res = await POST(new NextRequest(`${SITE}/auth/confirm`, { method: "POST", body, headers: SAME_ORIGIN }));
  expect(res.status).toBe(303);
  return res.headers.get("location");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", SITE);
  vi.stubEnv("VERCEL_ENV", "production");
  mocks.otp.length = 0;
  mocks.verifyOtp.mockReset();
  mocks.verifyOtp.mockResolvedValue({ error: null });
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (fn: string) =>
    fn === "claim_login_mail" ? { data: [{ verdict: "ok", claim_id: 7 }], error: null } : { data: 1, error: null },
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a next from a link stays on this site at every step", () => {
  it.each(HOSTILE)("POST /auth/confirm sends %s to /app after login", async (_what, value) => {
    expect(await postConfirm(value)).toBe("/app");
    expect(mocks.verifyOtp).toHaveBeenCalledTimes(1);
  });

  it.each(LEGIT)("POST /auth/confirm keeps %s", async (_what, value, expected) => {
    expect(await postConfirm(value)).toBe(expected);
  });

  it.each(HOSTILE)("/auth/continue posts /app for %s", async (_what, value) => {
    expect(await hiddenNext({ token_hash: TOKEN, type: "email", next: value })).toBe("/app");
  });

  it("/auth/continue posts /app when the link has no next", async () => {
    expect(await hiddenNext({ token_hash: TOKEN, type: "email" })).toBe("/app");
  });

  const THROUGH_THE_MAIL: Array<[string, string]> = [...HOSTILE.slice(0, 12), ...[LEGIT[1], LEGIT[6], LEGIT[7]].map(([what, value]): [string, string] => [what, value])];

  it.each(THROUGH_THE_MAIL)(
    "from the login form to the Location after login: %s",
    async (_what, value) => {
      // 1. The login form asks Supabase for a link back to this site's /auth/confirm.
      const form = new FormData();
      form.set("email", "someone@example.com");
      form.set("next", value);
      await expect(sendMagicLink(form)).rejects.toThrow("REDIRECT:/login?sent=");
      const redirectTo = new URL(mocks.otp[0].options!.emailRedirectTo!);
      expect(redirectTo.origin).toBe(SITE);
      expect(redirectTo.pathname).toBe("/auth/confirm");
      expect(redirectTo.searchParams.get("next")).toBe(value);

      // 2. The mail's button: the link with the token added (supabase/templates/magic_link.html).
      const link = `${redirectTo.href}&token_hash=${TOKEN}&type=email`;

      // 3. Opening it shows /auth/continue, on this site.
      const opened = (await GET(new NextRequest(link))).headers.get("location")!;
      expect(lands(opened)).toBe(SITE);
      const continueUrl = new URL(opened, SITE);
      expect(continueUrl.pathname).toBe("/auth/continue");

      // 4. Its button posts the next, and 5. the Location after login is a path on this site.
      const posted = await hiddenNext(Object.fromEntries(continueUrl.searchParams));
      const location = await postConfirm(posted);
      expect(location).toBe(safeNextPath(value));
      expect(lands(location!)).toBe(SITE);
    },
  );
});
