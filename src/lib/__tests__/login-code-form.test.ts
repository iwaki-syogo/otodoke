import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LOGIN_ERROR_MESSAGES } from "@/lib/login-errors";
import { LOGIN_CODE_MAX_DIGITS, LOGIN_CODE_MIN_DIGITS, normalizeLoginCode } from "@/lib/login-form";
import { fakeEvent } from "./element-tree";

/**
 * Review F-2: the login mail carries the link and a code, but the Web had no field for the code.
 * A home-screen web app on iPhone keeps its cookies apart from Safari (where the link opens), and
 * a mail read on another device signs that device in by the link. The "sent" screen now takes the
 * code: verifyOtp({ email, token, type: "email" }) with the address this browser sent to.
 *
 * - The address is in this browser's cookie (login-email-cookie.ts), never in the URL; it is
 *   forgotten once the code has signed the browser in.
 * - Full-width digits, spaces and dashes are read; 6 to 10 digits (otp_length) are accepted.
 * - A refused code, Supabase's limit and an outage get different words; all stay on the screen.
 * - No CAPTCHA on the code (Supabase does not check one on /verify).
 */

type Cookie = { name: string; value: string; options?: Record<string, unknown> };
type VerifyArgs = { email: string; token: string; type: string; options?: unknown };

const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  sets: [] as Cookie[],
  deletes: [] as unknown[],
  verify: [] as VerifyArgs[],
  verifyAnswer: { data: { user: {}, session: {} }, error: null } as unknown,
  verifyThrows: null as Error | null,
  otpError: null as null | { status: number; code?: string; message: string },
  pending: false,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "otodoke.app", "x-forwarded-proto": "https" }),
  cookies: async () => ({
    get: (name: string) => (mocks.jar.has(name) ? { name, value: mocks.jar.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      mocks.sets.push({ name, value, options });
      mocks.jar.set(name, value);
    },
    delete: (arg: string | { name: string }) => {
      mocks.deletes.push(arg);
      mocks.jar.delete(typeof arg === "string" ? arg : arg.name);
    },
  }),
}));
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: mocks.pending, data: null, method: null, action: null }),
}));
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/lib/login-mail-limit", () => ({
  clientIp: () => null,
  claimLoginMail: async () => ({ verdict: "ok", claimId: null }),
  releaseLoginMail: async () => {},
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async () => ({ error: mocks.otpError }),
      verifyOtp: async (args: VerifyArgs) => {
        mocks.verify.push(args);
        if (mocks.verifyThrows) throw mocks.verifyThrows;
        return mocks.verifyAnswer;
      },
    },
  }),
}));

const { sendMagicLink, verifyLoginCode } = await import("@/app/login/actions");
const { CodeSubmitButton } = await import("@/app/login/code-submit-button");

const EMAIL = "someone@example.com";
const CODE = "12345678";
const remember = (email: string) => mocks.jar.set("otodoke_login", JSON.stringify({ e: email }));

async function run(action: (f: FormData) => Promise<void>, fields: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  try {
    await action(form);
  } catch (error) {
    return (error as Error).message;
  }
  return "no redirect";
}
const send = (fields: Record<string, string> = {}) => run(sendMagicLink, { email: EMAIL, next: "/app", ...fields });
const verify = (code: string, next = "/app") => run(verifyLoginCode, { code, next });

type El = { type: unknown; props: Record<string, unknown> };
async function pageTree(params: Record<string, string>): Promise<unknown> {
  const Page = (await import("@/app/login/page")).default as unknown as (p: { searchParams: Promise<Record<string, string>> }) => Promise<unknown>;
  return Page({ searchParams: Promise.resolve(params) });
}
const loginPage = async (params: Record<string, string>) => renderToStaticMarkup((await pageTree(params)) as Parameters<typeof renderToStaticMarkup>[0]);
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
const tag = (html: string, re: RegExp) => html.match(re)?.[0] ?? null;

