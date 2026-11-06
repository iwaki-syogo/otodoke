import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEvent } from "./element-tree";
import { mount, type Mounted } from "./hook-harness";

/**
 * /auth/continue, where a mail's link lands before its one-time token is used (password-v1).
 *
 * - Review F-3: the press shows a spinner and its words at once; a second press is cancelled (a
 *   ref, so also the second click of a double tap); never `disabled` (a native form would not post).
 * - The heading and the button by the link's type: the confirmation of an address, or a reset.
 * - A reset link signs this browser in to the account it resets: when another one is signed in
 *   here, the page says which address leaves. A confirmation does not touch this browser's session.
 * - The switch between accounts and its refusal (R3-23, R3-35) are gone with the login by link:
 *   nothing on the page comes from the URL but the token and its type, so a URL made with someone's
 *   token and link=refused cannot show a refusal or a switch (R3-28's negative control, kept).
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
const session = vi.hoisted(() => ({ user: null as null | { email?: string }, fails: false, asked: 0 }));
vi.mock("@/lib/supabase/server", () => ({
  getUser: async () => {
    session.asked++;
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

function setup(props: { label?: string; pendingLabel?: string; secondary?: boolean } = {}) {
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
  session.asked = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the button", () => {
  it("reads 「確認する」, with no spinner, before the press", () => {
    const { view, button } = setup();
    expect(view.text()).toBe("確認する");
    expect(view.hosts((h) => h.type === "span")).toHaveLength(0);
    expect(button().type).toBe("submit");
    expect(button()["aria-busy"]).toBeUndefined();
    expect(button()["aria-disabled"]).toBeUndefined();
    expect(String(button().className)).not.toContain("pointer-events-none");
  });

  it("lets the first press post the form and shows 「確認しています…」 with a spinner at once", async () => {
    const { view, press, button } = setup();
    expect(press()).toBe(false);
    await Promise.resolve();
    expect(view.text()).toBe("確認しています…");
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

  it("says other words with the same press", async () => {
    const { view, press } = setup({ label: "再設定する", pendingLabel: "開いています…" });
    expect(view.text()).toBe("再設定する");
    expect(press()).toBe(false);
    await Promise.resolve();
    expect(view.text()).toBe("開いています…");
    expect(press()).toBe(true);
  });

  it("is a client component without `disabled`, and the page has no button of its own", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/auth/continue/continue-button.tsx"), "utf8");
    expect(source.startsWith('"use client";')).toBe(true);
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

describe("/auth/continue by the link's type", () => {
  it.each(["email", "signup", "magiclink"])("asks to confirm the address for type=%s, posting only the token and its type", async (type) => {
    const html = await page({ token_hash: TOKEN, type, next: "/app/calendar?m=2026-11" });
    expect(html).toContain("メールアドレスを確認しますか？</h1>");
    expect(forms(html)).toEqual([["/auth/confirm", "post"]]);
    // The next is not carried: /auth/confirm never reads it.
    expect(hidden(html)).toEqual({ token_hash: TOKEN, type });
    expect(buttons(html)).toEqual(["確認する"]);
  });

  it("does not look at this browser's session for a confirmation (it is left as it is)", async () => {
    session.user = { email: "someone@example.com" };
    const html = await page({ token_hash: TOKEN, type: "email" });
    expect(html).not.toContain("someone@example.com");
    expect(html).not.toContain("ログアウト");
    expect(session.asked).toBe(0);
  });

  it("asks to reset the password for type=recovery", async () => {
    const html = await page({ token_hash: TOKEN, type: "recovery" });
    expect(html).toContain("パスワードを再設定しますか？</h1>");
    expect(hidden(html)).toEqual({ token_hash: TOKEN, type: "recovery" });
    expect(buttons(html)).toEqual(["再設定する"]);
    expect(html).not.toContain("ログアウトします");
  });

  it("says which address leaves when another account is signed in here", async () => {
    session.user = { email: "someone@example.com" };
    expect(await page({ token_hash: TOKEN, type: "recovery" })).toContain("ログイン中の someone@example.com からログアウトします。");
    session.user = {};
    expect(await page({ token_hash: TOKEN, type: "recovery" })).toContain("ログイン中のアカウントからログアウトします。");
  });

  it("asks to reset as before when the session cannot be read (and says nothing about it)", async () => {
    session.fails = true;
    const html = await page({ token_hash: TOKEN, type: "recovery" });
    expect(buttons(html)).toEqual(["再設定する"]);
    expect(html).not.toContain("ログアウトします");
  });

  it.each([
    ["no token", { type: "email" }],
    ["no type", { token_hash: TOKEN }],
    ["a type /auth/confirm does not take", { token_hash: TOKEN, type: "email_change" }],
  ])("says the link is incomplete for %s, with no form", async (_what, params) => {
    const html = await page(params);
    expect(html).toContain("リンクが不完全です。");
    expect(links(html)).toEqual([["/login", "ログイン"]]);
    expect(html).not.toContain("<form");
  });

  it("takes the first of a value written twice", async () => {
    const html = await page({ token_hash: [TOKEN, "other"], type: ["email", "recovery"] });
    expect(hidden(html)).toEqual({ token_hash: TOKEN, type: "email" });
  });
});

describe("[R3-23, R3-28, R3-35] no switch and no refusal from the URL", () => {
  it("a URL made with someone's token, link=refused and intent shows no refusal, no switch and no sign-out", async () => {
    for (const user of [null, { email: "someone@example.com" }]) {
      session.user = user;
      for (const type of ["email", "recovery"]) {
        const html = await page({ token_hash: TOKEN, type, link: "refused", intent: "switch_account", next: "/auth/continue?link=refused" });
        expect(html).not.toContain("このリンクは使えませんでした");
        expect(html).not.toContain("別のアカウント");
        expect(buttons(html)).toHaveLength(1);
        expect(forms(html)).toEqual([["/auth/confirm", "post"]]);
        expect(hidden(html)).toEqual({ token_hash: TOKEN, type });
      }
    }
  });

  it("negative control: the checks see a refusal and a switch where there is one", () => {
    const made = '<p>このリンクは使えませんでした。</p><form action="/auth/confirm" method="post"><input type="hidden" name="intent" value="switch_account"/><button>別のアカウントでログインする</button></form><form action="/auth/signout" method="post"><button>ログアウト</button></form>';
    expect(made).toContain("このリンクは使えませんでした");
    expect(buttons(made)).toHaveLength(2);
    expect(hidden(made)).toEqual({ intent: "switch_account" });
  });
});
