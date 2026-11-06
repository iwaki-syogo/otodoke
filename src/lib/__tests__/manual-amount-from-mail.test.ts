import { describe, expect, it } from "vitest";
import { manualFormDefaults } from "@/app/app/parcels/manual-form";
import { DB_INT_MAX } from "@/lib/extract/schema";
import { MANUAL_MAX_AMOUNT, ManualParcelSchema, manualParcelFields, manualParcelSchemaFor } from "@/lib/manual-parcel";
import type { ParcelRow } from "@/lib/match";
import { processInboundEmail } from "@/lib/pipeline";
import { FakeDb } from "./fake-db";
import { USER, asAdmin, mailOf, precomputed, reading, sure } from "./pipeline-fixtures";

/**
 * Review R2-4: an amount typed in is held to 10,000,000 (MANUAL_MAX_AMOUNT), to stop a mistyped
 * one. A mail fills in a typed-in parcel's empty amount (refreshTotal), up to what the column
 * holds. With a mail's 12,000,000 there, opening the edit form and saving it unchanged answered
 * 金額が正しくありません. The stored amount saved back as it is passes now; a typed one is held
 * to the bound as before.
 */

const MANUAL_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-06T03:00:00Z");
const MAIL_TOTAL = 12_000_000;

const typedIn = (over: Record<string, unknown> = {}) => ({
  id: MANUAL_ID,
  user_id: USER,
  source: "manual",
  title: "手入力の品名",
  shop: "手入力の店",
  shop_key: "other",
  ordered_at: "2026-11-01",
  expected_date: null,
  total_amount: null,
  category: null,
  category_source: null,
  tracking_number: "123456789012",
  tracking_url: null,
  carrier: "ヤマト運輸",
  requires_presence: null,
  status: "ordered",
  last_email_at: "2026-11-01T00:00:00Z",
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

const form = (over: Record<string, string> = {}) => ({
  title: "品名",
  shop: "店",
  ordered_at: "",
  expected_date: "",
  total_amount: "",
  category: "",
  tracking_number: "",
  carrier: "auto",
  presence: "",
  status: "ordered",
  ...over,
});

const amountOf = (schema: ReturnType<typeof manualParcelSchemaFor> | typeof ManualParcelSchema, typed: string) => {
  const parsed = schema.safeParse(form({ total_amount: typed }));
  return parsed.success ? parsed.data.total_amount : parsed.error.issues[0]?.message;
};

describe("a typed-in parcel whose empty amount a mail filled in above the typing bound", () => {
  it("is saved unchanged from its edit form", async () => {
    const db = new FakeDb({ parcels: [typedIn()] });
    const order = reading({ relevance: "order", shop_name: "手入力の店", tracking_number: sure("1234-5678-9012"), total_amount: sure(MAIL_TOTAL) });
    await processInboundEmail(asAdmin(db), { ...mailOf("2026-11-05T01:00:00Z"), messageId: "<big-order@test>" }, { precomputed: precomputed(order) });
    const parcel = db.find("parcels", MANUAL_ID) as unknown as ParcelRow;
    expect(parcel.total_amount).toBe(MAIL_TOTAL);

    // What the edit form sends when nothing is touched, checked against what is stored.
    const values = manualFormDefaults(parcel, "2026-11-06");
    expect(values.total_amount).toBe("12000000");
    const parsed = manualParcelSchemaFor(parcel.status, parcel.total_amount).safeParse(values);
    expect(parsed.success ? null : parsed.error.issues[0]?.message).toBeNull();
    if (!parsed.success) return;
    expect(manualParcelFields(parsed.data, NOW, parcel).total_amount).toBe(MAIL_TOTAL);
  });

  it("keeps that amount written in another way, and lets it be cleared or lowered", () => {
    const edit = manualParcelSchemaFor("ordered", MAIL_TOTAL);
    expect(amountOf(edit, "12,000,000")).toBe(MAIL_TOTAL);
    expect(amountOf(edit, "１２，０００，０００")).toBe(MAIL_TOTAL);
    expect(amountOf(edit, "9,800")).toBe(9800);
    expect(amountOf(edit, "")).toBeNull();
  });

  it("keeps the largest amount the column holds, and a cancelled parcel's", () => {
    expect(amountOf(manualParcelSchemaFor("shipped", DB_INT_MAX), String(DB_INT_MAX))).toBe(DB_INT_MAX);
    const cancelled = manualParcelSchemaFor("cancelled", MAIL_TOTAL).safeParse(form({ total_amount: "12000000", status: "cancelled" }));
    expect(cancelled.success && cancelled.data).toMatchObject({ total_amount: MAIL_TOTAL, status: "cancelled" });
  });
});

describe("a typed amount is still held to the typing bound", () => {
  it("refuses a changed amount above it, also next to a stored one above it", () => {
    const edit = manualParcelSchemaFor("ordered", MAIL_TOTAL);
    expect(amountOf(edit, "12000001")).toBe("金額が正しくありません");
    expect(amountOf(edit, "13,000,000")).toBe("金額が正しくありません");
    expect(amountOf(manualParcelSchemaFor("shipped", DB_INT_MAX), String(DB_INT_MAX + 1))).toBe("金額が正しくありません");
  });

  it("refuses an amount above it when nothing that size is stored", () => {
    expect(amountOf(ManualParcelSchema, "12000000")).toBe("金額が正しくありません");
    expect(amountOf(manualParcelSchemaFor("ordered"), "12000000")).toBe("金額が正しくありません");
    expect(amountOf(manualParcelSchemaFor("ordered", null), "12000000")).toBe("金額が正しくありません");
    expect(amountOf(manualParcelSchemaFor("ordered", 3000), "12000000")).toBe("金額が正しくありません");
  });

  it("control: takes an amount up to it, with or without a stored one", () => {
    expect(amountOf(ManualParcelSchema, String(MANUAL_MAX_AMOUNT))).toBe(MANUAL_MAX_AMOUNT);
    expect(amountOf(manualParcelSchemaFor("ordered", MAIL_TOTAL), String(MANUAL_MAX_AMOUNT))).toBe(MANUAL_MAX_AMOUNT);
    expect(amountOf(manualParcelSchemaFor("ordered"), "0")).toBe(0);
    expect(amountOf(manualParcelSchemaFor("ordered", MAIL_TOTAL), "-1")).toBe("金額が正しくありません");
  });
});
