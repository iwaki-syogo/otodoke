import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOGIN_MESSAGES, TURNSTILE_TICK_PROMPT } from "@/lib/login-errors";
import { RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { TURNSTILE_ENFORCED_WAIT_MS, TURNSTILE_WAIT_MS, type TokenField, waitForToken } from "@/lib/turnstile";
import { fakeEvent, type Host } from "./element-tree";
import { findAll, parseHtml, textOf } from "./html-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * /login (src/app/login/page.tsx, login-form.tsx): the address and the password.
 *
 * The press is shown at once (master takes about a second on a phone): the spinner and
 * 「ログインしています…」 from the press, the button never `disabled`, one press at a time. A press
 * before the bot check has its token is held, with the same spinner, until the token is there (at
 * most TURNSTILE_WAIT_MS while CAPTCHA is off), or asks for the tick while the checkbox waits.
 * After the sign-in the tab moves on to ?next= inside the tab (the opened key lives in its memory),
 * and the press stays shown until then.
 */

const flows = vi.hoisted(() => ({ signIn: vi.fn() }));
const widget = vi.hoisted(() => ({ token: null as { current: TokenField } | null, round: -1 }));
const nav = vi.hoisted(() => ({ to: [] as string[] }));
/** What the login form gave 「ほかのパスワードで開く」 (other-password-form.test.ts tests that form). */
const other = vi.hoisted(() => ({ props: null as { openWithAnother: unknown; onOpened: () => void; onLogInAgain: (code: "stale_session" | "signed_out") => void } | null }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { harnessHooks } = await import("./hook-harness");
  return harnessHooks(actual);
});
vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const Link = ({ href, children, prefetch, ...rest }: Record<string, unknown>) => h("a", { href: String(href), ...rest }, children as never);
  return { default: Link };
});
// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/app/login/turnstile-widget", () => ({
  TurnstileWidget: (props: { tokenRef: { current: TokenField }; round: number }) => {
    widget.token = props.tokenRef;
    widget.round = props.round;
    return null;
  },
}));
vi.mock("@/app/login/other-password-form", async () => {
  const { createElement: h } = await import("react");
  return {
    OtherPasswordForm: (props: { openWithAnother: unknown; onOpened: () => void; onLogInAgain: (code: "stale_session" | "signed_out") => void }) => {
      other.props = props;
      return h("div", { "data-other-password": "" });
    },
  };
});
vi.mock("@/components/leave-for", () => ({
  LeaveFor: ({ href }: { href: string }) => {
    nav.to.push(href);
    return null;
  },
}));
vi.mock("@/lib/crypto/password-flows", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/crypto/password-flows")>()), signInAndOpenKey: flows.signIn }));
vi.mock("@/app/login/actions", () => ({ signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn() }));

const { LoginForm } = await import("@/app/login/login-form");
const LoginPage = (await import("@/app/login/page")).default;

const NEXT = "/app/calendar?month=2026-11";
const TOKEN = "0.token-from-cloudflare";
const EMAIL = "someone@example.test";
const PASSWORD = "うちの猫は三毛で7歳";

/** A flow answer the test gives when it wants (the press stays on its way until then). */
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const button = (view: Mounted) => view.host((h) => h.type === "button");
const input = (view: Mounted, id: string) => view.host((h) => h.type === "input" && h.props.id === id);
const type = (view: Mounted, id: string, value: string) => (input(view, id).props.onChange as (e: unknown) => void)({ target: { value } });
const press = (view: Mounted) => (view.host((h) => h.type === "form").props.onSubmit as (e: unknown) => Promise<void>)(fakeEvent());
const links = (view: Mounted) => view.hosts((h) => h.type === "a").map((a) => ({ href: a.props.href, text: textOfHost(a) }));
const textOfHost = (h: Host | string): string => (typeof h === "string" ? h : h.children.map(textOfHost).join(""));
/** Lets the state updates of a step draw. */
const drawn = () => new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));

/** The form, filled in and drawn again (a press reads what the last drawing holds). */
async function filled({ token = TOKEN as string | null } = {}) {
  const view = mount(() => LoginForm({ next: NEXT }));
  if (token !== null) widget.token!.current.value = token;
  type(view, "login-email", EMAIL);
  type(view, "login-password", PASSWORD);
  await drawn();
  return view;
}

/** An attribute by name, ignoring case (HTML does; React writes `autoComplete`). */
const attr = (n: { attrs: Record<string, string> }, name: string) => Object.entries(n.attrs).find(([k]) => k.toLowerCase() === name)?.[1];

