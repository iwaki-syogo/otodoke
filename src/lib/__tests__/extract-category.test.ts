import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CATEGORIES, categoryLabel, isCategory } from "@/lib/category";
import { loadDemoEntries } from "@/lib/demo";
import { EXTRACT_SYSTEM_PROMPT } from "@/lib/extract/prompt";
import { ExtractionSchema, OtherOrderSchema, withDefaults, type Extraction } from "@/lib/extract/schema";
import { splitOrders } from "@/lib/match";
import { reading, sure } from "./pipeline-fixtures";

/** The Claude client is replaced: these tests never call the API. */
const sdk = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  answer: null as unknown,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = {
      parse: async (args: Record<string, unknown>) => {
        sdk.calls.push(args);
        return sdk.answer;
      },
    };
  },
}));

vi.mock("@/lib/env", () => ({
  env: () => ({ OTODOKE_MODEL: "test-model", OTODOKE_EXTRACT_EFFORT: "low" }),
  requireEnv: () => "test-key",
}));

const { extractEmail } = await import("@/lib/extract/extract");

const otherOrder = (over: Record<string, unknown> = {}) => ({
  order_number: sure("ORD-22222222"),
  items: [{ name: "二つ目の注文の商品", quantity: 1, unit_price: 800, evidence: null }],
  total_amount: sure(800),
  expected_date: sure("2026-11-08"),
  expected_date_end: { value: null, evidence: null, confidence: 0 },
  expected_text: null,
  ...over,
});

describe("schema: category", () => {
  it("is part of a reading and of each other order, with the seven keys from src/lib/category.ts or null", () => {
    for (const schema of [ExtractionSchema, OtherOrderSchema]) {
      const field = (schema.shape as Record<string, unknown>).category;
      expect(field, "category field").toBeDefined();
    }
    for (const c of CATEGORIES) {
      expect(ExtractionSchema.safeParse({ ...reading(), category: c }).success, c).toBe(true);
      expect(OtherOrderSchema.safeParse({ ...otherOrder(), category: c }).success, c).toBe(true);
    }
    expect(ExtractionSchema.safeParse({ ...reading(), category: null }).success).toBe(true);
    expect(ExtractionSchema.safeParse({ ...reading(), category: "toys" }).success).toBe(false);
    expect(OtherOrderSchema.safeParse({ ...otherOrder(), category: "toys" }).success).toBe(false);
  });

  it("takes the keys from src/lib/category.ts instead of writing them again", () => {
    const source = readFileSync(path.resolve(__dirname, "../extract/schema.ts"), "utf8");
    expect(source).toMatch(/from\s+["']@\/lib\/category["']/);
    expect(source).not.toMatch(/["']electronics["']/);
  });

  it("stays usable as a structured output: no pattern or length limits on category", () => {
    const js = z.toJSONSchema(ExtractionSchema) as { properties: Record<string, unknown> };
    expect(js.properties.category).toBeDefined();
    expect(JSON.stringify(js.properties.category)).not.toMatch(/"pattern"|"minLength"|"maxLength"/);
  });
});

describe("withDefaults: readings saved before category existed", () => {
  it("fills a missing category with null", () => {
    const old = reading();
    delete (old as Partial<Extraction> & { category?: unknown }).category;
    expect(withDefaults(old)).toHaveProperty("category", null);
  });

  it("fills a missing category inside other_orders with null", () => {
    const old = reading({ other_orders: [otherOrder() as unknown as Extraction["other_orders"][number]] });
    delete (old as Partial<Extraction> & { category?: unknown }).category;
    const filled = withDefaults(old);
    expect(filled.other_orders).toHaveLength(1);
    expect(filled.other_orders[0]).toHaveProperty("category", null);
  });

  it("keeps a category that is there", () => {
    expect(withDefaults(reading({ category: "beauty" }))).toHaveProperty("category", "beauty");
  });
});

describe("extractEmail: a refusal answers with no category, in one call", () => {
  it("returns category null for a declined mail", async () => {
    sdk.calls.length = 0;
    sdk.answer = { stop_reason: "refusal", parsed_output: null, usage: { input_tokens: 10, output_tokens: 1 } };
    const result = await extractEmail({ from: "a@example.test", subject: "件名", sentAt: null, body: "本文" });
    expect(result.refused).toBe(true);
    expect(result.data).toHaveProperty("category", null);
    expect(sdk.calls).toHaveLength(1);
  });

  it("still makes exactly one call with the same model and max_tokens", async () => {
    sdk.calls.length = 0;
    sdk.answer = { stop_reason: "end_turn", parsed_output: reading({ category: "food" }), usage: { input_tokens: 10, output_tokens: 1 } };
    const result = await extractEmail({ from: "a@example.test", subject: "件名", sentAt: null, body: "本文" });
    expect(result.data).toHaveProperty("category", "food");
    expect(sdk.calls).toHaveLength(1);
    expect(sdk.calls[0].model).toBe("test-model");
    expect(sdk.calls[0].max_tokens).toBe(16000);
  });
});

describe("splitOrders: each order keeps its own category", () => {
  it("gives the second order its own category, not the first order's", () => {
    const x = reading({
      relevance: "order",
      order_number: sure("ORD-11111111"),
      category: "electronics",
      other_orders: [otherOrder({ category: "food" }) as unknown as Extraction["other_orders"][number]],
    });
    const [first, second] = splitOrders(x);
    expect(first).toHaveProperty("category", "electronics");
    expect(second).toHaveProperty("category", "food");
  });

  it("leaves the second order uncategorised when it has no category", () => {
    const x = reading({
      relevance: "order",
      order_number: sure("ORD-11111111"),
      category: "electronics",
      other_orders: [otherOrder({ category: null }) as unknown as Extraction["other_orders"][number]],
    });
    expect(splitOrders(x)[1]).toHaveProperty("category", null);
  });
});

describe("prompt: a short section on the category", () => {
  const section = EXTRACT_SYSTEM_PROMPT.split(/\n(?=## )/).find((s) => /^## .*分類/.test(s)) ?? "";

  it("has a section about the category", () => {
    expect(section).not.toBe("");
  });

  it("names all seven categories", () => {
    for (const c of CATEGORIES) expect(section, c).toContain(categoryLabel(c));
  });

  it("says a notice naming neither item nor shop gets null", () => {
    expect(section).toContain("null");
    expect(section).toMatch(/運送会社/);
  });
});

describe("demo cache", () => {
  it("gives every demo reading a category key that is one of the seven or null", async () => {
    const entries = await loadDemoEntries("2026-11-04", new Date("2026-11-04T03:00:00Z"));
    expect(entries.length).toBeGreaterThan(0);
    for (const { mail, extraction } of entries) {
      expect(extraction, mail.file).toHaveProperty("category");
      const c = (extraction as Extraction & { category: unknown }).category;
      expect(c === null || isCategory(c), `${mail.file}: ${String(c)}`).toBe(true);
    }
  });
});
