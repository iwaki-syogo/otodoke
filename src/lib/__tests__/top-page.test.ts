import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findAll, parseHtml, textOf } from "./html-tree";

/**
 * The top page (src/app/page.tsx) with password-v1: signed out, the main button makes an account
 * (/signup: the address and a password), and the header's 「ログイン」 signs in; signed in, both go
 * to the parcels. README names 「アカウントを作る」 for the top page and /login.
 */

const session = vi.hoisted(() => ({ user: null as { id: string; email: string } | null }));

// next/font only works inside the Next.js compiler.
vi.mock("@/components/wordmark", () => ({ Wordmark: () => "Otodoke" }));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => session.user }));

const Home = (await import("@/app/page")).default;

const links = async () => findAll(parseHtml(renderToStaticMarkup(await Home())), (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()]);

beforeEach(() => {
  session.user = null;
});

describe("the top page", () => {
  it("signed out: 「アカウントを作る」 goes to /signup, and the header's 「ログイン」 to /login", async () => {
    const all = await links();
    expect(all).toContainEqual(["/signup", "アカウントを作る"]);
    expect(all).toContainEqual(["/login", "ログイン"]);
    expect(all.filter(([href]) => href === "/signup" || href === "/login")).toHaveLength(2);
    expect(JSON.stringify(all)).not.toContain("メールアドレスで始める");
  });

  it("signed in: both go to the parcels", async () => {
    session.user = { id: "00000000-0000-4000-8000-00000000000a", email: "qa@example.com" };
    const all = await links();
    expect(all.filter(([href]) => href === "/app")).toEqual([
      ["/app", "荷物を見る"],
      ["/app", "荷物を見る"],
    ]);
    expect(all.map(([href]) => href)).not.toContain("/signup");
  });
});
