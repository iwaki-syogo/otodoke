import { describe, expect, it } from "vitest";
import { evidenceIsPresent, hasUnverifiedUnrelatedVerdict, verifyEvidence } from "@/lib/extract/verify-evidence";
import { buildParcelInsert, buildParcelUpdate, mergeIntoManual, parcelTotal, splitOrders } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb } from "./fake-db";
import { asConsentingAdmin, mailOf, none, precomputed, reading } from "./pipeline-fixtures";
import type { ParcelRow } from "@/lib/match";

const field = <T>(value: T, evidence: string | null, confidence = 0.95) => ({ value, evidence, confidence });
const source = { subject: "発送のお知らせ", text: "商品を発送しました。\n注文番号: TEST-12345678\n合計: 1,980円\n11月12日(木)にお届け\n対面で受け取り", html: null };
const good = () => reading({
  relevance: "shipped", relevance_evidence: "商品を発送しました。",
  order_number: field("TEST-12345678", "注文番号: TEST-12345678"),
  total_amount: field(1980, "合計: 1,980円"),
  expected_date: field("2026-11-12", "11月12日(木)にお届け"),
  requires_presence: field(true, "対面で受け取り"),
});

describe("evidence quotation matching", () => {
  it.each([
    ["HTML whitespace, entities and full-width characters", "合計: ¥1,980", { subject: "", html: "<p>合計：&nbsp;￥１，９８０</p>" }],
    ["space before currency suffix", "合計: 1,980 円", { subject: "", text: "合計: ￥1,980" }],
    ["Japanese date with a normalized extraction value", "11月12日(木)にお届け", source],
    ["subject-only value", "発送のお知らせ", { subject: "発送のお知らせ", text: "本文には無い" }],
    ["ellipsis fragments in source order", "注文番号…12345678", source],
    ["ASCII ellipsis", "合計...1,980円", source],
  ])("accepts %s", (_name, evidence, mail) => expect(evidenceIsPresent(evidence, mail)).toBe(true));

  it.each([null, "", "...", "…", "本文には無い証拠", "12345678…注文番号", "980円", "商品を発送しました。…発送のお知らせ"])("rejects absent or invented quotation %s", (evidence) => {
    expect(evidenceIsPresent(evidence, source)).toBe(false);
  });

  it("does not splice a quotation between subject and body", () => {
    expect(evidenceIsPresent("発送のお知らせ…注文番号", source)).toBe(false);
  });
});

