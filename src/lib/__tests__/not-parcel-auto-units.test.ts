import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/database.types";
import { arrivingSign, bringsBack, chooseParcel, type ParcelCandidate } from "@/lib/match";
import { excludedToastText } from "@/lib/not-parcel-auto-toast";
import { EXCLUDED_TOAST, EXCLUDED_TOAST_AUTO } from "@/lib/not-parcel-text";
import { isAutoExcludableDomain, isRememberableDomain, NO_AUTO_EXCLUDE_DOMAINS } from "@/lib/screen-senders";
import { item, reading, sure } from "./pipeline-fixtures";

const NOW = new Date("2026-11-10T00:00:00Z");
const ID = "10000000-0000-4000-8000-000000000001";

function candidate(over: Partial<ParcelCandidate> = {}): ParcelCandidate {
  return {
    id: "p1", user_id: "u", shop: "テスト店", shop_key: "amazon", status: "ordered", source: "mail", order_number: null, tracking_number: null,
    expected_date: null, created_at: "2026-11-09T00:00:00Z", updated_at: "2026-11-09T00:00:00Z", itemNames: [], excluded: null, ...over,
  } as unknown as ParcelCandidate;
}
const out = { kind: "rule", from_domain: "amazon.example", relevance: "order", counted: false };

describe("U1-U5 matching: a parcel taken out is found by its numbers only", () => {
  it("U1 by its order number", () => {
    const hit = chooseParcel([candidate({ order_number: "A-1111-2222", excluded: out })], reading({ order_number: sure("A-1111-2222") }), NOW);
    expect(hit?.id).toBe("p1");
  });
  it("U2 by its tracking number", () => {
    const hit = chooseParcel([candidate({ tracking_number: "123456789012", excluded: out })], reading({ tracking_number: sure("1234-5678-9012") }), NOW);
    expect(hit?.id).toBe("p1");
  });
  it("U3 not by a shop and a day alone", () => {
    const x = reading({ shop_key: "amazon", order_number: sure("ZZ-9999-0000"), expected_date: sure("2026-11-12") });
    const shown = candidate({ tracking_number: "123456789012", expected_date: "2026-11-12" });
    expect(chooseParcel([shown], x, NOW)?.id).toBe("p1");
    expect(chooseParcel([{ ...shown, excluded: out }], x, NOW)).toBeNull();
  });
  it("U4 not by a likely item name", () => {
    const x = reading({ relevance: "shipped", shop_key: "amazon", shop_name: "テスト店", items: [item("とても長い名前の商品ひとつ目")] });
    const shown = candidate({ itemNames: ["とても長い名前の商品ひとつ目"] });
    expect(chooseParcel([shown], x, NOW)?.id).toBe("p1");
    expect(chooseParcel([{ ...shown, excluded: out }], x, NOW)).toBeNull();
  });
  it("U5 a candidate with no mark field at all (older callers) is matched as before", () => {
    const { excluded: _gone, ...bare } = candidate({ itemNames: ["とても長い名前の商品ひとつ目"] });
    void _gone;
    const x = reading({ relevance: "shipped", shop_key: "amazon", shop_name: "テスト店", items: [item("とても長い名前の商品ひとつ目")] });
    expect(chooseParcel([bare as ParcelCandidate], x, NOW)?.id).toBe("p1");
  });
});

