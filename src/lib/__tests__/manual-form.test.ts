import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CARRIERS } from "@/lib/carriers";
import { ManualParcelSchema, manualParcelRow } from "@/lib/manual-parcel";
import type { ParcelRow } from "@/lib/match";
import { manualFormDefaults } from "@/app/app/parcels/manual-form";

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

  it("shows typed values as text only", () => {
    for (const f of ["parcels/manual-form.tsx", "parcels/new/page.tsx", "parcels/[id]/edit/page.tsx"]) {
      expect(read(f), f).not.toContain("dangerouslySetInnerHTML");
    }
  });
});
