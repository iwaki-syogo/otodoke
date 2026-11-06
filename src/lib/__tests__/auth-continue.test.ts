import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEvent } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * Review F-3: 「ログインする」 on /auth/continue showed nothing when pressed and took a second
 * press, which posts the one-time link again and can end on 「すでに使われたリンク」. A person
 * already signed in got the same login prompt, and the same red error for a used link.
 *
 * - The press shows a spinner and 「ログインしています…」 at once; a second press is cancelled
 *   (a ref, so also the second click of a double tap that comes before React draws the first).
 * - Never `disabled`: a native form does not post from a button disabled during its click.
 * - Signed in already: 「ログインしています」, the address, 「荷物を見る」, and switching to the
 *   link's account only as its own button.
 */

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
const session = vi.hoisted(() => ({ user: null as null | { email?: string }, fails: false }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => {
    if (session.fails) throw new Error("Invalid environment: NEXT_PUBLIC_SUPABASE_URL");
    return session.user;
  },
}));

const { ContinueButton } = await import("@/app/auth/continue/continue-button");
const ContinuePage = (await import("@/app/auth/continue/page")).default as unknown as (p: {
  searchParams: Promise<Record<string, string | string[]>>;
}) => Promise<Parameters<typeof renderToStaticMarkup>[0]>;

/** A stand-in window for the back-forward cache: its pageshow listeners and reload. */
function fakeWindow() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const win = {
    location: { reload: vi.fn() },
    addEventListener: vi.fn((type: string, fn: (e: unknown) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    }),
    removeEventListener: vi.fn((type: string, fn: (e: unknown) => void) => listeners.get(type)?.delete(fn)),
    pageshow: (persisted: boolean) => listeners.get("pageshow")?.forEach((fn) => fn({ persisted })),
    listening: () => listeners.get("pageshow")?.size ?? 0,
  };
  vi.stubGlobal("window", win);
  return win;
}

function setup(props: { label?: string; secondary?: boolean } = {}) {
  const win = fakeWindow();
  const view: Mounted = mount(() => ContinueButton(props));
  /** Presses the button; true when the press was cancelled (the form is not posted). */
  const press = () => {
    const event = fakeEvent({});
    (view.host((h) => h.type === "button").props.onClick as (e: unknown) => void)(event);
    return event.defaultPrevented;
  };
  const button = () => view.host((h) => h.type === "button").props;
  return { win, view, press, button };
}

beforeEach(() => {
  session.user = null;
  session.fails = false;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the 「ログインする」 button", () => {
  it("reads 「ログインする」, with no spinner, before the press", () => {
    const { view, button } = setup();
    expect(view.text()).toBe("ログインする");
    expect(view.hosts((h) => h.type === "span")).toHaveLength(0);
    expect(button().type).toBe("submit");
    expect(button()["aria-busy"]).toBeUndefined();
    expect(button()["aria-disabled"]).toBeUndefined();
    expect(String(button().className)).not.toContain("pointer-events-none");
  });

  it("lets the first press post the form and shows 「ログインしています…」 with a spinner at once", async () => {
    const { view, press, button } = setup();
    expect(press()).toBe(false);
    await Promise.resolve();
    expect(view.text()).toBe("ログインしています…");
    expect(view.host((h) => h.type === "span").props.className).toContain("animate-spin");
    expect(button()["aria-busy"]).toBe(true);
    expect(button()["aria-disabled"]).toBe(true);
    expect(String(button().className)).toContain("pointer-events-none");
  });

  it("cancels a second press, also one that comes before the first press is drawn", async () => {
    const { press } = setup();
    expect(press()).toBe(false);
    // The second click of a double tap: same tick, nothing drawn yet.
    expect(press()).toBe(true);
    await Promise.resolve();
    expect(press()).toBe(true);
    expect(press()).toBe(true);
  });

  it("is never disabled, before or after the press", async () => {
    const { press, button } = setup();
    expect(button().disabled).toBeUndefined();
    press();
    await Promise.resolve();
    expect(button().disabled).toBeUndefined();
    expect(renderToStaticMarkup(createElement(ContinueButton))).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it("loads the page again when the browser brings it back pressed, and only then", async () => {
    const pressed = setup();
    expect(pressed.win.listening()).toBe(1);
    pressed.press();
    await Promise.resolve();
    pressed.win.pageshow(false);
    expect(pressed.win.location.reload).not.toHaveBeenCalled();
    pressed.win.pageshow(true);
    expect(pressed.win.location.reload).toHaveBeenCalledTimes(1);

    const untouched = setup();
    untouched.win.pageshow(true);
    expect(untouched.win.location.reload).not.toHaveBeenCalled();
    untouched.view.unmount();
    expect(untouched.win.listening()).toBe(0);
  });

  it("can say something else, with the same press", async () => {
    const { view, press } = setup({ label: "別のアカウントでログインする", secondary: true });
    expect(view.text()).toBe("別のアカウントでログインする");
    expect(press()).toBe(false);
    await Promise.resolve();
    expect(view.text()).toBe("ログインしています…");
    expect(press()).toBe(true);
  });

  it("is a client component without `disabled`, and the page has no button of its own", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/auth/continue/continue-button.tsx"), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
    // `aria-disabled` is how the press is shown; a plain `disabled` would stop the post.
    expect(source).toMatch(/aria-disabled=/);
    expect(source).not.toMatch(/(?<![-\w])disabled\s*=/);
    const page = readFileSync(path.resolve(__dirname, "../../app/auth/continue/page.tsx"), "utf8");
    expect(page).not.toMatch(/<button\b/);
  });
});

const TOKEN = "token-hash-from-the-mail";

async function page(params: Record<string, string | string[]>) {
  return renderToStaticMarkup(await ContinuePage({ searchParams: Promise.resolve(params) }));
}

/** Each <form>'s action and method. */
const forms = (html: string) =>
  [...html.matchAll(/<form\b([^>]*)>/g)].map((m) => [/\baction="([^"]*)"/.exec(m[1])?.[1], /\bmethod="([^"]*)"/.exec(m[1])?.[1]]);
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>(.*?)<\/button>/g)].map((m) => m[1]);
const links = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => [m[1], m[2]]);
const hidden = (html: string) => Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]));

