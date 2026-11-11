import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDemoEntries } from "@/lib/demo";
import { shiftMonth, todayJst } from "@/lib/format";
import { buildParcelInsert, buildParcelUpdate, chooseParcel, faceToFace, faceToFaceAssumed, startsParcel, type ParcelCandidate, type ParcelRow } from "@/lib/match";
import { FakeDb, type Row } from "./fake-db";
import { findAll, hasClasses, linksTo, parseHtml, textOf, type HtmlNode } from "./html-tree";

/**
 * [Review 2026-11-06 E-1] A parcel whose mails say nothing about how it is received counts as
 * face-to-face (Amazon aside; worked out on display, stored values kept).
 * That default is still red and still counted, but it is worded apart, so it never reads like a
 * mail that said so:
 * - list and calendar cards, and the badge on the parcel page: 「🤝 念のため対面」
 * - the parcel page's 受け取り row: 「念のため対面」, and where the evidence would be, the fact that
 *   nothing was said (「メールに記載なし」, or 「指定なし」 for a parcel typed in by hand)
 * - a calendar day whose face-to-face parcels are all assumed: 「念のため対面」
 * What a mail (or the person) stated keeps its old words and its evidence line.
 */

const USER = "00000000-0000-4000-8000-00000000000a";
const PARCEL = "11111111-1111-4111-8111-111111111111";
const ASSUMED = "念のため対面";

const mocks = vi.hoisted(() => ({ state: { db: null as unknown } }));

// These existing UI scenarios begin after the person has allowed reading.
vi.mock("@/lib/ai-consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-consent")>()),
  readAiReadingConsent: async () => "granted",
}));

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

let db: FakeDb;
const seed = (parcels: Row[]) => {
  db = new FakeDb({ parcels, emails: [], parcel_items: [], extractions: [] });
  mocks.state.db = db;
};
beforeEach(() => seed([]));

let seq = 0;
const parcel = (over: Row): Row => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`,
  user_id: USER,
  shop: "テスト店",
  shop_key: "other",
  title: `品名${seq}`,
  status: "shipped",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

type Presence = Pick<ParcelRow, "requires_presence" | "shop_key">;

describe("faceToFaceAssumed never disagrees with faceToFace", () => {
  // requires_presence × shop_key, every combination. undefined: a row read without the column.
  const VALUES = [true, false, null, undefined] as const;
  const SHOPS = ["amazon", "other", "uniqlo", null] as const;
  // [requires_presence, shop_key, faceToFace, faceToFaceAssumed]
  const TABLE: Array<[(typeof VALUES)[number], (typeof SHOPS)[number], boolean | null, boolean]> = [
    [true, "amazon", true, false],
    [true, "other", true, false],
    [true, "uniqlo", true, false],
    [true, null, true, false],
    [false, "amazon", false, false],
    [false, "other", false, false],
    [false, "uniqlo", false, false],
    [false, null, false, false],
    [null, "amazon", null, false],
    [null, "other", true, true],
    [null, "uniqlo", true, true],
    [null, null, true, true],
    [undefined, "amazon", null, false],
    [undefined, "other", true, true],
    [undefined, "uniqlo", true, true],
    [undefined, null, true, true],
  ];

  it("covers every combination once", () => {
    const keys = TABLE.map(([v, s]) => `${v}|${s}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(VALUES.flatMap((v) => SHOPS.map((s) => `${v}|${s}`)).sort());
  });

  it.each(TABLE)("requires_presence=%s shop_key=%s: faceToFace %s, assumed %s", (requires_presence, shop_key, f2f, assumed) => {
    const p = { requires_presence, shop_key } as Presence;
    expect(faceToFace(p)).toBe(f2f);
    expect(faceToFaceAssumed(p)).toBe(assumed);
    // Assumed only where faceToFace says face-to-face and nothing is stored.
    expect(faceToFaceAssumed(p)).toBe(faceToFace(p) === true && (p.requires_presence ?? null) === null);
  });
});