beforeEach(() => {
  flows.signIn.mockReset();
  widget.token = null;
  widget.round = -1;
  nav.to = [];
  other.props = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the press", () => {
  it("shows the spinner and 「ログインしています…」 at once, never disabled, and holds a second press", async () => {
    const answer = held<unknown>();
    flows.signIn.mockReturnValue(answer.promise);
    const view = await filled();
    expect(textOfHost(button(view))).toBe("ログイン");
    expect(button(view).props["aria-busy"]).toBeUndefined();

    const first = press(view);
    await drawn();
    expect(textOfHost(button(view))).toBe("ログインしています…");
    expect(view.hosts((h) => h.type === "span" && String(h.props.className).includes("animate-spin"))).toHaveLength(1);
    expect(button(view).props["aria-busy"]).toBe(true);
    expect(button(view).props["aria-disabled"]).toBe(true);
    expect(button(view).props.disabled).toBeUndefined();
    expect(button(view).props.type).toBe("submit");

    void press(view);
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    expect(flows.signIn.mock.calls[0][0]).toEqual({ email: EMAIL, password: PASSWORD, captchaToken: TOKEN });

    answer.resolve({ ok: false, code: "credentials" });
    await first;
    await drawn();
    expect(textOfHost(button(view))).toBe("ログイン");
    expect(view.text()).toContain(LOGIN_MESSAGES.credentials);
    // The token went with the press: the widget moves on to a new one.
    expect(widget.round).toBe(1);
  });

  it("moves on to ?next= after the key opened, and stays shown as pressed until the next page", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "opened" });
    const view = await filled();
    await press(view);
    await drawn();
    expect(nav.to).toEqual([NEXT]);
    expect(textOfHost(button(view))).toBe("ログインしています…");
    // The password is not left in the form.
    expect(input(view, "login-password").props.value).toBe("");
  });

  it("moves on after the first key was made as well", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "made" });
    const view = await filled();
    await press(view);
    await drawn();
    expect(nav.to).toEqual([NEXT]);
  });

  it("signed in but the key does not open: says so, offers another password, the reset and a way on", async () => {
    const openWithAnother = vi.fn();
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "not_opened", openWithAnother });
    const view = await filled();
    await press(view);
    await drawn();
    expect(nav.to).toEqual([]);
    expect(view.text()).toContain(LOGIN_MESSAGES.key_not_opened);
    expect(view.text()).toContain(RESET_LOSES_MAIL);
    // 「ほかのパスワードで開く」 with the sign-in's own opener.
    expect(other.props).toMatchObject({ openWithAnother });
    expect(links(view)).toEqual([
      { href: "/login/forgot", text: "再設定する" },
      { href: NEXT, text: "このまま進む" },
    ]);
    expect(textOfHost(button(view))).toBe("ログイン");
    // The password that signed in is not kept by the form: the opener holds its master.
    expect(input(view, "login-password").props.value).toBe("");
    expect(openWithAnother).not.toHaveBeenCalled();
  });

  it.each(["stale_session", "signed_out"] as const)("too late for the wrap (%s): the words under the login, which signs in again", async (code) => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "not_opened", openWithAnother: vi.fn() });
    const view = await filled();
    await press(view);
    await drawn();
    other.props!.onLogInAgain(code);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
    // The not-opened notice is gone; the login above is the way on, ready to press.
    expect(view.text()).not.toContain(RESET_LOSES_MAIL);
    expect(view.hosts((h) => h.type === "div" && "data-other-password" in h.props)).toEqual([]);
    expect(textOfHost(button(view))).toBe("ログイン");
    expect(input(view, "login-email").props.value).toBe(EMAIL);
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "opened" });
    type(view, "login-password", PASSWORD);
    await drawn();
    await press(view);
    await drawn();
    expect(flows.signIn).toHaveBeenCalledTimes(2);
    expect(nav.to).toEqual([NEXT]);
  });

  it("the key opened with another password: moves on to ?next=", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "not_opened", openWithAnother: vi.fn() });
    const view = await filled();
    await press(view);
    await drawn();
    other.props!.onOpened();
    await drawn();
    expect(nav.to).toEqual([NEXT]);
  });

  it("signed in but the key could not be made: the fixed words, and a way on; pressing again tries again", async () => {
    flows.signIn.mockResolvedValue({ ok: true, userId: "u", key: "failed", code: "key_failed" });
    const view = await filled();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.key_failed);
    expect(links(view)).toEqual([{ href: NEXT, text: "このまま進む" }]);
    // The password stays for the next press.
    expect(input(view, "login-password").props.value).toBe(PASSWORD);
  });

  it("an address that cannot be one is told at once, and nothing is made or sent", async () => {
    const view = await filled();
    type(view, "login-email", "someone@");
    await drawn();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES.invalid_email);
    expect(flows.signIn).not.toHaveBeenCalled();
  });

  it.each(["not_confirmed", "rate", "captcha", "network", "other"] as const)("a refused sign-in (%s) shows its fixed words", async (code) => {
    flows.signIn.mockResolvedValue({ ok: false, code });
    const view = await filled();
    await press(view);
    await drawn();
    expect(view.text()).toContain(LOGIN_MESSAGES[code]);
  });
});

