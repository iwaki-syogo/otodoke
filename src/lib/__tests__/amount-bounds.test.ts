import { beforeEach, describe, expect, it, vi } from "vitest";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { loadDemoEntries } from "@/lib/demo";
import { ExtractionSchema, type Extraction } from "@/lib/extract/schema";
import { parcelTotal } from "@/lib/match";
import type { InboundEmail } from "@/lib/pipeline";
import { FakeDb, type Query, type Result } from "./fake-db";
import { USER, asAdmin, mailOf, reading, sure } from "./pipeline-fixtures";

/**
 * Review B-2: the amounts and counts Claude reads are written to Postgres `integer` columns
 * (parcels.total_amount, parcel_items.quantity / unit_price). A mail saying "合計 3,000,000,000円"
 * failed every write (22003), the webhook answered 500, and every Resend retry paid for another
 * reading. A number past 2^53 failed even earlier, in the schema check of the answer.
 *
 * The Claude client is replaced, but the answer's text is parsed by the SDK's own code
 * (lib/parser), with the output format extract.ts passes, as in a real call. No API is called.
 */

const INT_MAX = 2_147_483_647;

const sdk = vi.hoisted(() => ({ answer: "", calls: [] as Array<Record<string, unknown>> }));

vi.mock("@anthropic-ai/sdk", async () => {
  const { parseMessage } = await vi.importActual<typeof import("@anthropic-ai/sdk/lib/parser")>("@anthropic-ai/sdk/lib/parser");
  return {
    default: class {
      messages = {
        parse: async (params: Record<string, unknown>) => {
          sdk.calls.push(params);
          const message = {
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [{ type: "text", text: sdk.answer, citations: null }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          };
          return parseMessage(message as never, params as never, { logger: console });
        },
      };
    },
  };
});

vi.mock("@/lib/env", () => ({
  env: () => ({ OTODOKE_MODEL: "test-model", OTODOKE_EXTRACT_EFFORT: "low", OTODOKE_USER_DAILY_LIMIT: 30, OTODOKE_GLOBAL_DAILY_LIMIT: 300 }),
  requireEnv: () => "test-key",
}));

const { extractEmail } = await import("@/lib/extract/extract");
const { processInboundEmail } = await import("@/lib/pipeline");

/** Postgres refuses an `integer` out of range; the fake database does not, so this plays it. */
function int4Guard(q: Query): Result | void {
  if (q.op !== "insert" && q.op !== "update" && q.op !== "upsert") return;
  const columns = q.table === "parcels" ? ["total_amount"] : q.table === "parcel_items" ? ["quantity", "unit_price"] : [];
  for (const row of (Array.isArray(q.values) ? q.values : [q.values]) as Array<Record<string, unknown>>) {
    for (const c of columns) {
      const v = row?.[c];
      if (typeof v === "number" && !(Number.isInteger(v) && v >= -INT_MAX - 1 && v <= INT_MAX)) {
        return { data: null, error: { message: `value "${v}" is out of range for type integer`, code: "22003" } as { message: string } };
      }
    }
  }
}

const amount = (value: number, evidence = "合計の行") => ({ value, evidence, confidence: 0.95 });
const line = (name: string, quantity: number | null, unit_price: number | null) => ({ name, quantity, unit_price, evidence: `${name}の行` });

function orderMail(): InboundEmail {
  return {
    ...mailOf("2026-11-03T01:00:00Z"),
    messageId: "<huge-amount@example.test>",
    from: "order@shop.example.test",
    subject: "【テスト店】ご注文ありがとうございます",
    text: "ご注文番号: ORD-99990000\n合計 3,000,000,000円",
  };
}

const read = async (x: Extraction) => {
  sdk.answer = JSON.stringify(x);
  return (await extractEmail({ from: "order@shop.example.test", subject: "件名", sentAt: null, body: "本文" })).data;
};

beforeEach(() => {
  sdk.calls.length = 0;
});

describe("reading an answer: a whole number the columns cannot hold is unknown", () => {
  it("reads 合計 3,000,000,000円 as no amount, keeping its evidence and confidence", async () => {
    const x = await read(reading({ relevance: "order", total_amount: amount(3_000_000_000, "合計 3,000,000,000円") }));
    expect(x.total_amount).toEqual({ value: null, evidence: "合計 3,000,000,000円", confidence: 0.95 });
  });

  it("does the same for item quantities and prices, and inside the other orders of the mail", async () => {
    const other = {
      order_number: sure("ORD-99990001"),
      items: [line("二つ目の品", 1, 9_999_999_999)],
      category: null,
      total_amount: amount(3_000_000_000),
      expected_date: sure("2026-11-08"),
      expected_date_end: { value: null, evidence: null, confidence: 0 },
      expected_text: null,
    };
    const x = await read(reading({ relevance: "order", items: [line("高い品", 1, 3_000_000_000), line("多い品", 5_000_000_000, 100), line("値引き", 1, -500)], other_orders: [other] }));
    expect(x.items).toEqual([line("高い品", 1, null), line("多い品", null, 100), line("値引き", 1, null)]);
    expect(x.other_orders[0].items).toEqual([line("二つ目の品", 1, null)]);
    expect(x.other_orders[0].total_amount.value).toBeNull();
  });

  it("reads a number past 2^53 as unknown instead of failing the schema check", async () => {
    const x = await read(reading({ relevance: "order", total_amount: amount(1e20), items: [line("品", 1e20, 1e20)] }));
    expect(x.total_amount.value).toBeNull();
    expect(x.items).toEqual([line("品", null, null)]);
  });

  it("keeps 0 and the largest value the columns hold; confidences are not whole numbers and stay", async () => {
    const x = await read(reading({ relevance: "order", total_amount: amount(INT_MAX), items: [line("無料の品", 0, 0)], overall_confidence: 0.85 }));
    expect(x.total_amount).toEqual(amount(INT_MAX));
    expect(x.items).toEqual([line("無料の品", 0, 0)]);
    expect(x.overall_confidence).toBe(0.85);
    expect((await read(reading({ total_amount: amount(INT_MAX + 1) }))).total_amount.value).toBeNull();
    expect((await read(reading({ total_amount: amount(-1) }))).total_amount.value).toBeNull();
  });

  it("gives every demo reading exactly what the schema check alone gave", async () => {
    const plain = zodOutputFormat(ExtractionSchema);
    const entries = await loadDemoEntries("2026-11-04", new Date("2026-11-04T03:00:00Z"));
    expect(entries.length).toBe(17);
    for (const { mail, extraction } of entries) {
      sdk.answer = JSON.stringify(extraction);
      const { data } = await extractEmail({ from: "a@example.test", subject: "件名", sentAt: null, body: "本文" });
      expect(data, mail.file).toEqual(plain.parse(sdk.answer));
    }
  });

  it("holds the model to the same JSON schema as before", async () => {
    await read(reading());
    expect(sdk.calls).toHaveLength(1);
    expect(JSON.stringify(sdk.calls[0].output_config)).toBe(JSON.stringify({ format: zodOutputFormat(ExtractionSchema), effort: "low" }));
  });
});

describe("a mail stating 合計 3,000,000,000円 goes through the webhook once", () => {
  it("is filed with no amount, and Resend's next delivery of it is a duplicate, not another paid read", async () => {
    sdk.answer = JSON.stringify(
      reading({ relevance: "order", order_number: sure("ORD-99990000"), items: [line("テスト商品", 1, null)], total_amount: amount(3_000_000_000, "合計 3,000,000,000円") }),
    );
    const db = new FakeDb();
    db.hooks.push(int4Guard);

    const first = await processInboundEmail(asAdmin(db), orderMail());
    expect(first.kind).toBe("processed");
    const parcels = db.rows("parcels").filter((p) => p.user_id === USER);
    expect(parcels).toHaveLength(1);
    // Shown as 金額なし, like a mail that states no amount.
    expect(parcels[0].total_amount).toBeNull();
    expect(db.rows("parcel_items")).toMatchObject([{ name: "テスト商品", quantity: 1, unit_price: null }]);
    expect((db.rows("extractions")[0].result as Extraction).total_amount).toEqual({ value: null, evidence: "合計 3,000,000,000円", confidence: 0.95 });
    expect(db.rows("emails")).toMatchObject([{ processing_status: "processed" }]);

    const again = await processInboundEmail(asAdmin(db), orderMail());
    expect(again.kind).toBe("duplicate");
    expect(sdk.calls).toHaveLength(1);
    expect(db.rpcCalls.filter((c) => c.name === "claim_claude_call")).toHaveLength(1);
  });

  it("writes item prices and counts the columns can hold", async () => {
    sdk.answer = JSON.stringify(reading({ relevance: "order", order_number: sure("ORD-99990000"), items: [line("高い品", 1, 3_000_000_000), line("多い品", 5_000_000_000, 100)] }));
    const db = new FakeDb();
    db.hooks.push(int4Guard);
    expect((await processInboundEmail(asAdmin(db), orderMail())).kind).toBe("processed");
    expect(db.rows("parcel_items")).toMatchObject([
      { name: "高い品", quantity: 1, unit_price: null },
      { name: "多い品", quantity: null, unit_price: 100 },
    ]);
    expect(db.rows("parcels")[0].total_amount).toBeNull();
  });

  it("control: a normal amount is filed as it was read", async () => {
    sdk.answer = JSON.stringify(reading({ relevance: "order", order_number: sure("ORD-99990000"), items: [line("テスト商品", 2, 1200)], total_amount: amount(3000) }));
    const db = new FakeDb();
    db.hooks.push(int4Guard);
    expect((await processInboundEmail(asAdmin(db), orderMail())).kind).toBe("processed");
    expect(db.rows("parcels")[0].total_amount).toBe(3000);
    expect(db.rows("parcel_items")).toMatchObject([{ name: "テスト商品", quantity: 2, unit_price: 1200 }]);
  });
});

describe("parcelTotal never gives more than the column holds", () => {
  const money = (value: number, confidence = 0.95) => ({ value, evidence: "合計", confidence });

  it("does not count an item list whose prices add up past it", () => {
    expect(parcelTotal([reading({ relevance: "order", items: [line("A", 1, 1_500_000_000), line("B", 1, 1_500_000_000)] })])).toBeNull();
    expect(parcelTotal([reading({ relevance: "order", items: [line("A", 2, 2_000_000_000)] })])).toBeNull();
    // An unsure stated total is then what is known.
    expect(parcelTotal([reading({ relevance: "order", total_amount: money(3000, 0.7), items: [line("A", 2, 2_000_000_000)] })])).toBe(3000);
  });

  it("is unknown when shipments add up past it", () => {
    expect(parcelTotal([reading({ relevance: "shipped", total_amount: money(1_500_000_000) }), reading({ relevance: "shipped", total_amount: money(1_600_000_000) })])).toBeNull();
  });

  it("ignores an amount past it in a reading saved before amounts were bounded", () => {
    const saved = reading({ relevance: "order", total_amount: money(3_000_000_000) });
    expect(parcelTotal([saved])).toBeNull();
    expect(parcelTotal([saved, reading({ relevance: "shipped", total_amount: money(2750) })])).toBe(2750);
  });

  it("keeps the largest amount it holds", () => {
    expect(parcelTotal([reading({ relevance: "shipped", total_amount: money(INT_MAX) })])).toBe(INT_MAX);
  });
});
