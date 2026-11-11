import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CARRIERS } from "@/lib/carriers";
import { ManualParcelSchema, manualParcelRow } from "@/lib/manual-parcel";
import type { ParcelRow } from "@/lib/match";
import { ManualForm, manualFormDefaults } from "@/app/app/parcels/manual-form";
import { ancestorsOf, classesOf, findAll, parseHtml, type HtmlNode } from "./html-tree";

/**
 * manualFormDefaults(parcel | null, today) -> Record<string, string>, exported from
 * src/app/app/parcels/manual-form.tsx: the values the form starts with, as strings under the
 * field names ManualParcelSchema reads. For a new parcel the order date is today (JST).
 * The seam with task 6: what the edit form starts with must parse and save back unchanged.
 */

const TODAY = "2026-11-03";
const NOW = new Date("2026-11-03T03:00:00Z");

const typedIn = (over: Partial<ParcelRow> & Record<string, unknown> = {}) =>
  ({
    id: "11111111-1111-4111-8111-111111111111",
    user_id: "u",
    source: "manual",
    title: "テスト用の品名",
    shop: "テスト雑貨店",
    shop_key: "other",
    ordered_at: "2026-10-30",
    expected_date: "2026-11-10",
    total_amount: 2480,
    category: "hobby",
    category_source: "user",
    tracking_number: "123456789012",
    carrier: CARRIERS.sagawa.name,
    requires_presence: true,
    status: "shipped",
    ...over,
  }) as unknown as ParcelRow;

function roundTrip(p: ParcelRow) {
  const parsed = ManualParcelSchema.safeParse(manualFormDefaults(p, TODAY));
  if (!parsed.success) throw new Error(`edit form for ${JSON.stringify(p)} does not parse: ${parsed.error.message}`);
  return manualParcelRow(parsed.data, NOW) as Record<string, unknown>;
}

describe("manualFormDefaults", () => {
  it("starts a new parcel with today's date, 注文済み and automatic carrier", () => {
    const v = manualFormDefaults(null, TODAY);
    expect(v.ordered_at).toBe(TODAY);
    expect(v.status).toBe("ordered");
    expect(v.carrier).toBe("auto");
    expect(v.title).toBe("");
    expect(v.shop).toBe("");
    expect(v.total_amount).toBe("");
  });

  it("gives every value as a string", () => {
    for (const v of [manualFormDefaults(null, TODAY), manualFormDefaults(typedIn(), TODAY)]) {
      for (const [k, x] of Object.entries(v)) expect(typeof x, k).toBe("string");
    }
  });

  it("saves a typed-in parcel back unchanged when nothing is edited", () => {
    const row = roundTrip(typedIn());
    expect(row.title).toBe("テスト用の品名");
    expect(row.shop).toBe("テスト雑貨店");
    expect(row.ordered_at).toBe("2026-10-30");
    expect(row.expected_date).toBe("2026-11-10");
    expect(row.total_amount).toBe(2480);
    expect(row.category).toBe("hobby");
    expect(row.tracking_number).toBe("123456789012");
    expect(row.carrier).toBe(CARRIERS.sagawa.name);
    expect(row.requires_presence).toBe(true);
    expect(row.status).toBe("shipped");
  });

  it("round-trips empty fields as empty", () => {
    const row = roundTrip(typedIn({ expected_date: null, total_amount: null, category: null, category_source: null, tracking_number: null, carrier: null, requires_presence: null }));
    expect(row.expected_date).toBeNull();
    expect(row.total_amount).toBeNull();
    expect(row.category).toBeNull();
    expect(row.tracking_number).toBeNull();
    expect(row.requires_presence).toBeNull();
  });

  it("round-trips 0 yen and 置き配", () => {
    const row = roundTrip(typedIn({ total_amount: 0, requires_presence: false }));
    expect(row.total_amount).toBe(0);
    expect(row.requires_presence).toBe(false);
  });

  it("keeps a carrier the number decides (Amazon) when saved back", () => {
    const row = roundTrip(typedIn({ tracking_number: "TBA123456789012", carrier: CARRIERS.amazon.name }));
    expect(row.carrier).toBe(CARRIERS.amazon.name);
  });

  it("still lets the user save a typed-in parcel that a mail moved on to 配達中 or 不在", () => {
    // mergeIntoManual moves the status forward, so these reach typed-in parcels.
    for (const status of ["out_for_delivery", "attempted"]) {
      expect(() => roundTrip(typedIn({ status })), status).not.toThrow();
    }
  });
});