describe("field-specific evidence verification", () => {
  it("keeps grounded date, amount and presence fields without trusting overall alone", () => {
    const x = verifyEvidence(good(), source);
    const row = buildParcelInsert("test", x, null);
    expect(row).toMatchObject({ total_amount: 1980, expected_date: "2026-11-12", requires_presence: true, status: "shipped", needs_review: false });
    expect(x.evidence_review).toEqual([]);
  });

  it.each([null, "架空の合計です"])("removes only an ungrounded field (%s), and flags the parcel", (evidence) => {
    const x = verifyEvidence({ ...good(), total_amount: field(9999, evidence), overall_confidence: 1 }, source);
    expect(x.total_amount.value).toBeNull();
    expect(x.expected_date.value).toBe("2026-11-12");
    expect(x.requires_presence.value).toBe(true);
    expect(buildParcelInsert("test", x, null)).toMatchObject({ total_amount: null, expected_date: "2026-11-12", needs_review: true });
    expect(parcelTotal([x])).toBeNull();
  });

  it.each([-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY])("does not trust out-of-range field confidence %s", (confidence) => {
    const x = verifyEvidence({ ...good(), total_amount: field(1980, "合計: 1,980円", confidence) }, source);
    expect(x.total_amount.value).toBeNull();
    expect(x.evidence_review).toContain("total_amount");
    expect(x.expected_date.value).not.toBeNull();
    expect(parcelTotal([x])).toBeNull();
  });

  it("flags invalid overall confidence without discarding good fields", () => {
    const x = verifyEvidence({ ...good(), overall_confidence: 9 }, source);
    expect(x.total_amount.value).toBe(1980);
    expect(buildParcelInsert("test", x, null).needs_review).toBe(true);
  });

  it("keeps a low-confidence field tentative even when overall is high", () => {
    const x = verifyEvidence({ ...good(), total_amount: field(1980, "合計: 1,980円", 0.4), overall_confidence: 1 }, source);
    expect(buildParcelInsert("test", x, null)).toMatchObject({ total_amount: null, expected_date: "2026-11-12", needs_review: true });
  });

  it("is idempotent: a saved unknown field keeps its review reason on a later verification", () => {
    const first = verifyEvidence({ ...good(), total_amount: field(9999, null), other_orders: [{
      order_number: field("MADE-UP", null), total_amount: field(1980, "合計: 1,980円"),
      expected_date: none, expected_date_end: none, expected_text: null, items: [], category: null,
    }] }, source);
    const second = verifyEvidence(first, source);
    expect(second).toEqual(first);
    expect(second.evidence_review).toEqual(["total_amount"]);
    expect(second.other_orders[0].evidence_review).toEqual(["order_number"]);
    expect(buildParcelInsert("test", second, null).needs_review).toBe(true);
  });

  it("does not add a review reason for a field that was unknown from the start", () => {
    const x = verifyEvidence({ ...good(), total_amount: none }, source);
    expect(x.evidence_review).toEqual([]);
  });

  it("does not assert an ungrounded delivery state", () => {
    const x = verifyEvidence({ ...good(), relevance: "delivered", relevance_evidence: "配達しました" }, source);
    expect(buildParcelInsert("test", x, null)).toMatchObject({ status: "unknown", expected_date: "2026-11-12", needs_review: true });
  });

  it("does not infer an order date from an ungrounded classification", () => {
    const x = verifyEvidence({ ...good(), relevance: "order", relevance_evidence: null }, source);
    expect(buildParcelInsert("test", x, "2026-11-12T00:00:00Z")).toMatchObject({ status: "unknown", ordered_at: null, needs_review: true });
  });

  it("preserves an unverified unrelated verdict instead of inventing a positive order", () => {
    const x = verifyEvidence({ ...good(), relevance: "unrelated", relevance_evidence: null }, source);
    expect(x.relevance).toBe("unrelated");
    expect(x.evidence_review).toContain("relevance");
    expect(hasUnverifiedUnrelatedVerdict(x)).toBe(true);
    expect(verifyEvidence(x, source)).toEqual(x);
    expect(hasUnverifiedUnrelatedVerdict(verifyEvidence(good(), source))).toBe(false);
  });

  it("flags both automatic updates and merges into manual parcels", () => {
    const x = verifyEvidence({ ...good(), total_amount: field(9999, null) }, source);
    const existing = { ...buildParcelInsert("test", good(), null), source: "manual" } as ParcelRow;
    expect(buildParcelUpdate(existing, x, null).needs_review).toBe(true);
    expect(mergeIntoManual(existing, x, null).needs_review).toBe(true);
  });

  it("checks item evidence separately and keeps a good sibling item", () => {
    const x = verifyEvidence({ ...good(), items: [
      { name: "テスト商品", quantity: 1, unit_price: 1980, evidence: "合計: 1,980円" },
      { name: "架空の商品", quantity: 1, unit_price: 9999, evidence: "本文に無い商品" },
    ] }, source);
    expect(x.items).toHaveLength(1);
    expect(x.evidence_review).toContain("items.1");
  });

  it("keeps another order's good fields when its order number has no evidence", () => {
    const x = verifyEvidence({ ...good(), other_orders: [{
      order_number: field("MADE-UP", null), total_amount: field(1980, "合計: 1,980円"),
      expected_date: none, expected_date_end: none, expected_text: null, items: [], category: null,
    }] }, source);
    const split = splitOrders(x);
    expect(split).toHaveLength(2);
    expect(split[0].evidence_review).toEqual([]);
    expect(split[1].order_number.value).toBeNull();
    expect(buildParcelInsert("test", split[1], null)).toMatchObject({ total_amount: 1980, needs_review: true });
  });
});

describe("pipeline verifies before persisting or using an extraction", () => {
  it("keeps the mail and good fields while refusing an invented amount", async () => {
    const db = new FakeDb();
    const mail = { ...mailOf("2026-11-12T00:00:00Z"), ...source };
    const out = await processInboundEmail(asConsentingAdmin(db), mail, { precomputed: precomputed({ ...good(), total_amount: field(9999, "作った合計") }) });
    expect(out.kind).toBe("processed");
    expect(db.rows("parcels")[0]).toMatchObject({ total_amount: null, expected_date: "2026-11-12", requires_presence: true, needs_review: true });
    expect(db.rows("extractions")[0].result).toMatchObject({ total_amount: { value: null }, evidence_review: ["total_amount"] });
    expect(db.rows("emails")).toHaveLength(1);
  });

  it("keeps a mail with an ungrounded unrelated verdict without filing it as an order", async () => {
    const db = new FakeDb();
    const out = await processInboundEmail(asConsentingAdmin(db), { ...mailOf("2026-11-12T00:00:00Z"), ...source }, {
      precomputed: precomputed({ ...good(), relevance: "unrelated", relevance_evidence: "広告をどうぞ" }),
    });
    // Keeping the original mail does not justify creating a parcel from a negative verdict.
    expect(out.kind).toBe("noted");
    expect(db.rows("parcels")).toEqual([]);
    expect(db.rows("extractions")).toEqual([]);
    expect(db.rows("emails")).toHaveLength(1);
    expect(db.rows("emails")[0]).toMatchObject({ processing_status: "failed", error: "relevance_unverified", text_body: source.text });
  });
});
