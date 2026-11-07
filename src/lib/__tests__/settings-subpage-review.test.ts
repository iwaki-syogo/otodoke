import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../../next.config";
import { safeNextPath } from "@/lib/safe-next";
import { FakeDb } from "./fake-db";
import { findAll, hasClasses, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * Review fixes for the 設定 sub-pages: the demo fixtures are traced for the page that runs the demo
 * loader, long actions get a long function limit, "ログイン中" stays beside the private things, the
 * list's loading screen wraps only the list, a stale session returns to the password page, and a
 * failed old-key count is not shown as none.
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
  usePathname: () => "/app/settings",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "abcdefghjk", inboxEmail: () => "abcdefghjk@in.example.test" }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => Object.assign(mocks.state.db as FakeDb, { auth: { getUser: async () => ({ data: { user: { id: USER } }, error: null }) } }),
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
vi.mock("@/app/app/settings/actions", () => ({ loadDemo: vi.fn(), readWaitingMail: vi.fn(), markWronglyDropped: vi.fn(), forgetSender: vi.fn(), clearAllParcels: vi.fn() }));
vi.mock("@/app/app/settings/key-actions", () => ({ readMailKey: vi.fn(), registerMailKey: vi.fn(), activateMailKey: vi.fn(), rewrapMailKey: vi.fn(), sealStoredMail: vi.fn(), readSealedMail: vi.fn() }));
vi.mock("@/app/app/settings/password-actions", () => ({ changeLoginSecret: vi.fn() }));
vi.mock("@/app/login/actions", () => ({ signInWithAuthSecret: vi.fn() }));
vi.mock("@/app/login/session-actions", () => ({ readSignedInAddress: vi.fn() }));
vi.mock("@/app/login/turnstile-widget", () => ({ TurnstileWidget: () => null }));
vi.mock("@/app/login/other-password-form", () => ({ OtherPasswordForm: () => null }));

const settingsDir = path.resolve(__dirname, "../../app/app/settings");
const read = (file: string) => readFileSync(path.join(settingsDir, file), "utf8");

const LOGGED_IN = `ログイン中: qa@example.com`;

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  db.hooks.push((q) => (q.table === "emails" && q.filters.some((f) => f.method === "or") ? { data: null, error: null, count: 0 } : undefined));
  mocks.state.db = db;
});

const activeKey = () =>
  db.rows("user_keys").push({ user_id: USER, key_id: "a".repeat(32), public_key: "x", wrapped_private_key: "x", wrap_iv: "x", kdf_salt: "x", kdf_iterations: 600000, challenge_hash: "0".repeat(64), created_at: "2026-11-06T00:00:00Z", activated_at: "2026-11-06T00:00:00Z", retired_at: null });

describe("the demo fixtures are traced for the page that renders the DemoLoader", () => {
  it("/app/settings/demo renders the DemoLoader and is a key of outputFileTracingIncludes with the fixtures", () => {
    expect(read("demo/page.tsx")).toContain("<DemoLoader");
    const includes = nextConfig.outputFileTracingIncludes ?? {};
    expect(includes["/app/settings/demo"]).toContain("./fixtures/demo/**/*.json");
    // The made-up order history the sample loads with them (src/lib/demo.ts).
    expect(includes["/app/settings/demo"]).toContain("./fixtures/demo-history/**/*.json");
    // The list page does not read fixtures: only the demo page holds them.
    expect(Object.keys(includes)).toEqual(["/app/settings/demo"]);
  });

  it("every key names a route that exists", () => {
    for (const key of Object.keys(nextConfig.outputFileTracingIncludes ?? {})) {
      const dir = path.join(settingsDir, "../..", key);
      expect(existsSync(path.join(dir, "page.tsx")) || existsSync(path.join(dir, "(list)/page.tsx")), key).toBe(true);
    }
  });
});

describe("long actions", () => {
  it("trouble (readWaitingMail reads up to 20 mails with Claude) has a long maxDuration, like demo", () => {
    expect(read("trouble/page.tsx")).toMatch(/export const maxDuration = 300;/);
    expect(read("demo/page.tsx")).toMatch(/export const maxDuration = 300;/);
  });

  it("dropped posts only quick database writes: no long limit is needed", () => {
    expect(read("dropped/page.tsx")).not.toContain("maxDuration");
  });
});

describe("「ログイン中: …」 stays beside the address and the password", () => {
  const exactLine = (root: HtmlNode) => findAll(root, (n) => n.tag === "p" && textOf(n) === LOGGED_IN && hasClasses(n, "text-xs", "text-neutral-500"));

  it("the forwarding page shows it near the address", async () => {
    activeKey();
    const Page = (await import("@/app/app/settings/forwarding/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Page()));
    expect(textOf(root)).toContain("abcdefghjk@in.example.test");
    expect(exactLine(root)).toHaveLength(1);
    const spans = findAll(root, (n) => n.tag === "span" && textOf(n) === "qa@example.com" && hasClasses(n, "break-all", "font-medium", "text-neutral-700"));
    expect(spans).toHaveLength(1);
  });

  it("the password page shows it under the panel", async () => {
    activeKey();
    const Page = (await import("@/app/app/settings/password/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Page()));
    expect(exactLine(root)).toHaveLength(1);
  });
});

describe("the list's loading screen wraps only the list", () => {
  it("page.tsx and loading.tsx of the list live in the (list) route group, not beside the sub-pages", () => {
    expect(existsSync(path.join(settingsDir, "(list)/page.tsx"))).toBe(true);
    expect(existsSync(path.join(settingsDir, "(list)/loading.tsx"))).toBe(true);
    expect(existsSync(path.join(settingsDir, "page.tsx"))).toBe(false);
    expect(existsSync(path.join(settingsDir, "loading.tsx"))).toBe(false);
  });
});

describe("a stale session on the password panel comes back to the password page", () => {
  it("the login link says next=/app/settings/password, which safe-next accepts", () => {
    const source = read("password-panel.tsx");
    expect(source).toContain('href="/login?next=%2Fapp%2Fsettings%2Fpassword"');
    expect(source).not.toMatch(/next=%2Fapp%2Fsettings"/);
    expect(safeNextPath("/app/settings/password")).toBe("/app/settings/password");
    expect(safeNextPath(decodeURIComponent("%2Fapp%2Fsettings%2Fpassword"))).toBe("/app/settings/password");
  });
});

describe("the old-key count on the password page", () => {
  const render = async () => {
    const Page = (await import("@/app/app/settings/password/page")).default;
    return parseHtml(renderToStaticMarkup(await Page()));
  };
  const boxes = (root: HtmlNode) => findAll(root, (n) => n.tag === "p" && textOf(n) === "前の鍵のメールの数を読み込めませんでした");

  it("a failed count says it could not be read instead of looking like none", async () => {
    activeKey();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "emails" && q.head && q.filters.some((f) => f.method === "neq") ? { data: null, error: { message: "boom" }, count: null } : undefined));
    expect(boxes(await render())).toHaveLength(1);
    log.mockRestore();
  });

  it("a count that worked shows no failure", async () => {
    activeKey();
    expect(boxes(await render())).toHaveLength(0);
  });
});
