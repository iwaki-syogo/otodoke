import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, describeQuery, type Query } from "./fake-db";
import { findAll, hasClasses, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * /app/settings lists every dropped mail, not the newest 30.
 *
 * The heading 「荷物のメールが混ざっていないか、N 通を見る」 reads as the whole count, and each row
 * carries 「これは荷物」. A capped read cut the list and the count at 30, so a parcel mail past the
 * 30th could never be marked. The list is read with readAll, newest first; any page failing shows
 * 「読み込めませんでした」, never a shorter list.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const LOAD_FAILED = "読み込めませんでした";

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
  forgetSender: vi.fn(),
  clearAllParcels: vi.fn(),
}));

const fail = { data: null, error: { message: "boom" }, count: null };

const failureBoxes = (root: HtmlNode) =>
  findAll(root, (n) => n.tag === "p" && textOf(n) === LOAD_FAILED && hasClasses(n, "rounded-2xl", "border-red-200", "bg-red-50", "text-red-900"));

const droppedSection = (root: HtmlNode) => {
  const found = findAll(root, (n) => n.tag === "section");
  expect(found).toHaveLength(1);
  return found[0];
};

const rowsOf = (section: HtmlNode) => findAll(section, (n) => n.tag === "li");
const markButtons = (section: HtmlNode) => findAll(section, (n) => n.tag === "button" && textOf(n) === "これは荷物");
const summaryOf = (section: HtmlNode) => findAll(section, (n) => n.tag === "summary").map(textOf);

const listReads = (db: FakeDb) => db.callsOn("screen_events", "select").filter((q: Query) => !q.head);

const BASE = Date.UTC(2026, 9, 20, 0, 0, 0);
const subjectOf = (i: number) => `お知らせ${String(i).padStart(5, "0")}`;

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [], emails: [], screen_events: [] });
  mocks.state.db = db;
});

/** n dropped mails, one minute apart: mail i was dropped at BASE + i minutes, so the last is newest. */
const seed = (n: number) => {
  for (let i = 0; i < n; i++) {
    db.rows("screen_events").push({
      id: `se-${String(i).padStart(5, "0")}`,
      user_id: USER,
      decision: "dropped",
      subject: subjectOf(i),
      from_domain: "example.com",
      created_at: new Date(BASE + i * 60_000).toISOString(),
      flagged_at: null,
    });
  }
  // A mail that was kept is not a dropped one.
  db.rows("screen_events").push({ id: "se-kept", user_id: USER, decision: "kept", subject: "発送のお知らせ", from_domain: "shop.example", created_at: new Date(BASE).toISOString(), flagged_at: null });
};

const render = async () => {
  const Page = (await import("@/app/app/settings/dropped/page")).default;
  return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));
};

describe("/app/settings: 読まなかったメール lists every dropped mail", () => {
  it("lists and counts 1,001 dropped mails, each with 「これは荷物」, newest first", async () => {
    seed(1001);
    const section = droppedSection(await render());
    expect(summaryOf(section)).toEqual(["荷物のメールが混ざっていないか、1001 通を見る"]);
    const rows = rowsOf(section);
    expect(rows).toHaveLength(1001);
    expect(markButtons(section)).toHaveLength(1001);
    // Newest first, all the way down.
    expect(rows.map((r) => findAll(r, (n) => n.tag === "p")[0]).map(textOf)).toEqual(Array.from({ length: 1001 }, (_, k) => subjectOf(1000 - k)));
    expect(textOf(section)).not.toContain("発送のお知らせ");
    expect(failureBoxes(section)).toHaveLength(0);
    // Paged by range, only dropped mail, newest first with id as the tie-break.
    const reads = listReads(db);
    expect(reads.map((q) => q.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    for (const q of reads) {
      expect(q.filters.some((f) => f.method === "eq" && f.args[0] === "decision" && f.args[1] === "dropped"), describeQuery(q)).toBe(true);
      expect(q.orders.map((o) => [o.column, o.ascending])).toEqual([
        ["created_at", false],
        ["id", true],
      ]);
      expect(q.limit, describeQuery(q)).toBeNull();
    }
  });

  it("lists 31 dropped mails, past the old 30 cap, in one read", async () => {
    seed(31);
    const section = droppedSection(await render());
    expect(summaryOf(section)).toEqual(["荷物のメールが混ざっていないか、31 通を見る"]);
    expect(rowsOf(section)).toHaveLength(31);
    expect(markButtons(section)).toHaveLength(31);
    expect(textOf(section)).toContain(subjectOf(0));
    expect(listReads(db)).toHaveLength(1);
  });

  it("shows 「読み込めませんでした」, not a shorter list, when the second page fails", async () => {
    seed(1001);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "screen_events" && !q.head && q.range?.[0] === 1000 ? fail : undefined));
    const section = droppedSection(await render());
    expect(failureBoxes(section)).toHaveLength(1);
    expect(rowsOf(section)).toHaveLength(0);
    expect(summaryOf(section)).toEqual([]);
    expect(textOf(section)).not.toContain("まだありません");
    // The second page was asked for and failed.
    expect(listReads(db).some((q) => q.range?.[0] === 1000)).toBe(true);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