describe("manual form screens", () => {
  const read = (rel: string) => readFileSync(path.resolve(__dirname, "../../app/app", rel), "utf8");

  it("puts 「＋ 登録」 at the top of the parcel list, linking to /app/parcels/new", () => {
    const list = read("page.tsx");
    expect(list).toContain("/app/parcels/new");
    expect(list).toMatch(/＋\s*登録/);
  });

  it("opens the edit screen for typed-in parcels only", () => {
    const edit = read("parcels/[id]/edit/page.tsx");
    expect(edit).toMatch(/\bsource\b/);
    expect(edit).toMatch(/["']manual["']/);
    expect(edit).toMatch(/notFound\(|redirect\(/);
  });

  it("carries the version the edit form was opened with, and a new parcel carries none", () => {
    const html = (parcel: ParcelRow | null) => renderToStaticMarkup(createElement(ManualForm, { parcel, today: TODAY }));
    const hidden = (markup: string) => findAll(parseHtml(markup), (n) => n.tag === "input" && n.attrs.name === "updated_at");
    const opened = hidden(html(typedIn({ updated_at: "2026-11-02T01:02:03.456789+00:00" })));
    expect(opened).toHaveLength(1);
    expect(opened[0].attrs.type).toBe("hidden");
    expect(opened[0].attrs.value).toBe("2026-11-02T01:02:03.456789+00:00");
    expect(hidden(html(null))).toHaveLength(0);
  });

  it("starts the fields and the version again from the parcel it is given after a change", () => {
    const html = (parcel: ParcelRow) => renderToStaticMarkup(createElement(ManualForm, { parcel, today: TODAY }));
    const before = html(typedIn({ title: "開いた時の品名", updated_at: "2026-11-02T00:00:00+00:00" }));
    const after = html(typedIn({ title: "メールで直った品名", updated_at: "2026-11-03T00:00:00+00:00" }));
    expect(before).toContain("開いた時の品名");
    expect(after).toContain("メールで直った品名");
    expect(after).not.toContain("開いた時の品名");
    expect(after).toContain("2026-11-03T00:00:00+00:00");
    expect(after).not.toContain("2026-11-02T00:00:00+00:00");
  });

  it("shows typed values as text only", () => {
    for (const f of ["parcels/manual-form.tsx", "parcels/new/page.tsx", "parcels/[id]/edit/page.tsx"]) {
      expect(read(f), f).not.toContain("dangerouslySetInnerHTML");
    }
  });
});

/**
 * [Feedback 1] On an iPhone the two date fields ran past the right edge: iOS Safari gives
 * type=date a minimum width of its own and a grid child does not shrink below its content
 * (min-width: auto), so the two-column grid overflowed. The fix takes the cause away: each date
 * field gets a row of its own like every other field, may shrink to the row, and keeps its height
 * when empty. Checked on the rendered form, so the class names count however they are put together.
 */
describe("[Feedback 1] date fields on a phone", () => {
  const forms = {
    register: renderToStaticMarkup(createElement(ManualForm, { parcel: null, today: TODAY })),
    edit: renderToStaticMarkup(createElement(ManualForm, { parcel: typedIn(), today: TODAY })),
  };
  // The helpers read one parsed tree, so nodes taken by separate calls can be compared with toBe.
  const inputs = (root: HtmlNode) => findAll(root, (n) => n.tag === "input");
  const named = (root: HtmlNode, name: string) => {
    const hit = inputs(root).filter((n) => n.attrs.name === name);
    expect(hit, name).toHaveLength(1);
    return hit[0];
  };
  const dates = (root: HtmlNode) => inputs(root).filter((n) => n.attrs.type === "date");
  /** The element the field's <label> sits in. */
  const rowOf = (input: HtmlNode) => ancestorsOf(input)[1];

  for (const [screen, html] of Object.entries(forms)) {
    const root = parseHtml(html);

    it(`${screen}: has the two date fields, 注文日 and お届け予定日`, () => {
      expect(dates(root).map((n) => n.attrs.name).sort()).toEqual(["expected_date", "ordered_at"]);
    });

    it(`${screen}: puts each date field on a row of its own, like 品名 and 金額`, () => {
      const column = rowOf(named(root, "title"));
      for (const d of dates(root)) {
        const [label] = ancestorsOf(d);
        expect(label.tag, d.attrs.name).toBe("label");
        expect(classesOf(label), d.attrs.name).toEqual(expect.arrayContaining(["text-sm", "font-medium"]));
        // Same column as the other fields, not a grid of its own.
        expect(rowOf(d), d.attrs.name).toBe(column);
        expect(rowOf(named(root, "total_amount"))).toBe(column);
        for (const a of ancestorsOf(d)) expect(classesOf(a).filter((c) => /^grid-cols-/.test(c)), d.attrs.name).toEqual([]);
      }
    });

    it(`${screen}: lets each date field shrink to the row and keeps its height when empty`, () => {
      for (const d of dates(root)) {
        const cls = classesOf(d);
        expect(cls, d.attrs.name).toEqual(expect.arrayContaining(["block", "w-full", "min-w-0", "max-w-full", "appearance-none"]));
        expect(cls.some((c) => /^min-h-/.test(c)), `${d.attrs.name}: min-h-*`).toBe(true);
      }
    });

    it(`${screen}: keeps the look of the other fields on the date fields`, () => {
      const field = classesOf(named(root, "title"));
      expect(field).toEqual(expect.arrayContaining(["rounded-xl", "border", "border-neutral-300", "bg-white", "px-3", "py-2.5", "text-base"]));
      for (const d of dates(root)) expect(classesOf(d), d.attrs.name).toEqual(expect.arrayContaining(["rounded-xl", "border", "border-neutral-300", "bg-white", "px-3", "py-2.5", "text-base"]));
    });
  }

  it("drops the two-column grid from the form", () => {
    const source = readFileSync(path.resolve(__dirname, "../../app/app/parcels/manual-form.tsx"), "utf8");
    expect(source).not.toContain("grid-cols-2");
  });

  it("aligns the date text to the left in WebKit", () => {
    const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
    expect(css).toMatch(/input\[type=["']?date["']?\]::-webkit-date-and-time-value\s*\{[^}]*text-align:\s*left\s*;?[^}]*\}/);
  });

  it("has no other type=date field in src (the fix covers every one)", () => {
    const src = path.resolve(__dirname, "../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== "__tests__") walk(full);
        } else if (/\.tsx?$/.test(name)) {
          for (const m of readFileSync(full, "utf8").matchAll(/type=(?:"date"|'date'|\{\s*["']date["']\s*\})/g)) hits.push(`${path.relative(src, full)}:${m.index}`);
        }
      }
    };
    walk(src);
    expect(hits.map((h) => h.split(":")[0])).toEqual(["app/app/parcels/manual-form.tsx", "app/app/parcels/manual-form.tsx"]);
  });
});

describe("delete form: the warning describes the confirm box", () => {
  it("the 本当に消す checkbox's aria-describedby is the id of the 「消すと元に戻せません。」 paragraph", () => {
    const root = parseHtml(renderToStaticMarkup(createElement(ManualForm, { parcel: typedIn(), today: TODAY })));
    const warning = findAll(root, (n) => n.tag === "p" && n.children.join("") === "消すと元に戻せません。");
    expect(warning).toHaveLength(1);
    expect(warning[0].attrs.id).toBeTruthy();
    const box = findAll(root, (n) => n.tag === "input" && n.attrs.type === "checkbox" && n.attrs.name === "confirm");
    expect(box).toHaveLength(1);
    expect(box[0].attrs["aria-describedby"]).toBe(warning[0].attrs.id);
  });
});
