import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { shiftMonth, todayJst } from "@/lib/format";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb, describeQuery, type Query, type Row } from "./fake-db";
import { findAll, hasClasses, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";
import { USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Lists that are read as complete are read past PostgREST's 1000-row cap.
 *
 * /app sorts every open parcel into its sections and counts them, so a cut list would hide
 * parcels and give wrong counts with no sign of it. The pipeline picks the parcel a mail belongs
 * to from every parcel of the user: one past the cap would be missed and opened again. Each of
 * them reads with readAll; any page failing shows 「読み込めませんでした」 (or fails the mail), never a
 * shorter list.
 */

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

const fail = { data: null, error: { message: "boom" }, count: null };

const day = (n: number) => {
  const d = new Date(`${todayJst()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const failureBoxes = (root: HtmlNode) =>
  findAll(root, (n) => n.tag === "p" && textOf(n) === LOAD_FAILED && hasClasses(n, "rounded-2xl", "border-red-200", "bg-red-50", "text-red-900"));

const parcelLinks = (root: HtmlNode) => findAll(root, (n) => n.tag === "a" && /^\/app\/parcels\/p-/.test(n.attrs.href ?? ""));

const listReads = (db: FakeDb) => db.callsOn("parcels", "select").filter((q: Query) => !q.head);

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb({ parcels: [], emails: [] });
  mocks.state.db = db;
});

describe("/app reads every parcel", () => {
  const render = async () => {
    const Page = (await import("@/app/app/page")).default;
    return parseHtml(renderToStaticMarkup(await Page()));
  };
  /** n parcels on their way, due tomorrow: all of them belong in 「もうすぐ届く」. */
  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      db.rows("parcels").push({ id: `p-${String(i).padStart(5, "0")}`, user_id: USER, shop: "テスト店", title: `品名${i}`, status: "shipped", expected_date: day(1), created_at: "2026-11-01T00:00:00Z" });
    }
    db.rows("parcels").push({ id: "p-delivered", user_id: USER, shop: "テスト店", status: "delivered", created_at: "2026-11-01T00:00:00Z" });
  };

  it("lists and counts 1,001 parcels on their way, past the 1000-row cap", async () => {
    seed(1001);
    const root = await render();
    expect(parcelLinks(root)).toHaveLength(1001);
    const soon = findAll(root, (n) => n.tag === "h2" && textOf(n).startsWith("もうすぐ届く"));
    expect(soon.map(textOf)).toEqual(["もうすぐ届く1001"]);
    expect(failureBoxes(root)).toHaveLength(0);
    // Paged by range, still only the user's parcels, in the order the page asks for.
    const reads = listReads(db);
    expect(reads.map((q) => q.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    for (const q of reads) {
      expect(q.filters.some((f) => f.method === "eq" && f.args[0] === "user_id" && f.args[1] === USER), describeQuery(q)).toBe(true);
      expect(q.orders.map((o) => o.column)).toEqual(["expected_date", "last_email_at", "id"]);
    }
  });

  it("shows 「読み込めませんでした」, not a shorter list, when the second page fails", async () => {
    seed(1001);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "parcels" && !q.head && q.range?.[0] === 1000 ? fail : undefined));
    const root = await render();
    expect(failureBoxes(root)).toHaveLength(1);
    expect(parcelLinks(root)).toHaveLength(0);
    expect(textOf(root)).not.toContain("もうすぐ届く");
    // The counts are separate reads and still show.
    expect(textOf(linksTo(root, "/app/delivered")[0])).toMatch(/1\s*件/);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("shows 「読み込めませんでした」 with the counts when the first page fails", async () => {
    seed(3);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "parcels" && !q.head ? fail : undefined));
    const root = await render();
    expect(failureBoxes(root)).toHaveLength(1);
    expect(textOf(root)).not.toContain("まだ荷物がありません");
    expect(textOf(linksTo(root, "/app/delivered")[0])).toMatch(/1\s*件/);
    log.mockRestore();
  });

  it("still lists a few parcels in one read, with no failure", async () => {
    seed(3);
    const root = await render();
    expect(parcelLinks(root)).toHaveLength(3);
    expect(listReads(db)).toHaveLength(1);
    expect(failureBoxes(root)).toHaveLength(0);
  });
});

describe("/app/calendar reads every parcel of the month", () => {
  // Next month, so every day of it is still ahead whatever today is.
  const next = shiftMonth(todayJst().slice(0, 7), 1);
  const render = async () => {
    const Page = (await import("@/app/app/calendar/page")).default;
    return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ m: next }) })));
  };
  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      db.rows("parcels").push({ id: `p-${String(i).padStart(5, "0")}`, user_id: USER, shop: "テスト店", title: `品名${i}`, status: "shipped", expected_date: `${next}-15`, created_at: "2026-11-01T00:00:00Z" });
    }
  };

  it("shows 1,001 parcels on one day, past the 1000-row cap", async () => {
    seed(1001);
    const root = await render();
    expect(parcelLinks(root)).toHaveLength(1001);
    expect(textOf(root)).toContain("1001件");
    expect(failureBoxes(root)).toHaveLength(0);
    const reads = listReads(db);
    expect(reads.map((q) => q.range)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    for (const q of reads) expect(q.orders.map((o) => o.column), describeQuery(q)).toEqual(["expected_date", "expected_window_start", "id"]);
  });

  it("shows 「読み込めませんでした」, not a shorter list, when the second page fails", async () => {
    seed(1001);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "parcels" && q.range?.[0] === 1000 ? fail : undefined));
    const root = await render();
    expect(failureBoxes(root)).toHaveLength(1);
    expect(parcelLinks(root)).toHaveLength(0);
    expect(textOf(root)).not.toContain("この月の予定はありません");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("/app/calendar: a failed read", () => {
  const render = async () => {
    const Page = (await import("@/app/app/calendar/page")).default;
    return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) })));
  };

  it("shows 「読み込めませんでした」, not 「この月の予定はありません」", async () => {
    db.rows("parcels").push({ id: "p-1", user_id: USER, shop: "テスト店", status: "shipped", expected_date: day(1), created_at: "2026-11-01T00:00:00Z" });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    db.hooks.push((q) => (q.table === "parcels" ? fail : undefined));
    const root = await render();
    expect(failureBoxes(root)).toHaveLength(1);
    expect(textOf(root)).not.toContain("この月の予定はありません");
    log.mockRestore();
  });
});

describe("the pipeline finds the parcel past the first 1000", () => {
  const ORDER = "ORD-555500001111";
  const row = (over: Row): Row => ({ user_id: USER, shop: "テスト店", shop_key: "other", source: "mail", status: "ordered", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", ...over });

  it("files a mail on the parcel with its order number, not on a new one", async () => {
    const pipelineDb = new FakeDb({
      parcels: [
        ...Array.from({ length: 1000 }, (_, i) => row({ id: `p-old-${String(i).padStart(4, "0")}`, status: "delivered", order_number: `OLD-${i}` })),
        row({ id: "p-target", order_number: ORDER }),
      ],
    });
    await processInboundEmail(asAdmin(pipelineDb), mailOf("2026-11-03T01:00:00Z"), {
      precomputed: precomputed(reading({ relevance: "shipped", order_number: sure(ORDER), expected_date: sure("2026-11-05") })),
    });
    const mine = pipelineDb.rows("parcels").filter((r) => r.user_id === USER);
    expect(mine).toHaveLength(1001);
    expect(pipelineDb.find("parcels", "p-target")!.status).toBe("shipped");
  });

  it("fails the mail, and opens no new parcel, when the second page of the lookup fails", async () => {
    const pipelineDb = new FakeDb({
      parcels: [
        ...Array.from({ length: 1000 }, (_, i) => row({ id: `p-old-${String(i).padStart(4, "0")}`, status: "delivered", order_number: `OLD-${i}` })),
        row({ id: "p-target", order_number: ORDER }),
      ],
      emails: [],
    });
    pipelineDb.hooks.push((q) => (q.table === "parcels" && q.op === "select" && q.range?.[0] === 1000 ? fail : undefined));
    await expect(
      processInboundEmail(asAdmin(pipelineDb), mailOf("2026-11-03T01:00:00Z"), {
        precomputed: precomputed(reading({ relevance: "shipped", order_number: sure(ORDER), expected_date: sure("2026-11-05") })),
      }),
    ).rejects.toThrow(/parcels lookup failed/);
    // The second page was asked for and failed; nothing was filed on a shorter list.
    expect(pipelineDb.callsOn("parcels", "select").some((q) => q.range?.[0] === 1000)).toBe(true);
    expect(pipelineDb.rows("parcels").filter((r) => r.user_id === USER)).toHaveLength(1001);
    expect(pipelineDb.callsOn("parcels", "insert")).toHaveLength(0);
    expect(pipelineDb.find("parcels", "p-target")!.status).toBe("ordered");
    const emails = pipelineDb.rows("emails");
    expect(emails).toHaveLength(1);
    expect(emails[0].processing_status).toBe("failed");
  });
});

describe("report:screen counts every screen event", () => {
  it("reads screen_events with readAll, not a capped select", () => {
    const source = readFileSync(path.resolve(__dirname, "../../../scripts/report-screen.ts"), "utf8");
    expect(source).toMatch(/import \{ readAll \} from "\.\.\/src\/lib\/supabase\/read-all"/);
    expect(source).toMatch(/readAll<[^>]*>\(\(\) =>\s*db\.from\("screen_events"\)\.select\("[^"]*", \{ count: "exact" \}\)/);
    expect(source).not.toMatch(/\.limit\(/);
  });
});
