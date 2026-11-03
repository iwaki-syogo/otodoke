import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { todayJst } from "@/lib/format";
import { FakeDb, describeQuery, type Query } from "./fake-db";
import { findAll, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [SEC-N1] Every read of parcels on the list and on /app/cancelled also asks for the signed-in
 * user's rows (user_id = the session's id), on top of row-level security. FakeDb has no RLS, so
 * another user's rows show up here unless the page asks for user_id itself.
 * [N1] The list sends its four reads together; each one failing alone touches only its own part.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";

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

const TODAY = todayJst();
const day = (n: number) => {
  const d = new Date(`${TODAY}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let seq = 0;
const parcel = (over: Record<string, unknown>) => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  user_id: USER,
  shop: "テスト店",
  title: `品名${seq}`,
  status: "shipped",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [], emails: [] });
  mocks.state.db = db;
});

async function renderList() {
  const Page = (await import("@/app/app/page")).default;
  return parseHtml(renderToStaticMarkup(await Page()));
}

async function renderCancelled() {
  const Page = (await import("@/app/app/cancelled/page")).default;
  return parseHtml(renderToStaticMarkup(await Page()));
}

const one = (root: HtmlNode, href: string) => {
  const links = linksTo(root, href);
  expect(links, href).toHaveLength(1);
  return links[0];
};

const askedForUser = (q: Query) => q.filters.some((f) => f.method === "eq" && f.args[0] === "user_id" && f.args[1] === USER);
const isCount = (status: string) => (q: Query) =>
  q.table === "parcels" && q.head && q.filters.some((f) => f.method === "eq" && f.args[0] === "status" && f.args[1] === status);
const fail = { data: null, error: { message: "boom" }, count: null };

describe("[SEC-N1] the list reads only the user's parcels", () => {
  it("adds user_id = the session's id to every parcels read, the counts included", async () => {
    db = new FakeDb({ parcels: [parcel({ expected_date: day(1) })], emails: [] });
    mocks.state.db = db;
    await renderList();
    const reads = db.callsOn("parcels", "select");
    expect(reads.length).toBe(3);
    for (const q of reads) expect(askedForUser(q), describeQuery(q)).toBe(true);
  });

  it("neither lists nor counts another user's parcels", async () => {
    const mine = parcel({ status: "shipped", expected_date: day(1), title: "自分の品" });
    const theirs = parcel({ user_id: OTHER, status: "shipped", expected_date: day(1), title: "他人の品" });
    db = new FakeDb({
      parcels: [mine, theirs, parcel({ status: "delivered" }), parcel({ user_id: OTHER, status: "delivered" }), parcel({ user_id: OTHER, status: "cancelled" })],
      emails: [],
    });
    mocks.state.db = db;
    const root = await renderList();
    expect(linksTo(root, `/app/parcels/${mine.id}`)).toHaveLength(1);
    expect(linksTo(root, `/app/parcels/${theirs.id}`)).toHaveLength(0);
    expect(textOf(root)).not.toContain("他人の品");
    expect(textOf(one(root, "/app/delivered"))).toMatch(/1\s*件/);
    expect(textOf(one(root, "/app/cancelled"))).toMatch(/0\s*件/);
  });
});

describe("[SEC-N1] /app/cancelled reads only the user's parcels", () => {
  it("adds user_id = the session's id to every read", async () => {
    db = new FakeDb({ parcels: [parcel({ status: "cancelled", ordered_at: "2026-10-01" })] });
    mocks.state.db = db;
    await renderCancelled();
    const reads = db.callsOn("parcels", "select");
    expect(reads.length).toBeGreaterThan(0);
    for (const q of reads) expect(askedForUser(q), describeQuery(q)).toBe(true);
  });

  it("does not list another user's cancelled parcel", async () => {
    const mine = parcel({ status: "cancelled", ordered_at: "2026-10-01" });
    const theirs = parcel({ user_id: OTHER, status: "cancelled", ordered_at: "2026-10-02" });
    db = new FakeDb({ parcels: [mine, theirs] });
    mocks.state.db = db;
    const root = await renderCancelled();
    expect(linksTo(root, `/app/parcels/${mine.id}`)).toHaveLength(1);
    expect(linksTo(root, `/app/parcels/${theirs.id}`)).toHaveLength(0);
    expect(textOf(findAll(root, (n) => n.tag === "h1")[0])).toMatch(/^キャンセルした荷物\s*1$/);
  });
});

describe("[N1] each of the list's reads failing alone", () => {
  const seed = () => {
    const open = parcel({ status: "shipped", expected_date: day(1) });
    db = new FakeDb({
      parcels: [open, parcel({ status: "delivered" }), parcel({ status: "delivered" }), parcel({ status: "cancelled" })],
      emails: [{ id: "00000000-0000-4000-8000-0000000000e1", user_id: USER, processing_status: "failed" }],
    });
    mocks.state.db = db;
    return open;
  };

  it("the unread-mail count: no notice, the list and both counts stay", async () => {
    const open = seed();
    db.hooks.push((q) => (q.table === "emails" ? fail : undefined));
    const root = await renderList();
    expect(textOf(root)).not.toContain("まだ読んでいないメール");
    expect(linksTo(root, `/app/parcels/${open.id}`)).toHaveLength(1);
    expect(textOf(one(root, "/app/delivered"))).toMatch(/2\s*件/);
    expect(textOf(one(root, "/app/cancelled"))).toMatch(/1\s*件/);
  });

  it("the delivered count: that link shows no count, the rest stays", async () => {
    const open = seed();
    db.hooks.push((q) => (isCount("delivered")(q) ? fail : undefined));
    const root = await renderList();
    const delivered = one(root, "/app/delivered");
    expect(textOf(delivered)).toContain("届いた荷物");
    expect(textOf(delivered)).not.toContain("件");
    expect(textOf(one(root, "/app/cancelled"))).toMatch(/1\s*件/);
    expect(linksTo(root, `/app/parcels/${open.id}`)).toHaveLength(1);
    expect(textOf(root)).toContain("まだ読んでいないメール");
  });

  it("the cancelled count: that link shows no count, the rest stays", async () => {
    const open = seed();
    db.hooks.push((q) => (isCount("cancelled")(q) ? fail : undefined));
    const root = await renderList();
    const cancelled = one(root, "/app/cancelled");
    expect(textOf(cancelled)).toContain("キャンセルした荷物");
    expect(textOf(cancelled)).not.toContain("件");
    expect(textOf(one(root, "/app/delivered"))).toMatch(/2\s*件/);
    expect(linksTo(root, `/app/parcels/${open.id}`)).toHaveLength(1);
    expect(textOf(root)).toContain("まだ読んでいないメール");
  });

  it("the list itself: both counts and the unread notice stay", async () => {
    seed();
    db.hooks.push((q) => (q.table === "parcels" && !q.head ? fail : undefined));
    const root = await renderList();
    expect(textOf(one(root, "/app/delivered"))).toMatch(/2\s*件/);
    expect(textOf(one(root, "/app/cancelled"))).toMatch(/1\s*件/);
    expect(textOf(root)).toContain("まだ読んでいないメール");
  });
});