describe("PresenceBadge", () => {
  const render = async (p: Presence, compact = false) => {
    const { PresenceBadge } = await import("@/app/app/parcel-card");
    return parseHtml(renderToStaticMarkup(createElement(PresenceBadge, { parcel: p, compact })));
  };
  const badge = (root: HtmlNode) => findAll(root, (n) => n.tag === "span")[0];

  it("keeps the old words for a stated face-to-face, on cards and on the parcel page", async () => {
    expect(textOf(await render({ requires_presence: true, shop_key: "other" }, true)).trim()).toBe("🤝 対面受け取り");
    expect(textOf(await render({ requires_presence: true, shop_key: "other" })).trim()).toBe("🤝 対面受け取りが必要");
  });

  it("says 「🤝 念のため対面」 for the default, on cards and on the parcel page", async () => {
    for (const compact of [true, false]) {
      const text = textOf(await render({ requires_presence: null, shop_key: "other" }, compact)).trim();
      expect(text).toBe(`🤝 ${ASSUMED}`);
      expect(text).not.toContain("対面受け取り");
    }
  });

  it("keeps the red for the default: the same badge as a stated one", async () => {
    const stated = badge(await render({ requires_presence: true, shop_key: "other" }, true));
    const assumed = badge(await render({ requires_presence: null, shop_key: "other" }, true));
    expect(hasClasses(stated, "bg-red-600", "text-white")).toBe(true);
    expect(assumed.attrs.class).toBe(stated.attrs.class);
  });

  it("is unchanged for 置き配 and for Amazon with nothing said", async () => {
    expect(textOf(await render({ requires_presence: false, shop_key: "other" }, true)).trim()).toBe("置き配・投函OK");
    expect(textOf(await render({ requires_presence: null, shop_key: "amazon" }, true))).toBe("");
  });
});

describe("/app: the cards", () => {
  it("tell a stated face-to-face from the default", async () => {
    const stated = parcel({ requires_presence: true, presence_evidence: "対面での配達を希望", expected_date: "2099-01-02" });
    const assumed = parcel({ requires_presence: null, expected_date: "2099-01-03" });
    seed([stated, assumed]);
    const Page = (await import("@/app/app/page")).default;
    const root = parseHtml(renderToStaticMarkup(await Page()));
    const card = (p: Row) => textOf(linksTo(root, `/app/parcels/${p.id}`)[0]);
    expect(card(stated)).toContain("🤝 対面受け取り");
    expect(card(stated)).not.toContain(ASSUMED);
    expect(card(assumed)).toContain(`🤝 ${ASSUMED}`);
    expect(card(assumed)).not.toContain("対面受け取り");
  });
});