function consoleText(): string {
  return [console.log, console.info, console.warn, console.error]
    .flatMap((fn) => vi.mocked(fn).mock.calls)
    .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
    .join("\n");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://otodoke.app");
  vi.stubEnv("VERCEL_ENV", "production");
  mocks.jar.clear();
  mocks.sets.length = 0;
  mocks.deletes.length = 0;
  mocks.verify.length = 0;
  mocks.verifyAnswer = { data: { user: {}, session: {} }, error: null };
  mocks.verifyThrows = null;
  mocks.otpError = null;
  mocks.pending = false;
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("after a send, the address is in a cookie, not the URL", () => {
  it("lands on the sent screen with no address in the URL", async () => {
    const url = await send();
    expect(url).toBe("REDIRECT:/login?sent=1");
    expect(url).not.toMatch(/example|%40|@/);
    expect(JSON.parse(mocks.jar.get("otodoke_login")!)).toEqual({ e: EMAIL });
  });

  it("keeps where to go after signing in, on the sent screen and on a refused send", async () => {
    expect(await send({ next: "/app/settings" })).toBe("REDIRECT:/login?sent=1&next=%2Fapp%2Fsettings");
    mocks.otpError = { status: 500, code: "unexpected_failure", message: "refused" };
    expect(await send({ next: "/app/settings" })).toBe("REDIRECT:/login?error=send_failed&next=%2Fapp%2Fsettings");
    // Somewhere that is not a path on this site is not carried.
    mocks.otpError = null;
    expect(await send({ next: "//evil.example/x" })).toBe("REDIRECT:/login?sent=1");
  });
});

describe("the sent screen", () => {
  it("names the address, and has a code field and 「ログイン」", async () => {
    remember(EMAIL);
    const html = await loginPage({ sent: "1" });
    expect(html).toContain(`${EMAIL} にメールを送りました。`);
    expect(html).toContain("メールのリンクを開くか、コードを入力してください。届かないときは迷惑メールも見てください。");
    const field = tag(html, /<input[^>]*name="code"[^>]*>/);
    expect(field).toContain('autoComplete="one-time-code"');
    expect(field).toContain('inputMode="numeric"');
    expect(field).toContain('type="text"');
    expect(field).toContain("required");
    // Full-width digits, spaces and dashes are read on the server: the browser must not refuse them.
    expect(field).not.toMatch(/pattern=|maxLength=/i);
    expect(html).toContain(">ログイン</button>");
    // The form posts to verifyLoginCode.
    const form = find(await pageTree({ sent: "1" }), (el) => el.type === "form");
    expect(form?.props.action).toBe(verifyLoginCode);
  });

  it("does not show the send form, the bot check or the address field", async () => {
    remember(EMAIL);
    const html = await loginPage({ sent: "1" });
    expect(html).not.toContain('name="email"');
    expect(html).not.toContain("data-turnstile-widget");
    expect(html).not.toContain("リンクを送る");
  });

  it("offers 「メールを送り直す」 back to the send form, which has the address in it", async () => {
    remember(EMAIL);
    const sentHtml = await loginPage({ sent: "1" });
    expect(tag(sentHtml, /<a[^>]*>メールを送り直す<\/a>/)).toContain('href="/login"');
    const formHtml = await loginPage({});
    expect(tag(formHtml, /<input[^>]*name="email"[^>]*>/)).toContain(`value="${EMAIL}"`);
  });

  it("carries where to go after signing in, in the code form and in 「メールを送り直す」", async () => {
    remember(EMAIL);
    const html = await loginPage({ sent: "1", next: "/app/settings" });
    expect(html).toContain('<input type="hidden" name="next" value="/app/settings"/>');
    expect(tag(html, /<a[^>]*>メールを送り直す<\/a>/)).toContain('href="/login?next=%2Fapp%2Fsettings"');
  });

  it("without an address in this browser, says only that the mail went out (no code form)", async () => {
    const html = await loginPage({ sent: "1" });
    expect(html).toContain("メールを送りました。");
    expect(html).toContain("メールのリンクを開くとログインできます。");
    expect(html).not.toContain('name="code"');
    expect(html).toContain("メールを送り直す");
  });

  it("takes the code for an address it does not say back (not plain ASCII)", async () => {
    remember("テスト@例え.jp");
    const html = await loginPage({ sent: "1" });
    expect(html).not.toContain("テスト@");
    expect(html).toContain("メールを送りました。");
    expect(html).toContain('name="code"');
  });
});

describe("verifyLoginCode", () => {
  it("checks the code with the address this browser sent to, then forgets the address and goes on", async () => {
    remember(EMAIL);
    expect(await verify(CODE)).toBe("REDIRECT:/app");
    // No CAPTCHA token: Supabase does not check one on /verify.
    expect(mocks.verify).toEqual([{ email: EMAIL, token: CODE, type: "email" }]);
    expect(mocks.deletes).toEqual([{ name: "otodoke_login", path: "/login" }]);
    expect(mocks.jar.has("otodoke_login")).toBe(false);
  });

  it("goes where the visitor was headed, and only to a path on this site", async () => {
    remember(EMAIL);
    expect(await verify(CODE, "/app/settings?tab=mail")).toBe("REDIRECT:/app/settings?tab=mail");
    remember(EMAIL);
    expect(await verify(CODE, "https://evil.example/")).toBe("REDIRECT:/app");
    remember(EMAIL);
    expect(await verify(CODE, "/\\evil.example")).toBe("REDIRECT:/app");
  });

  it.each([
    ["full-width digits", "１２３４５６７８"],
    ["a space in the middle", "1234 5678"],
    ["an ideographic space", "1234　5678"],
    ["spaces around", "  12345678 "],
    ["a hyphen", "1234-5678"],
    ["a full-width hyphen", "1234－5678"],
    ["the long vowel mark a Japanese keyboard types for -", "1234ー5678"],
    ["a minus sign", "1234−5678"],
    ["full-width digits and spaces", "１２３４　５６７８"],
  ])("reads %s as the digits", async (_label, typed) => {
    remember(EMAIL);
    expect(await verify(typed)).toBe("REDIRECT:/app");
    expect(mocks.verify.at(-1)?.token).toBe(CODE);
  });

  it("accepts every length Supabase can be set to (6 to 10)", async () => {
    expect([LOGIN_CODE_MIN_DIGITS, LOGIN_CODE_MAX_DIGITS]).toEqual([6, 10]);
    for (const code of ["123456", "1234567890"]) {
      remember(EMAIL);
      expect(await verify(code)).toBe("REDIRECT:/app");
      expect(mocks.verify.at(-1)?.token).toBe(code);
    }
  });

  it.each([
    ["too short", "12345"],
    ["too long", "12345678901"],
    ["a letter", "1234567O"],
    ["a symbol", "1234.5678"],
    ["empty", ""],
    ["spaces only", "   "],
  ])("does not ask Supabase about something that cannot be a code (%s)", async (_label, typed) => {
    remember(EMAIL);
    expect(await verify(typed)).toBe("REDIRECT:/login?sent=1&error=code_format");
    expect(mocks.verify).toHaveLength(0);
    expect(await loginPage({ sent: "1", error: "code_format" })).toContain(LOGIN_ERROR_MESSAGES.code_format);
  });

  it("asks for a new mail when this browser no longer knows the address", async () => {
    expect(await verify(CODE)).toBe("REDIRECT:/login?error=code_no_address");
    expect(mocks.verify).toHaveLength(0);
    expect(await loginPage({ error: "code_no_address" })).toContain("もう一度リンクを送ってから、届いたメールのコードを入力してください。");
  });

  it.each([
    ["a wrong, expired, used or replaced code (403)", { status: 403, code: "otp_expired", message: "Token has expired or is invalid" }, "code_invalid"],
    ["an address Supabase refuses (422)", { status: 422, code: "validation_failed", message: "Invalid email format" }, "code_invalid"],
    ["Supabase's limit on verifications (429)", { status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" }, "code_limited"],
    ["no answer", { status: 0, message: "fetch failed" }, "code_failed"],
    ["a 5xx", { status: 503, message: "Service Unavailable" }, "code_failed"],
  ])("stays on the sent screen with fixed words for %s", async (_label, error, code) => {
    remember(EMAIL);
    mocks.verifyAnswer = { data: { user: null, session: null }, error };
    expect(await verify(CODE)).toBe(`REDIRECT:/login?sent=1&error=${code}`);
    // The address is kept for the next try.
    expect(mocks.deletes).toHaveLength(0);
    const html = await loginPage({ sent: "1", error: code });
    expect(html).toContain(LOGIN_ERROR_MESSAGES[code as keyof typeof LOGIN_ERROR_MESSAGES]);
    expect(html).toContain('name="code"');
    expect(html).not.toContain(error.message);
  });

  it("says the same as an outage when verifyOtp throws", async () => {
    remember(EMAIL);
    mocks.verifyThrows = new Error("An error occurred on token verification.");
    expect(await verify(CODE, "/app/settings")).toBe("REDIRECT:/login?sent=1&error=code_failed&next=%2Fapp%2Fsettings");
  });

  it("has words that tell the three apart, with the wait for the limit and the newest mail for a refused code", () => {
    expect(LOGIN_ERROR_MESSAGES.code_invalid).toBe("コードが違うか、期限が切れています。いちばん新しいメールのコードを入力してください。");
    expect(LOGIN_ERROR_MESSAGES.code_limited).toBe("ただいま混み合っています。1分ほど待ってから、もう一度お試しください。");
    expect(LOGIN_ERROR_MESSAGES.code_failed).toBe("いまはログインできませんでした。少し時間をおいて、もう一度お試しください。");
    for (const text of Object.values(LOGIN_ERROR_MESSAGES)) expect(text).not.toMatch(/[（(]/);
  });

  it("never writes the code or the address to the log", async () => {
    remember(EMAIL);
    mocks.verifyAnswer = { data: { user: null, session: null }, error: { status: 403, code: "otp_expired", message: "Token has expired or is invalid" } };
    await verify("87654321");
    mocks.verifyThrows = new Error("boom");
    await verify("87654321");
    expect(consoleText()).toContain("verifyOtp");
    expect(consoleText()).not.toContain("87654321");
    expect(consoleText()).not.toContain("someone");
  });
});

describe("normalizeLoginCode", () => {
  it("returns ASCII digits only, or null", () => {
    expect(normalizeLoginCode("０１２３４５")).toBe("012345");
    expect(normalizeLoginCode(" 0123 4567 ")).toBe("01234567");
    expect(normalizeLoginCode(undefined)).toBeNull();
    expect(normalizeLoginCode(12345678)).toBeNull();
    expect(normalizeLoginCode("1".repeat(65))).toBeNull();
    // Digits of other scripts are not the code's digits.
    expect(normalizeLoginCode("١٢٣٤٥٦٧٨")).toBeNull();
  });
});

describe("the 「ログイン」 button", () => {
  const html = () => renderToStaticMarkup(createElement(CodeSubmitButton));

  it("shows a spinner and 「ログイン中…」 from the press until the code has been checked", () => {
    expect(html()).toContain(">ログイン</button>");
    expect(html()).not.toContain("animate-spin");
    mocks.pending = true;
    expect(html()).toContain("ログイン中…");
    expect(html()).toContain("animate-spin");
    expect(html()).toContain('aria-busy="true"');
  });

  it("is never disabled, and cancels a second press while checking", () => {
    for (const pending of [false, true]) {
      mocks.pending = pending;
      expect(html()).not.toMatch(/\sdisabled(=|\s|>)/);
      const button = CodeSubmitButton() as unknown as { props: { onClick: (e: unknown) => void; type: string } };
      expect(button.props.type).toBe("submit");
      const event = fakeEvent();
      button.props.onClick(event);
      expect(event.defaultPrevented).toBe(pending);
    }
  });
});
