import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractCallCeilingUsd, MAX_EVAL_CONCURRENCY, parseEvalLimits, runWithinBudget } from "@/lib/eval-budget";

/**
 * The spending limit of `npm run eval`, with made-up calls and made-up amounts (no API, no real price):
 * - every call reserves its most before it is sent, from one budget shared by all workers; what is reserved and running
 *   never passes the budget, however many workers there are;
 * - a failed call keeps its reservation and stops new calls;
 * - a budget, a worker count or a limit that is not a plain positive number stops the run before any call;
 * - a run with enough budget, or with budget left after the running calls settle, reads every mail.
 */

type Gate = { resolve: (cost: number) => void; reject: (error: Error) => void };

/** Calls that stay open until the test answers them, so several are really running at once. */
function heldCalls() {
  const open: Gate[] = [];
  let running = 0;
  let maxRunning = 0;
  let calls = 0;
  const call = (item: number) => {
    calls++;
    running++;
    maxRunning = Math.max(maxRunning, running);
    return new Promise<{ result: number; costUsd: number }>((resolve, reject) => {
      open.push({
        resolve: (cost) => { running--; resolve({ result: item, costUsd: cost }); },
        reject: (error) => { running--; reject(error); },
      });
    });
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return { open, call, tick, stats: () => ({ calls, running, maxRunning }) };
}

const eight = Array.from({ length: 8 }, (_, i) => i);
const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

describe("parseEvalLimits", () => {
  it.each(["1", "0.30", "15", ".5", "20"])("accepts --max-usd %s", (maxUsd) => {
    expect(parseEvalLimits({ maxUsd, concurrency: "4", limit: "0" }).maxUsd).toBe(Number(maxUsd));
  });

  it.each(["not-a-number", "NaN", "0", "-1", "Infinity", "1e3", "", "0x10", " 1", undefined])("refuses --max-usd %s before any call", (maxUsd) => {
    expect(() => parseEvalLimits({ maxUsd, concurrency: "4", limit: "0" })).toThrow(/--max-usd/);
  });

  it.each(["0", String(MAX_EVAL_CONCURRENCY + 1), "2.5", "x", "", "-1", undefined])("refuses --concurrency %s", (concurrency) => {
    expect(() => parseEvalLimits({ maxUsd: "1", concurrency, limit: "0" })).toThrow(/--concurrency/);
  });

  it.each(["-1", "1.5", "all", undefined])("refuses --limit %s", (limit) => {
    expect(() => parseEvalLimits({ maxUsd: "1", concurrency: "4", limit })).toThrow(/--limit/);
  });

  it("keeps the documented defaults and the range ends", () => {
    expect(parseEvalLimits({ maxUsd: "1", concurrency: "4", limit: "0" })).toEqual({ maxUsd: 1, concurrency: 4, limit: 0 });
    expect(parseEvalLimits({ maxUsd: "1", concurrency: "1", limit: "3" }).concurrency).toBe(1);
    expect(parseEvalLimits({ maxUsd: "1", concurrency: String(MAX_EVAL_CONCURRENCY), limit: "3" }).concurrency).toBe(MAX_EVAL_CONCURRENCY);
  });
});

describe("extractCallCeilingUsd", () => {
  it("counts every UTF-8 byte at the dearest input rate, plus the whole max_tokens of output", () => {
    // Made-up rates: input 1, output 10, cache read 0.5, cache write 2 (per million).
    const price = [1, 10, 0.5, 2] as const;
    const text = "あいう" + "abc"; // 9 + 3 bytes
    near(extractCallCeilingUsd(text, 100, price), (12 * 2 + 100 * 10) / 1_000_000);
    near(extractCallCeilingUsd("", 0, price), 0);
  });

  it("is tied to the real extraction call's max_tokens and request text", () => {
    const src = readFileSync(path.resolve(__dirname, "../extract/extract.ts"), "utf8");
    expect(src).toContain("max_tokens: EXTRACT_MAX_TOKENS,");
    expect(src).not.toMatch(/max_tokens:\s*\d/);
    const script = readFileSync(path.resolve(__dirname, "../../../scripts/eval.ts"), "utf8");
    expect(script).toContain("extractCallCeilingUsd(extractRequestText(asPrompt(mail)), EXTRACT_MAX_TOKENS, price)");
    expect(script).toContain("parseEvalLimits(");
    expect(script).toContain("runWithinBudget(");
    // The old per-worker check that compared only settled spending is gone.
    expect(script).not.toMatch(/Number\(opt\(/);
    expect(script).not.toMatch(/spent >= maxUsd/);
  });
});

describe("runWithinBudget", () => {
  it("a budget below one call's most starts nothing (4 workers)", async () => {
    const h = heldCalls();
    const run = await runWithinBudget({ items: eight, concurrency: 4, maxUsd: 0.01, ceilingUsd: () => 1, call: h.call });
    expect(h.stats().calls).toBe(0);
    expect(run).toMatchObject({ started: 0, stopped: "budget", spentUsd: 0 });
  });

  it("what is reserved and running never passes the budget, and the last call that does not fit is never sent", async () => {
    const h = heldCalls();
    const done = runWithinBudget({ items: eight, concurrency: 4, maxUsd: 3.5, ceilingUsd: () => 1, call: h.call });
    await h.tick();
    // Three fit in 3.5; the fourth worker waits instead of starting.
    expect(h.stats()).toMatchObject({ calls: 3, running: 3 });
    for (const gate of h.open.splice(0)) gate.resolve(1);
    const run = await done;
    expect(h.stats().maxRunning).toBe(3);
    expect(h.stats().calls).toBe(3);
    expect(run.stopped).toBe("budget");
    near(run.spentUsd, 3);
  });

  it("all calls failing with an unknown charge: only the reserved ones are sent, they stay counted, nothing more starts", async () => {
    const h = heldCalls();
    const done = runWithinBudget({ items: eight, concurrency: 4, maxUsd: 2.5, ceilingUsd: () => 1, call: h.call });
    await h.tick();
    expect(h.stats().calls).toBe(2);
    for (const gate of h.open.splice(0)) gate.reject(new Error("made-up lost answer"));
    const run = await done;
    expect(h.stats().calls).toBe(2);
    expect(run).toMatchObject({ started: 2, stopped: "failed" });
    expect(run.failed).toHaveLength(2);
    near(run.spentUsd, 2);
    near(run.unknownUsd, 2);
  });

  it("one failure among running calls lets the others finish but starts no new call", async () => {
    const h = heldCalls();
    const done = runWithinBudget({ items: eight, concurrency: 4, maxUsd: 20, ceilingUsd: () => 1, call: h.call });
    await h.tick();
    expect(h.stats().calls).toBe(4);
    const [first, ...rest] = h.open.splice(0);
    first.reject(new Error("made-up lost answer"));
    await h.tick();
    for (const gate of rest) gate.resolve(0.25);
    const run = await done;
    expect(h.stats().calls).toBe(4);
    expect(run.done).toHaveLength(3);
    expect(run.failed).toHaveLength(1);
    expect(run.stopped).toBe("failed");
    near(run.spentUsd, 1 + 0.75);
    near(run.unknownUsd, 1);
  });

  it("an answer whose cost cannot be read keeps its reservation and stops new calls", async () => {
    const run = await runWithinBudget({ items: eight, concurrency: 1, maxUsd: 20, ceilingUsd: () => 1, call: async (i) => ({ result: i, costUsd: Number.NaN }) });
    expect(run).toMatchObject({ started: 1, stopped: "failed" });
    near(run.unknownUsd, 1);
  });

  it("a call that cost more than its most stops the run", async () => {
    const run = await runWithinBudget({ items: eight, concurrency: 1, maxUsd: 20, ceilingUsd: () => 1, call: async (i) => ({ result: i, costUsd: 1.5 }) });
    expect(run).toMatchObject({ started: 1, stopped: "over_ceiling" });
  });

  it("refuses a bad budget, worker count or ceiling before any call", async () => {
    const h = heldCalls();
    await expect(runWithinBudget({ items: eight, concurrency: 4, maxUsd: Number.NaN, ceilingUsd: () => 1, call: h.call })).rejects.toThrow();
    await expect(runWithinBudget({ items: eight, concurrency: 0, maxUsd: 1, ceilingUsd: () => 1, call: h.call })).rejects.toThrow();
    await expect(runWithinBudget({ items: eight, concurrency: 4, maxUsd: 1, ceilingUsd: () => Number.NaN, call: h.call })).rejects.toThrow();
    expect(h.stats().calls).toBe(0);
  });

  it("enough budget reads every mail (4 workers), and spent is the real cost", async () => {
    const run = await runWithinBudget({ items: eight, concurrency: 4, maxUsd: 20, ceilingUsd: () => 1, call: async (i) => ({ result: i, costUsd: 1 }) });
    expect(run).toMatchObject({ started: 8, stopped: null, unknownUsd: 0 });
    expect(run.done.map((d) => d.result).sort()).toEqual(eight);
    near(run.spentUsd, 8);
  });

  it("budget left after the running calls settle lets the rest go on one at a time", async () => {
    // Most 0.3 each, real 0.01 each, budget 0.59: two never fit at once, one always fits after the last settled; all eight for 0.08.
    const h = heldCalls();
    const done = runWithinBudget({ items: eight, concurrency: 4, maxUsd: 0.59, ceilingUsd: () => 0.3, call: h.call });
    for (let i = 0; i < 8; i++) {
      await h.tick();
      expect(h.stats().running).toBe(1);
      h.open.shift()!.resolve(0.01);
    }
    const run = await done;
    expect(h.stats().maxRunning).toBe(1);
    expect(run).toMatchObject({ started: 8, stopped: null });
    near(run.spentUsd, 0.08);
  });

  it("right at the edge: reservations that sum exactly to the budget all start, one more does not", async () => {
    const h = heldCalls();
    const done = runWithinBudget({ items: eight, concurrency: 8, maxUsd: 0.6 + 0.4, ceilingUsd: (i) => (i < 2 ? [0.6, 0.4][i] : 0.1), call: h.call });
    await h.tick();
    expect(h.stats().calls).toBe(2);
    const [a, b] = h.open.splice(0);
    a.resolve(0.6);
    b.resolve(0.4);
    // 1.0 spent of 1.0: the 0.1 call cannot fit and nothing is running.
    const run = await done;
    expect(run).toMatchObject({ started: 2, stopped: "budget" });
  });
});
