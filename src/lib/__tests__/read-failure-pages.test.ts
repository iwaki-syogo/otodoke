import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { todayJst } from "@/lib/format";
import { FakeDb, type Query } from "./fake-db";
import { findAll, hasClasses, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * A read that fails is told apart from a read that found nothing.
 *
 * On /app, the parcel page and /app/settings, a failed read shows 「読み込めませんでした」 in the
 * same red box as /app/delivered and /app/cancelled, and never the empty-state wording
 * (「まだ荷物がありません」, 「元メールがありません」, 「まだありません」). Whether a read worked is
 * decided by its error, not by the value it left behind. A read that works and finds nothing still
 * shows the empty state, as before.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const PARCEL = "11111111-1111-4111-8111-111111111111";
const EMAIL = "22222222-2222-4222-8222-222222222222";
const LOAD_FAILED = "読み込めませんでした";

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
  getUser: async () => ({ id: USER, email: "qa@example.com" }),
}));
// The settings page's address and actions are not what is under test here.
vi.mock("@/lib/inbox", () => ({ ensureInboxAddress: async () => "testbox", inboxEmail: () => null }));
vi.mock("@/app/app/settings/actions", () => ({
  loadDemo: vi.fn(),
  readWaitingMail: vi.fn(),
  markWronglyDropped: vi.fn(),
  clearAllParcels: vi.fn(),
}));

const fail = { data: null, error: { message: "boom" }, count: null };
const failOn = (pred: (q: Query) => boolean) => db.hooks.push((q) => (pred(q) ? fail : undefined));