describe("parcel page: the 受け取り row", () => {
  const render = async (over: Row) => {
    seed([parcel({ id: PARCEL, ...over })]);
    const Page = (await import("@/app/app/parcels/[id]/page")).default;
    return parseHtml(renderToStaticMarkup(await Page({ params: Promise.resolve({ id: PARCEL }) })));
  };
  /** The <dd> right after the <dt> that reads `label`. */
  const row = (root: HtmlNode, label: string) => {
    const dt = findAll(root, (n) => n.tag === "dt" && textOf(n) === label);
    expect(dt, label).toHaveLength(1);
    const siblings = dt[0].parent!.children.filter((c): c is HtmlNode => typeof c !== "string");
    const dd = siblings[siblings.indexOf(dt[0]) + 1];
    expect(dd.tag).toBe("dd");
    return dd;
  };
  const lines = (dd: HtmlNode) => dd.children.map((c) => textOf(c).trim()).filter(Boolean);

  it("keeps a stated face-to-face as it was, with its evidence", async () => {
    const root = await render({ requires_presence: true, presence_evidence: "■受取ご希望場所：対面での配達を希望" });
    expect(lines(row(root, "受け取り"))).toEqual(["対面受け取りが必要", "根拠: 「■受取ご希望場所：対面での配達を希望」"]);
    expect(textOf(root)).toContain("🤝 対面受け取りが必要");
    expect(textOf(root)).not.toContain(ASSUMED);
  });

  it("says 「念のため対面」 for the default, with 「メールに記載なし」 where the evidence would be", async () => {
    const root = await render({ requires_presence: null, presence_evidence: null });
    expect(lines(row(root, "受け取り"))).toEqual([ASSUMED, "メールに記載なし"]);
    expect(textOf(root)).toContain(`🤝 ${ASSUMED}`);
    expect(textOf(root)).not.toContain("対面受け取り");
    expect(textOf(root)).not.toContain("根拠");
  });

  it("shows no evidence line for the default even when an unsure reading left one", async () => {
    // Stored by the first mail although its value was below the confidence bar: it decided nothing.
    const root = await render({ requires_presence: null, presence_evidence: "置き配をご指定いただけます" });
    expect(lines(row(root, "受け取り"))).toEqual([ASSUMED, "メールに記載なし"]);
    expect(textOf(root)).not.toContain("根拠");
  });

  it("says 「指定なし」, not that a mail said nothing, for a parcel typed in with 指定なし", async () => {
    const root = await render({ source: "manual", requires_presence: null });
    expect(lines(row(root, "受け取り"))).toEqual([ASSUMED, "指定なし"]);
    expect(textOf(row(root, "受け取り"))).not.toContain("メールに記載なし");
  });

  it("keeps 置き配 and Amazon with nothing said as they were", async () => {
    expect(lines(row(await render({ requires_presence: false, presence_evidence: "宅配ボックス" }), "受け取り"))).toEqual(["置き配・投函でOK", "根拠: 「宅配ボックス」"]);
    const amazon = await render({ shop_key: "amazon", requires_presence: null });
    expect(lines(row(amazon, "受け取り"))).toEqual(["メールに記載なし"]);
    expect(textOf(amazon)).not.toContain("🤝");
  });
});

describe("/app/calendar", () => {
  // Next month, so every day of it is still ahead whatever today is.
  const next = shiftMonth(todayJst().slice(0, 7), 1);
  const on = (d: number) => `${next}-${String(d).padStart(2, "0")}`;
  const render = async () => {
    const Page = (await import("@/app/app/calendar/page")).default;
    return parseHtml(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ m: next }) })));
  };
  const heading = (root: HtmlNode, day: string) => {
    const li = findAll(root, (n) => n.tag === "li" && n.attrs.id === `d-${day}`);
    expect(li, day).toHaveLength(1);
    return findAll(li[0], (n) => n.tag === "h2")[0];
  };
  /** The day's label in its heading (red text), or null. */
  const label = (root: HtmlNode, day: string) => {
    const red = findAll(heading(root, day), (n) => hasClasses(n, "text-red-700"));
    return red.length ? textOf(red[0]) : null;
  };
  /** The count chip in the day's cell. */
  const chip = (root: HtmlNode, day: string) => findAll(linksTo(root, `#d-${day}`)[0], (n) => n.tag === "span")[1];

  beforeEach(() => {
    seed([
      parcel({ expected_date: on(10), requires_presence: null, title: "既定だけの日" }),
      parcel({ expected_date: on(12), requires_presence: true, presence_evidence: "対面での配達を希望", title: "記載ありの日" }),
      parcel({ expected_date: on(14), requires_presence: true, presence_evidence: "手渡し", title: "両方の日 記載" }),
      parcel({ expected_date: on(14), requires_presence: null, title: "両方の日 既定" }),
      parcel({ expected_date: on(16), requires_presence: false, title: "置き配の日" }),
      parcel({ expected_date: on(16), requires_presence: null, shop_key: "amazon", title: "Amazonの日" }),
    ]);
  });

  it("labels a day 「念のため対面」 only when every face-to-face parcel of it is the default", async () => {
    const root = await render();
    expect(label(root, on(10))).toBe(ASSUMED);
    expect(label(root, on(12))).toBe("対面受け取り");
    expect(label(root, on(14))).toBe("対面受け取り");
    expect(label(root, on(16))).toBeNull();
  });

  it("keeps the colours and the counts: the default is red and counted like a stated one", async () => {
    const root = await render();
    for (const [d, count] of [[10, 1], [12, 1], [14, 2]] as const) {
      const c = chip(root, on(d));
      expect(hasClasses(c, "bg-red-600", "text-white"), on(d)).toBe(true);
      expect(textOf(c), on(d)).toBe(`🤝${count}件`);
    }
    const quiet = chip(root, on(16));
    expect(hasClasses(quiet, "bg-sky-100")).toBe(true);
    expect(textOf(quiet)).toBe("2件");
  });

  it("words each card under the day like the list", async () => {
    const root = await render();
    const cardOf = (title: string) => findAll(root, (n) => n.tag === "a" && textOf(n).includes(title))[0];
    expect(textOf(cardOf("既定だけの日"))).toContain(`🤝 ${ASSUMED}`);
    expect(textOf(cardOf("両方の日 既定"))).toContain(`🤝 ${ASSUMED}`);
    expect(textOf(cardOf("両方の日 記載"))).toContain("🤝 対面受け取り");
    expect(textOf(cardOf("記載ありの日"))).not.toContain(ASSUMED);
  });
});

