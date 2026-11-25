import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STRUCTURED_OUTPUT_ALLOWANCE_TOKENS, extractCallCeilingUsd, priceCardFor, priceForPrompt, usageCostUsd } from "@/lib/eval-budget";
import { LONG_PROMPT_PRICES, PRICES } from "../../../scripts/prices";

/**
 * The rate card a paid script reserves and settles with follows the prompt's length (scripts/prices.ts): Claude Haiku
 * 5.5 has a dearer card above a 100,000-token prompt, where the prompt is every input token (plain, cache read and cache
 * write). Before, every length was reserved and settled at the cheaper card, so a long prompt was under-counted.
 * Synthetic usage only; no API.
 */

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-12);
const haiku = priceCardFor("claude-haiku-5-5", PRICES, LONG_PROMPT_PRICES)!;
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite,
});

describe("Claude Haiku 5.5's two cards", () => {
  it("keeps the shared base card, and the long card is five times it", () => {
    expect(haiku.base).toEqual([0.1, 0.5, 0.01, 0.125]);
    expect(haiku.long).toEqual({ abovePromptTokens: 100_000, price: [0.5, 2.5, 0.05, 0.625] });
  });

  it("settles a prompt of exactly 100,000 tokens at the base card", () => {
    near(usageCostUsd(haiku, usage(100_000, 16_000)), (100_000 * 0.1 + 16_000 * 0.5) / 1_000_000);
    near(usageCostUsd(haiku, usage(99_999, 16_000)), (99_999 * 0.1 + 16_000 * 0.5) / 1_000_000);
  });

  it("settles a prompt of 100,001 tokens at the long card, output included", () => {
    near(usageCostUsd(haiku, usage(100_001, 16_000)), (100_001 * 0.5 + 16_000 * 2.5) / 1_000_000);
  });

  it("counts cache reads and writes into the prompt's length, each at its own long rate", () => {
    near(usageCostUsd(haiku, usage(60_000, 1_000, 30_000, 10_001)), (60_000 * 0.5 + 1_000 * 2.5 + 30_000 * 0.05 + 10_001 * 0.625) / 1_000_000);
    near(usageCostUsd(haiku, usage(60_000, 1_000, 30_000, 10_000)), (60_000 * 0.1 + 1_000 * 0.5 + 30_000 * 0.01 + 10_000 * 0.125) / 1_000_000);
  });

  it("answers NaN for usage it cannot read (the budget then stops new calls)", () => {
    expect(usageCostUsd(haiku, { input_tokens: Number.NaN, output_tokens: 1 })).toBeNaN();
    expect(usageCostUsd(haiku, { input_tokens: -1, output_tokens: 1 })).toBeNaN();
  });

  it("picks the card from the prompt's length", () => {
    expect(priceForPrompt(haiku, 100_000)).toBe(haiku.base);
    expect(priceForPrompt(haiku, 100_001)).toBe(haiku.long!.price);
  });
});

describe("the reservation before a call", () => {
  const allowance = STRUCTURED_OUTPUT_ALLOWANCE_TOKENS;

  it("stays on the base card while every byte sent plus the structured-output allowance fits in 100,000", () => {
    const text = "a".repeat(100_000 - allowance);
    near(extractCallCeilingUsd(text, 16_000, haiku), ((100_000) * 0.125 + 16_000 * 0.5) / 1_000_000);
  });

  it("moves to the long card one byte later, at its dearest input rate and its output rate", () => {
    const text = "a".repeat(100_001 - allowance);
    near(extractCallCeilingUsd(text, 16_000, haiku), (100_001 * 0.625 + 16_000 * 2.5) / 1_000_000);
  });

  it("is never below the long-card settlement of a long call that used every byte and max_tokens", () => {
    const text = "あ".repeat(150_000);
    const reserved = extractCallCeilingUsd(text, 16_000, haiku);
    // Any real usage of this call has at most bytes + allowance prompt tokens and 16,000 output tokens.
    const bytes = Buffer.byteLength(text, "utf8");
    for (const [input, read, write] of [[bytes + allowance, 0, 0], [0, bytes + allowance, 0], [0, 0, bytes + allowance], [bytes, allowance, 0]]) {
      expect(reserved).toBeGreaterThanOrEqual(usageCostUsd(haiku, usage(input, 16_000, read, write)));
    }
  });

  it("has one card for models without a long-prompt card (Sonnet 5.5, Opus 5.5)", () => {
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5"]) {
      const card = priceCardFor(model, PRICES, LONG_PROMPT_PRICES)!;
      expect(card.long).toBeUndefined();
      const [input, output, read, write] = PRICES[model];
      near(usageCostUsd(card, usage(500_000, 16_000, 1_000, 1_000)), (500_000 * input + 16_000 * output + 1_000 * read + 1_000 * write) / 1_000_000);
    }
    expect(priceCardFor("claude-unknown", PRICES, LONG_PROMPT_PRICES)).toBeNull();
  });
});

describe("the scripts use the cards", () => {
  it("eval.ts reserves and settles with the model's card", () => {
    const script = readFileSync(path.resolve(__dirname, "../../../scripts/eval.ts"), "utf8");
    expect(script).toContain("extractCallCeilingUsd(extractRequestText(asPrompt(mail)), EXTRACT_MAX_TOKENS, card)");
    expect(script).toContain("costUsd: usageCostUsd(card, r.usage)");
    expect(script).not.toMatch(/price\[\d\]/);
  });

  it("categorize.ts reserves and settles with the model's card", () => {
    const script = readFileSync(path.resolve(__dirname, "../../../scripts/categorize.ts"), "utf8");
    expect(script).toContain("usageCostUsd(card, response.usage)");
    expect(script).toContain("priceForPrompt(card,");
    expect(script).not.toMatch(/price\[\d\]/);
  });
});
