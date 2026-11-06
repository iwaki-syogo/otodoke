import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { CONFIRMED_LOGIN_PATH, SIGNUP_CONFIRMED_PATH, WELCOME_PATH, landingAfterSignIn } from "@/lib/onboarding";
import { safeNextPath } from "@/lib/safe-next";
import { findAll, parseHtml, textOf } from "./html-tree";
import { withoutComments } from "./source-scan";

/**
 * Onboarding screen 2, /auth/confirmed (where POST /auth/confirm sends a sign-up's confirmation:
 * auth-confirm-types.test.ts), and the way from it to screen 3: 「この画面でログインする」 opens the
 * login with its `confirmed` words and a next of /app/welcome. It reads nothing, so it works in any
 * browser. And the rule for screen 3: the sign-in that made the first key.
 */

vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/app/login/actions", () => ({ signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn() }));

const ConfirmedPage = (await import("@/app/auth/confirmed/page")).default;
const LoginPage = (await import("@/app/login/page")).default;

describe("/auth/confirmed (screen 2)", () => {
  it("is where a sign-up's confirmation goes", () => {
    expect(SIGNUP_CONFIRMED_PATH).toBe("/auth/confirmed");
  });

  it("has the wording file's words and one white button to the login", () => {
    const root = parseHtml(renderToStaticMarkup(ConfirmedPage()));
    expect(findAll(root, (n) => n.tag === "h1").map(textOf)).toEqual(["確認できました"]);
    expect(findAll(root, (n) => n.tag === "p").map(textOf)).toEqual(["登録した画面に戻ると、自動で次へ進みます。"]);
    const links = findAll(root, (n) => n.tag === "a");
    expect(links.map((a) => [a.attrs.href, textOf(a)])).toEqual([[CONFIRMED_LOGIN_PATH, "この画面でログインする"]]);
    const look = (links[0].attrs.class ?? "").split(/\s+/);
    expect(look).toEqual(expect.arrayContaining(["w-full", "bg-white", "border-neutral-300", "rounded-xl", "py-4"]));
    expect(renderToStaticMarkup(ConfirmedPage())).not.toMatch(/shadow|gradient|転送するだけ/);
  });

  it("reads nothing (prerendered), so the link works in another browser than the one that signed up", () => {
    const source = withoutComments(readFileSync(path.join(process.cwd(), "src/app/auth/confirmed/page.tsx"), "utf8"));
    expect(source).toMatch(/^export const dynamic = "force-static";$/m);
    expect(source).not.toMatch(/supabase|cookies|headers|searchParams/);
  });

  it("「この画面でログインする」: the login's `confirmed` words, and after the login the first-run guide", async () => {
    const url = new URL(CONFIRMED_LOGIN_PATH, "https://otodoke.example");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("confirmed")).toBe("1");
    expect(safeNextPath(url.searchParams.get("next"))).toBe(WELCOME_PATH);

    const page = await LoginPage({ searchParams: Promise.resolve({ confirmed: "1", next: url.searchParams.get("next")! }) });
    const text = textOf(parseHtml(renderToStaticMarkup(page)));
    expect(text).toContain(LOGIN_MESSAGES.confirmed);
    expect(LOGIN_MESSAGES.confirmed).toBe("メールアドレスを確認しました。パスワードでログインしてください。");
    // The login form is handed the guide as its next.
    const form = (page as ReactElement<{ children: unknown[] }>).props.children.flat().find((c) => isValidElement(c) && typeof (c.props as { next?: unknown }).next === "string") as ReactElement<{ next: string }>;
    expect(form.props.next).toBe(WELCOME_PATH);
  });
});

describe("when screen 3 is shown", () => {
  it("after the sign-in that made the first key, whatever the next; otherwise the next", () => {
    expect(landingAfterSignIn("made", "/app")).toBe(WELCOME_PATH);
    expect(landingAfterSignIn("made", "/app/calendar")).toBe(WELCOME_PATH);
    expect(landingAfterSignIn("opened", "/app")).toBe("/app");
    expect(landingAfterSignIn("opened", "/app/calendar?month=2026-11")).toBe("/app/calendar?month=2026-11");
  });

  it("/app/welcome is a path the login may go on to", () => {
    expect(safeNextPath(WELCOME_PATH)).toBe(WELCOME_PATH);
  });
});
