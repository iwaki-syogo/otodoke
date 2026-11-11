import { describe, expect, it } from "vitest";
import { manualWritesNothing, type ManualParcelColumns } from "@/lib/manual-parcel";

/**
 * manualWritesNothing: would writing these columns change anything that is stored? The same
 * rule as the iOS app's ManualParcel.writesNothing. Each column the check looks at is changed
 * on the stored side alone, and the answer must turn false.
 */

type Saved = Parameters<typeof manualWritesNothing>[1];

const columns = (over: Partial<ManualParcelColumns> = {}): ManualParcelColumns => ({
  title: "本",
  shop: "店",
  shop_key: "other",
  ordered_at: "2026-11-01",
  total_amount: 2480,
  status: "shipped",
  requires_presence: true,
  tracking_number: "123456789012",
  carrier: "ヤマト運輸",
  tracking_url: null,
  ...over,
});

const saved = (over: Partial<Saved> = {}): Saved => ({
  title: "本",
  shop: "店",
  status: "shipped",
  total_amount: 2480,
  requires_presence: true,
  ordered_at: "2026-11-01",
  tracking_number: "123456789012",
  carrier: "ヤマト運輸",
  ...over,
});

function without<T extends object>(obj: T, ...keys: string[]): T {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k))) as T;
}

describe("manualWritesNothing", () => {
  it("is true when every column equals what is stored", () => {
    expect(manualWritesNothing(columns(), saved())).toBe(true);
  });

  it("is true for the columns an edit always sends, with no tracking columns", () => {
    const rest = without(columns(), "tracking_number", "carrier", "tracking_url");
    expect(manualWritesNothing(rest, saved({ tracking_number: "999", carrier: null }))).toBe(true);
  });

  it.each<[string, Partial<Saved>]>([
    ["title", { title: "別の本" }],
    ["title (stored null)", { title: null }],
    ["shop", { shop: "別の店" }],
    ["shop (stored null)", { shop: null }],
    ["ordered_at", { ordered_at: "2026-11-02" }],
    ["ordered_at (stored null)", { ordered_at: null }],
    ["total_amount", { total_amount: 1 }],
    ["total_amount (stored null)", { total_amount: null }],
    ["status", { status: "delivered" }],
    ["requires_presence", { requires_presence: false }],
    ["requires_presence (stored null)", { requires_presence: null }],
    ["tracking_number", { tracking_number: "999988887777" }],
    ["tracking_number (stored null)", { tracking_number: null }],
    ["carrier", { carrier: "佐川急便" }],
    ["carrier (stored null)", { carrier: null }],
  ])("is false when only the stored %s differs", (_label, over) => {
    expect(manualWritesNothing(columns(), saved(over))).toBe(false);
  });

  it("is false when a stored column the check needs was not read", () => {
    for (const key of ["ordered_at", "tracking_number", "carrier"]) {
      expect(manualWritesNothing(columns(), without(saved(), key))).toBe(false);
    }
    // An empty number is not "the same" as a number that was not read.
    expect(manualWritesNothing(columns({ tracking_number: null, carrier: null }), without(saved({ carrier: null }), "tracking_number"))).toBe(false);
  });

  it("is false for a column written only on a difference (category, date, evidence)", () => {
    expect(manualWritesNothing(columns({ category: "hobby", category_source: "user" }), saved())).toBe(false);
    expect(manualWritesNothing(columns({ expected_date: "2026-11-10" }), saved())).toBe(false);
    expect(manualWritesNothing(columns({ presence_evidence: null }), saved())).toBe(false);
  });

  it("reads the stored number as the form would write it, and ignores tracking_url", () => {
    expect(manualWritesNothing(columns(), saved({ tracking_number: "1234-5678-9012" }))).toBe(true);
    expect(manualWritesNothing(columns({ tracking_url: "https://example.com/t" }), saved())).toBe(true);
    expect(manualWritesNothing(columns({ tracking_number: null, carrier: null }), saved({ tracking_number: null, carrier: null }))).toBe(true);
  });
});