const day = (n: number) => {
  const d = new Date(`${todayJst()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** The red box /app/delivered and /app/cancelled show when their read fails. */
const failureBoxes = (root: HtmlNode) =>
  findAll(root, (n) => n.tag === "p" && textOf(n) === LOAD_FAILED && hasClasses(n, "rounded-2xl", "border-red-200", "bg-red-50", "text-red-900"));

/** The <section> whose heading reads `title`. */
const sectionTitled = (root: HtmlNode, title: string) => {
  const found = findAll(root, (n) => n.tag === "section" && findAll(n, (h) => h.tag === "h2" && textOf(h).startsWith(title)).length > 0);
  return found;
};

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [], emails: [], parcel_items: [], extractions: [], screen_events: [] });
  mocks.state.db = db;
});

describe("/app: the parcels read", () => {
  const render = async () => {
    const Page = (await import("@/app/app/page")).default;
    return parseHtml(renderToStaticMarkup(await Page()));
  };

  it("failing shows 「読み込めませんでした」, not 「まだ荷物がありません」", async () => {
    db.rows("parcels").push({ id: PARCEL, user_id: USER, shop: "テスト店", title: "品名", status: "shipped", expected_date: day(1) });
    failOn((q) => q.table === "parcels" && !q.head);
    const root = await render();
    expect(failureBoxes(root)).toHaveLength(1);
    expect(textOf(root)).not.toContain("まだ荷物がありません");
    expect(textOf(root)).not.toContain("サンプルで試す");
    // What did load stays: the way to add one and the other pages.
    expect(linksTo(root, "/app/parcels/new")).toHaveLength(1);
    expect(linksTo(root, "/app/delivered")).toHaveLength(1);
    expect(linksTo(root, "/app/cancelled")).toHaveLength(1);
  });

  it("working with no parcels shows the empty state and no failure", async () => {
    const root = await render();
    expect(textOf(root)).toContain("まだ荷物がありません");
    expect(textOf(root)).not.toContain(LOAD_FAILED);
  });
});

describe("parcel page", () => {
  const seed = () => {
    db.rows("parcels").push({ id: PARCEL, user_id: USER, shop: "テスト店", title: "テスト用の品名", status: "shipped", source: "mail" });
  };
  const withMail = () => {
    db.rows("emails").push({ id: EMAIL, user_id: USER, subject: "発送のお知らせ", from_address: "shop@example.com", sent_at: "2026-11-01T00:00:00Z", classification: "shipping" });
    db.rows("extractions").push({ id: "33333333-3333-4333-8333-333333333333", user_id: USER, parcel_id: PARCEL, email_id: EMAIL, confidence: 0.9, result: {}, created_at: "2026-11-01T00:00:00Z" });
  };
  const withItem = () => {
    db.rows("parcel_items").push({ id: "44444444-4444-4444-8444-444444444444", user_id: USER, parcel_id: PARCEL, name: "テスト品", quantity: 1, unit_price: null, created_at: "2026-11-01T00:00:00Z" });
  };
  const render = async () => {
    const Page = (await import("@/app/app/parcels/[id]/page")).default;
    return parseHtml(renderToStaticMarkup(await Page({ params: Promise.resolve({ id: PARCEL }) })));
  };

  it("the parcel read failing shows 「読み込めませんでした」 instead of not found", async () => {
    seed();
    failOn((q) => q.table === "parcels");
    const root = await render();
    expect(failureBoxes(root)).toHaveLength(1);
    expect(linksTo(root, "/app")).toHaveLength(1);
  });

  it("a parcel that is not there is still not found", async () => {
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("a malformed id is still not found (Postgres would answer it with an error)", async () => {
    seed();
    // Like Postgres: invalid input syntax for type uuid.
    failOn((q) => q.filters.some((f) => f.args[0] === "id" && f.args[1] === "not-a-uuid"));
    const Page = (await import("@/app/app/parcels/[id]/page")).default;
    await expect(Page({ params: Promise.resolve({ id: "not-a-uuid" }) })).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("the mail read failing shows 「読み込めませんでした」 under メールの履歴, not 「元メールがありません」", async () => {
    seed();
    withMail();
    failOn((q) => q.table === "extractions");
    const root = await render();
    const history = sectionTitled(root, "メールの履歴");
    expect(history).toHaveLength(1);
    expect(failureBoxes(history[0])).toHaveLength(1);
    expect(textOf(root)).not.toContain("元メールがありません");
    // The parcel itself still shows.
    expect(textOf(root)).toContain("テスト用の品名");
  });

  it("no mail, read fine, still says 「元メールがありません」", async () => {
    seed();
    const root = await render();
    expect(textOf(sectionTitled(root, "メールの履歴")[0])).toContain("元メールがありません");
    expect(textOf(root)).not.toContain(LOAD_FAILED);
  });

  it("the items read failing shows 「読み込めませんでした」 under 内容", async () => {
    seed();
    withItem();
    failOn((q) => q.table === "parcel_items");
    const root = await render();
    const items = sectionTitled(root, "内容");
    expect(items).toHaveLength(1);
    expect(failureBoxes(items[0])).toHaveLength(1);
    expect(textOf(root)).toContain("テスト用の品名");
  });

  it("no items, read fine, shows no 内容 section and no failure", async () => {
    seed();
    const root = await render();
    expect(sectionTitled(root, "内容")).toHaveLength(0);
    expect(textOf(root)).not.toContain(LOAD_FAILED);
  });

  it("items and mail read fine are listed", async () => {
    seed();
    withItem();
    withMail();
    const root = await render();
    expect(textOf(sectionTitled(root, "内容")[0])).toContain("テスト品");
    expect(textOf(sectionTitled(root, "メールの履歴")[0])).toContain("発送のお知らせ");
    expect(textOf(root)).not.toContain(LOAD_FAILED);
  });
});

describe("/app/settings: the dropped-mail read", () => {
  const render = async () => {
    const Page = (await import("@/app/app/settings/page")).default;
    return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));
  };

  it("failing shows 「読み込めませんでした」 under 読まなかったメール, not 「まだありません」", async () => {
    db.rows("screen_events").push({ id: "55555555-5555-4555-8555-555555555555", user_id: USER, decision: "dropped", subject: "セールのお知らせ", from_domain: "example.com", created_at: "2026-11-01T00:00:00Z", flagged_at: null });
    failOn((q) => q.table === "screen_events");
    const root = await render();
    const dropped = sectionTitled(root, "読まなかったメール");
    expect(dropped).toHaveLength(1);
    expect(failureBoxes(dropped[0])).toHaveLength(1);
    expect(textOf(dropped[0])).not.toContain("まだありません");
  });

  it("none, read fine, still says 「まだありません」", async () => {
    const root = await render();
    const dropped = sectionTitled(root, "読まなかったメール");
    expect(textOf(dropped[0])).toContain("まだありません");
    expect(textOf(root)).not.toContain(LOAD_FAILED);
  });

  it("some, read fine, are listed", async () => {
    db.rows("screen_events").push({ id: "55555555-5555-4555-8555-555555555555", user_id: USER, decision: "dropped", subject: "セールのお知らせ", from_domain: "example.com", created_at: "2026-11-01T00:00:00Z", flagged_at: null });
    const root = await render();
    expect(textOf(sectionTitled(root, "読まなかったメール")[0])).toContain("セールのお知らせ");
    expect(textOf(root)).not.toContain(LOAD_FAILED);
  });
});