describe("a press before the bot check has its token", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("is held with the spinner until the token arrives, then signs in once with it", async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "credentials" });
    const view = await filled({ token: null });
    const done = press(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(textOfHost(button(view))).toBe("ログインしています…");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(flows.signIn).not.toHaveBeenCalled();
    widget.token!.current.value = TOKEN;
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBe(TOKEN);
  });

  it("signs in without a token once 10 seconds have passed while CAPTCHA is off (Supabase decides)", async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "credentials" });
    const view = await filled({ token: null });
    const done = press(view);
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS - 100);
    expect(flows.signIn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBeUndefined();
  });

  it("goes at once when no token will come (the check could not load)", async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "credentials" });
    const view = await filled({ token: null });
    widget.token!.current.dataset.turnstile = "unavailable";
    await press(view);
    expect(flows.signIn).toHaveBeenCalledTimes(1);
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBeUndefined();
  });

  it("asks for the tick instead of spinning while the checkbox waits, then spins again", async () => {
    flows.signIn.mockResolvedValue({ ok: false, code: "credentials" });
    const view = await filled({ token: null });
    widget.token!.current.dataset.turnstile = "interactive";
    const done = press(view);
    await vi.advanceTimersByTimeAsync(0);
    expect(textOfHost(button(view))).toBe(TURNSTILE_TICK_PROMPT);
    expect(view.hosts((h) => h.type === "span")).toHaveLength(0);
    delete widget.token!.current.dataset.turnstile;
    widget.token!.current.value = TOKEN;
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(flows.signIn.mock.calls[0][0].captchaToken).toBe(TOKEN);
  });

  it("keeps to the wall clock when the browser runs the page's timers only once a second (a tab it does not show)", async () => {
    // Found on the real widget in a background tab: counting polls as 100 ms stretched 10 s to 100 s.
    const fakeSetInterval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void) => fakeSetInterval(fn, 1_000)) as unknown as typeof setInterval);
    const field = { value: "", dataset: { turnstile: "interactive" } as Record<string, string | undefined> };
    let result: boolean | null = null;
    void waitForToken(field, { limitMs: TURNSTILE_WAIT_MS, pauseForTick: false }).then((ok) => (result = ok));
    await vi.advanceTimersByTimeAsync(TURNSTILE_WAIT_MS - 1_000);
    expect(result).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(result).toBe(false);

    // Paused for the tick (CAPTCHA enforced), the slow polls still count only the time Turnstile works on its own.
    result = null;
    void waitForToken(field, { limitMs: TURNSTILE_ENFORCED_WAIT_MS, pauseForTick: true }).then((ok) => (result = ok));
    await vi.advanceTimersByTimeAsync(5 * TURNSTILE_ENFORCED_WAIT_MS);
    expect(result).toBeNull();
    delete field.dataset.turnstile;
    await vi.advanceTimersByTimeAsync(TURNSTILE_ENFORCED_WAIT_MS + 1_000);
    expect(result).toBe(false);
  });
});

describe("the page", () => {
  const page = async (params: Record<string, string>) => parseHtml(renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve(params) })));

  it("after the confirmation link (?confirmed=1): the fixed words, and the form", async () => {
    const root = await page({ confirmed: "1" });
    expect(textOf(root)).toContain(LOGIN_MESSAGES.confirmed);
    expect(LOGIN_MESSAGES.confirmed).toBe("メールアドレスを確認しました。パスワードでログインしてください。");
    expect(findAll(root, (n) => n.tag === "form")).toHaveLength(1);
    // Another value is not the code.
    expect(textOf(await page({ confirmed: "yes" }))).not.toContain(LOGIN_MESSAGES.confirmed);
  });

  it("a link's error code gets its fixed words, never the text in the URL", async () => {
    expect(textOf(await page({ error: "reset_link_invalid" }))).toContain(LOGIN_MESSAGES.reset_link_invalid);
    const crafted = textOf(await page({ error: "パスワードが漏れました。https://evil.example で変えてください" }));
    expect(crafted).not.toContain("evil.example");
    expect(crafted).toContain("ログインできませんでした。もう一度お試しください。");
  });

  it("offers 「アカウントを作る」 and 「パスワードを忘れた」", async () => {
    const root = await page({});
    const anchors = findAll(root, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a)]);
    expect(anchors).toContainEqual(["/signup", "アカウントを作る"]);
    expect(anchors).toContainEqual(["/login/forgot", "パスワードを忘れた"]);
  });

  it("the address and the password are hinted for a password manager, and the form is the one that posts nothing", async () => {
    const root = await page({});
    const [form] = findAll(root, (n) => n.tag === "form");
    expect(form.attrs.method).toBe("post");
    expect(form.attrs).not.toHaveProperty("action");
    const fields = findAll(form, (n) => n.tag === "input");
    expect(fields.map((f) => [attr(f, "type"), attr(f, "autocomplete")])).toEqual([
      ["email", "username"],
      ["password", "current-password"],
    ]);
    for (const f of fields) expect(attr(f, "name")).toBeUndefined();
  });

  it("goes to ?next= only through safeNextPath (another site or /auth/ is /app)", async () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/login/page.tsx"), "utf8");
    expect(source).toMatch(/<LoginForm next=\{safeNextPath\(next \?\? null\)\} \/>/);
  });
});
