import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "./fake-db";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Review 2026-11-06 D2-3 / E-14] The empty list says what to do next as a question, and that
 * setting up is once: never that each order mail is sent to Otodoke (「〜に送ると、ここに並びます」).
 * The button goes to the settings as before, named for going there (「設定する」): it does not
 * promise the address at once (「転送先を見る」), since with encryption the settings ask for the
 * passphrase first. 「サンプルで試す」 still goes to the sample.
 */

const USER = "00000000-0000-4000-8000-00000000000a";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/app",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER }),
}));

beforeEach(() => {
  mocks.state.db = new FakeDb({ parcels: [], emails: [] });
});

async function renderEmpty() {
  const Page = (await import("@/app/app/page")).default;
  return parseHtml(renderToStaticMarkup(await Page()));
}

/** The block under 「まだ荷物がありません」. */
function emptyState(root: HtmlNode): HtmlNode {
  const heading = findAll(root, (n) => n.tag === "h2" && textOf(n) === "まだ荷物がありません");
  expect(heading).toHaveLength(1);
  return heading[0].parent!;
}

describe("the empty parcel list", () => {
  it("asks about setting up forwarding and says it is once", async () => {
    const block = emptyState(await renderEmpty());
    const guide = findAll(block, (n) => n.tag === "p" && textOf(n).includes("設定"));
    expect(guide.map((p) => textOf(p).trim())).toEqual(["メールの自動転送を設定しますか？設定は最初の 1 回だけです。"]);
  });

  it("never reads as sending each mail, nor promises the address at once", async () => {
    const text = textOf(emptyState(await renderEmpty()));
    for (const old of ["送ると", "転送用アドレス", "ここに並びます", "転送先を見る", "転送先を確認", "転送するだけ"]) expect(text).not.toContain(old);
  });

  it("goes to the settings with 「設定する」 and to the sample with 「サンプルで試す」, as before", async () => {
    const block = emptyState(await renderEmpty());
    expect(findAll(block, (n) => n.tag === "a").map((a) => [a.attrs.href, textOf(a).trim()])).toEqual([
      ["/app/settings", "設定する"],
      ["/app/settings#demo", "サンプルで試す"],
    ]);
    // Nothing else on the empty page leads to the settings.
    expect(linksTo(await renderEmpty(), "/app/settings")).toHaveLength(1);
  });
});

describe("the screens", () => {
  // The owner's rule (CLAUDE.md): 「転送するだけ」 reads as forwarding each mail by hand.
  const appDir = path.resolve(__dirname, "../../app");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : /\.tsx?$/.test(name) ? [full] : [];
    });

  it("never say 「転送するだけ」", () => {
    expect(files(appDir).length).toBeGreaterThan(0);
    for (const f of files(appDir)) expect(readFileSync(f, "utf8"), f).not.toContain("転送するだけ");
  });
});
