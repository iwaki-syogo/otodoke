import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Fix C's note (review D2-16): after a refused send the address field came back empty, because
 * Next.js draws the form anew after a Server Action redirects. The send action now keeps the
 * address in a cookie for this browser (httpOnly, Path=/login, SameSite=Lax, one hour, Secure
 * except over plain http) and the page puts it back in the field. The address never goes into
 * the URL.
 */

type Cookie = { name: string; value: string; options: Record<string, unknown> };

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  sets: [] as Cookie[],
  setThrows: false,
  headers: new Headers(),
  claim: "ok" as string,
  otpError: null as null | { status: number; code?: string; message: string },
  otp: [] as Array<{ email: string }>,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => mocks.headers,
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      if (mocks.setThrows) throw new Error("Cookies can only be modified in a Server Action or Route Handler.");
      mocks.sets.push({ name, value, options });
      mocks.jar.set(name, value);
    },
  }),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
// The limit has its own tests (login-mail-limit.test.ts): here it answers what a test sets.
vi.mock("@/lib/login-mail-limit", () => ({
  clientIp: () => null,
  claimLoginMail: async () => ({ verdict: mocks.claim, claimId: null }),
  releaseLoginMail: async () => {},
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async (args: { email: string }) => {
        mocks.otp.push(args);
        return { error: mocks.otpError };
      },
    },
  }),
}));

const EMAIL = "someone@example.com";

async function submit(email: string, fields: Record<string, string> = {}): Promise<string> {
  const { sendMagicLink } = await import("@/app/login/actions");
  const form = new FormData();
  form.set("email", email);
  form.set("next", "/app");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  try {
    await sendMagicLink(form);
  } catch (error) {
    return (error as Error).message;
  }
  return "no redirect";
}

type El = { type: unknown; key: string | null; props: Record<string, unknown> };

async function pageTree(params: Record<string, string>): Promise<unknown> {
  const Page = (await import("@/app/login/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
  return Page({ searchParams: Promise.resolve(params) });
}
const loginPage = async (params: Record<string, string>) => renderToStaticMarkup((await pageTree(params)) as Parameters<typeof renderToStaticMarkup>[0]);

/** The first element in the tree as the page returned it (components not called) that matches. */
function find(node: unknown, pred: (el: El) => boolean): El | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, pred);
      if (hit) return hit;
    }
    return null;
  }
  if (!node || typeof node !== "object" || !("props" in node)) return null;
  const el = node as El;
  return pred(el) ? el : find(el.props.children, pred);
}

/** The address field as rendered: its value attribute ("" when there is none). */
const fieldValue = (html: string) => {
  const input = html.match(/<input[^>]*name="email"[^>]*>/)?.[0];
  if (!input) throw new Error("no address field");
  return input.match(/\svalue="([^"]*)"/)?.[1] ?? "";
};

const kept = () => {
  const cookie = mocks.sets.at(-1);
  return cookie ? (JSON.parse(cookie.value) as { e: string }).e : null;
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://otodoke.app");
  vi.stubEnv("VERCEL_ENV", "production");
  mocks.jar.clear();
  mocks.sets.length = 0;
  mocks.setThrows = false;
  mocks.headers = new Headers({ host: "otodoke.app", "x-forwarded-proto": "https" });
  mocks.claim = "ok";
  mocks.otpError = null;
  mocks.otp.length = 0;
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("a refused send keeps the address in the field", () => {
  it.each([
    ["Supabase's limit (busy)", () => (mocks.otpError = { status: 429, code: "over_email_send_rate_limit", message: "Email rate limit exceeded" }), "busy"],
    ["the app's own limit", () => (mocks.claim = "email_10m"), "email_10m"],
    ["a failed send", () => (mocks.otpError = { status: 500, code: "unexpected_failure", message: "Error sending magic link email" }), "send_failed"],
    ["the bot check", () => (mocks.otpError = { status: 400, code: "captcha_failed", message: "captcha protection: request disallowed" }), "captcha_missing"],
  ])("after %s, in a cookie and not in the URL", async (_label, arrange, code) => {
    arrange();
    const url = await submit(EMAIL);
    expect(url).toBe(`REDIRECT:/login?error=${code}`);
    expect(url).not.toContain("example.com");
    expect(kept()).toBe(EMAIL);
    expect(fieldValue(await loginPage({ error: code }))).toBe(EMAIL);
  });

  it("keeps an address the server refuses as typed, so a typo is fixed in place", async () => {
    expect(await submit("  Someone@Example ")).toBe("REDIRECT:/login?error=invalid_email");
    expect(kept()).toBe("someone@example");
    expect(fieldValue(await loginPage({ error: "invalid_email" }))).toBe("someone@example");
  });

  it("keeps the address as it is sent: trimmed and lowercase", async () => {
    mocks.otpError = { status: 429, code: "over_email_send_rate_limit", message: "limit" };
    await submit("  SomeOne@Example.COM ");
    expect(kept()).toBe(EMAIL);
  });

  it("shows an empty field when nothing was kept, or the cookie is not one the app wrote", async () => {
    expect(fieldValue(await loginPage({}))).toBe("");
    for (const value of ["not json", '{"e":42}', '{"e":""}', "[]", "null", JSON.stringify({ e: `${"a".repeat(250)}@example.com` })]) {
      mocks.jar.set("otodoke_login", value);
      expect(fieldValue(await loginPage({ error: "busy" })), value).toBe("");
    }
  });

  it("redraws the field when the kept address changes (React 19 resets a form's fields after its action)", async () => {
    mocks.jar.set("otodoke_login", JSON.stringify({ e: EMAIL }));
    const input = find(await pageTree({ error: "busy" }), (el) => el.type === "input" && el.props.name === "email");
    expect(input?.props.defaultValue).toBe(EMAIL);
    expect(input?.key).toBe(`email:${EMAIL}`);
    mocks.jar.set("otodoke_login", JSON.stringify({ e: "other@example.com" }));
    expect(find(await pageTree({ error: "busy" }), (el) => el.type === "input" && el.props.name === "email")?.key).toBe("email:other@example.com");
  });
});

describe("the cookie", () => {
  it("is httpOnly, for /login only, SameSite=Lax, one hour, and Secure", async () => {
    await submit(EMAIL);
    expect(mocks.sets).toHaveLength(1);
    expect(mocks.sets[0].name).toBe("otodoke_login");
    expect(mocks.sets[0].options).toEqual({ httpOnly: true, secure: true, sameSite: "lax", path: "/login", maxAge: 3600 });
  });

  it("is not Secure over plain http (the local dev server), and Secure without the header", async () => {
    mocks.headers = new Headers({ host: "otodoke.localhost:3115", "x-forwarded-proto": "http" });
    await submit(EMAIL);
    expect(mocks.sets.at(-1)?.options.secure).toBe(false);
    mocks.headers = new Headers({ host: "otodoke.app" });
    await submit(EMAIL);
    expect(mocks.sets.at(-1)?.options.secure).toBe(true);
  });

  it("is not written for nothing or for something no address can be", async () => {
    await submit("");
    await submit(`${"a".repeat(250)}@example.com`);
    expect(mocks.sets).toHaveLength(0);
  });

  it("still sends when it cannot be written, and the warning does not carry the address", async () => {
    mocks.setThrows = true;
    expect((await submit(EMAIL)).startsWith("REDIRECT:/login?sent=")).toBe(true);
    expect(mocks.otp).toHaveLength(1);
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).toContain("could not keep the address");
    expect(logged).not.toContain("someone");
  });
});