describe("the demo set the judges load", () => {
  it("words every red badge with no stated value as 「念のため対面」", async () => {
    const now = new Date("2026-11-06T03:00:00Z");
    // Folded as in demo-merge.test.ts.
    const rows: ParcelCandidate[] = [];
    for (const { mail, extraction: x } of await loadDemoEntries(todayJst(now), now)) {
      const chosen = chooseParcel(rows, x, now);
      if (chosen) Object.assign(chosen, buildParcelUpdate(chosen, x, mail.date));
      else if (startsParcel(x)) rows.push({ ...buildParcelInsert("demo", x, mail.date), id: String(rows.length), created_at: mail.date ?? "", itemNames: x.items.map((i) => i.name) } as unknown as ParcelCandidate);
    }
    // The 6 parcels of the real mails and the 80 of the made-up history, which are all delivered.
    expect(rows).toHaveLength(86);
    const { PresenceBadge } = await import("@/app/app/parcel-card");
    const red = rows.filter((r) => faceToFace(r) === true);
    // The history adds no red mark: every one of its mails says the parcel was left at the door.
    const history = rows.filter((r) => r.status === "delivered" && /^[A-Z]{3}-\d{4}-\d{5}$/.test(r.order_number ?? ""));
    expect(history).toHaveLength(80);
    for (const r of history) expect(r.requires_presence, r.order_number ?? "").toBe(false);
    expect(red.length).toBe(rows.filter((r) => !history.includes(r) && faceToFace(r) === true).length);
    const assumed = red.filter((r) => faceToFaceAssumed(r));
    const stated = red.filter((r) => !faceToFaceAssumed(r));
    // Both kinds are in the demo, so both wordings are on the judges' screens.
    expect(assumed.length).toBeGreaterThan(0);
    expect(stated.length).toBeGreaterThan(0);
    for (const r of assumed) {
      expect(r.requires_presence, r.shop).toBeNull();
      expect(textOf(parseHtml(renderToStaticMarkup(createElement(PresenceBadge, { parcel: r, compact: true })))).trim(), r.shop).toBe(`🤝 ${ASSUMED}`);
    }
    // A badge in the old words has the mail line behind it.
    for (const r of stated) {
      expect(r.requires_presence, r.shop).toBe(true);
      expect(r.presence_evidence, r.shop).toBeTruthy();
    }
  });
});