describe("/auth/continue, signed out", () => {
  it("asks to log in, with the button in a form that posts the token", async () => {
    const html = await page({ token_hash: TOKEN, type: "email", next: "/app/calendar?m=2026-11" });
    expect(html).toContain("Otodoke にログインしますか？");
    expect(forms(html)).toEqual([["/auth/confirm", "post"]]);
    expect(hidden(html)).toEqual({ token_hash: TOKEN, type: "email", next: "/app/calendar?m=2026-11" });
    expect(buttons(html)).toEqual(["ログインする"]);
    expect(html).not.toContain("ログインしています");
  });

  it("says the link is incomplete when it has no token", async () => {
    const html = await page({ type: "email" });
    expect(html).toContain("リンクが不完全です。");
    expect(links(html)).toEqual([["/login", "もう一度リンクを送ってください。"]]);
    expect(html).not.toContain("<form");
  });

  it("asks to log in, as before, when the session cannot be read", async () => {
    session.fails = true;
    const html = await page({ token_hash: TOKEN, type: "email" });
    expect(html).toContain("Otodoke にログインしますか？");
    expect(buttons(html)).toEqual(["ログインする"]);
  });

  it("takes the first of a value written twice", async () => {
    const html = await page({ token_hash: [TOKEN, "other"], type: ["email", "magiclink"], next: ["/.//x.example", "/app"] });
    expect(hidden(html)).toEqual({ token_hash: TOKEN, type: "email", next: "/app" });
  });
});

describe("/auth/continue, signed in already", () => {
  beforeEach(() => {
    session.user = { email: "someone@example.com" };
  });

  it("says so, shows the address and the way into the app, and does not prompt to log in", async () => {
    const html = await page({ token_hash: TOKEN, type: "email", next: "/app" });
    expect(html).toContain("<h1");
    expect(html).toContain("ログインしています</h1>");
    expect(html).toContain("someone@example.com");
    expect(links(html)).toEqual([["/app", "荷物を見る"]]);
    expect(html).not.toContain("Otodoke にログインしますか？");
    expect(buttons(html)).not.toContain("ログインする");
  });

  it("keeps switching to the link's account as its own button", async () => {
    const html = await page({ token_hash: TOKEN, type: "email", next: "/app" });
    expect(buttons(html)).toEqual(["別のアカウントでログインする"]);
    expect(forms(html)).toEqual([["/auth/confirm", "post"]]);
    // [Review R3-23] intent: a refused switch comes back saying so (switch-account-refused.test.ts).
    expect(hidden(html)).toEqual({ token_hash: TOKEN, type: "email", next: "/app", intent: "switch_account" });
  });

  it("goes where the link was going, and only to a path on this site", async () => {
    expect(links(await page({ token_hash: TOKEN, type: "email", next: "/app/calendar?m=2026-11" }))).toEqual([["/app/calendar?m=2026-11", "荷物を見る"]]);
    expect(links(await page({ token_hash: TOKEN, type: "email", next: "/.//x.example" }))).toEqual([["/app", "荷物を見る"]]);
    expect(links(await page({ token_hash: TOKEN, type: "email" }))).toEqual([["/app", "荷物を見る"]]);
  });

  it("shows no error and no switch for a link without a token", async () => {
    const html = await page({});
    expect(html).toContain("ログインしています</h1>");
    expect(links(html)).toEqual([["/app", "荷物を見る"]]);
    expect(html).not.toContain("リンクが不完全です");
    expect(html).not.toContain("<form");
  });

  it("leaves the address line out when the account has none", async () => {
    session.user = {};
    const html = await page({ token_hash: TOKEN, type: "email" });
    expect(html).toContain("ログインしています</h1>");
    expect(html).not.toContain("break-all");
  });
});