describe("arrivingSign and bringsBack", () => {
  it("a bare order has no sign", () => {
    expect(arrivingSign(reading({ relevance: "order" }))).toBe(false);
  });
  it.each([
    ["a tracking number", { tracking_number: sure("1234-5678-9012") }],
    ["a carrier", { carrier: sure("テスト運輸") }],
    ["a slip's item", { package_description: sure("衣料品") }],
    ["a need to be home", { requires_presence: sure(true) }],
    ["the words of a date", { expected_text: "根拠の行" }],
    ["a window start", { expected_window_start: sure("14:00") }],
    ["a window end", { expected_window_end: sure("16:00") }],
    ["a sure date", { expected_date: sure("2026-11-20") }],
    ["a tracking number the evidence check cleared", { evidence_review: ["tracking_number"] }],
    ["a carrier the evidence check cleared", { evidence_review: ["carrier"] }],
  ])("%s is a sign", (_name, over) => {
    expect(arrivingSign(reading({ relevance: "order", ...over }))).toBe(true);
  });
  it("an unsure date, a person who need not be home, and a cleared date are no sign", () => {
    expect(arrivingSign(reading({ relevance: "order", expected_date: { value: "2026-11-20", evidence: "根拠の行", confidence: 0.3 } }))).toBe(false);
    expect(arrivingSign(reading({ relevance: "order", requires_presence: sure(false) }))).toBe(false);
    expect(arrivingSign(reading({ relevance: "order", evidence_review: ["expected_date"] }))).toBe(false);
  });
  it("a cancellation is not a sign of arrival", () => {
    expect(bringsBack(reading({ relevance: "cancelled" }))).toBe(false);
  });
  it("every shipment-or-later kind brings back; an order, a payment and other_purchase alone do not", () => {
    for (const relevance of ["shipped", "out_for_delivery", "attempted", "delivered"] as const) expect(bringsBack(reading({ relevance }))).toBe(true);
    for (const relevance of ["order", "payment", "other_purchase"] as const) expect(bringsBack(reading({ relevance }))).toBe(false);
  });
  it("the sender's own copy never brings back, with every sign on it", () => {
    expect(bringsBack(reading({ relevance: "shipped", tracking_number: sure("1234-5678-9012"), inbound: sure(false) }))).toBe(false);
  });
  it("the kind counts as it was read, not as a quotation-checked status", () => {
    expect(bringsBack({ ...reading({ relevance: "shipped" }), evidence_review: ["relevance"] })).toBe(true);
  });
  it("a payment notice with a tracking number brings back", () => {
    expect(bringsBack(reading({ relevance: "payment", tracking_number: sure("1234-5678-9012") }))).toBe(true);
  });
});

describe("the senders the app never takes parcels out of by itself", () => {
  it("mail.yahoo.co.jp is one, and it is a separate list from the one 「これは荷物」 remembers", () => {
    expect([...NO_AUTO_EXCLUDE_DOMAINS]).toEqual(["mail.yahoo.co.jp"]);
    expect(isRememberableDomain("mail.yahoo.co.jp")).toBe(true);
    expect(isAutoExcludableDomain("mail.yahoo.co.jp")).toBe(false);
    expect(isAutoExcludableDomain("MAIL.YAHOO.CO.JP.")).toBe(false);
  });
  it("an ordinary shop is allowed, a shared domain is not", () => {
    expect(isAutoExcludableDomain("amazon.example")).toBe(true);
    expect(isAutoExcludableDomain("gmail.com")).toBe(false);
    expect(isAutoExcludableDomain(null)).toBe(false);
  });
});

describe("U-toast: which sentence follows taking out", () => {
  const client = (rpc: () => unknown) => ({ rpc: vi.fn(rpc) }) as unknown as SupabaseClient<Database> & { rpc: ReturnType<typeof vi.fn> };

  it("a clean true gives the sentence that says the app will do it by itself, after one read-only call", async () => {
    const c = client(async () => ({ data: true, error: null }));
    expect(await excludedToastText(c, ID)).toBe(EXCLUDED_TOAST_AUTO);
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith("auto_exclusion_would_start", { p_parcel_id: ID });
  });
  it("false gives the plain sentence", async () => {
    expect(await excludedToastText(client(async () => ({ data: false, error: null })), ID)).toBe(EXCLUDED_TOAST);
  });
  it.each([
    ["an error", async () => ({ data: true, error: { message: "boom" } })],
    ["a thrown call", async () => { throw new Error("network"); }],
    ["an answer that is not a boolean", async () => ({ data: "true", error: null })],
    ["no answer", async () => ({ data: null, error: null })],
  ])("%s gives the plain sentence (never promises what may not happen)", async (_name, answer) => {
    expect(await excludedToastText(client(answer), ID)).toBe(EXCLUDED_TOAST);
  });
  it("the two sentences differ, and both say who acts", () => {
    expect(EXCLUDED_TOAST_AUTO).not.toBe(EXCLUDED_TOAST);
    expect(EXCLUDED_TOAST_AUTO.startsWith("おとどけは")).toBe(true);
  });
});
