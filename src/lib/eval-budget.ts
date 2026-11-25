import { createBudget, type TokenPrice } from "@/lib/categorize";

/**
 * The spending limit of `npm run eval` (scripts/eval.ts), kept apart so it can be checked without the API.
 *
 * - Every call reserves what it may cost at most before it is sent, from one budget shared by all workers. A call that
 *   does not fit waits for a running one to finish; when none is running, nothing more is started.
 * - A call that answered swaps its reservation for its real cost. A call that failed keeps its reservation (it may have
 *   been billed) and stops new calls; the ones already running finish.
 */

export const MAX_EVAL_CONCURRENCY = 8;

export interface EvalLimits {
  maxUsd: number;
  concurrency: number;
  /** 0 = every mail. */
  limit: number;
}

const DECIMAL = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const WHOLE = /^\d+$/;

/** `--max-usd` a positive amount, `--concurrency` 1 to 8, `--limit` 0 or more. Anything else stops the run before any call. */
export function parseEvalLimits(raw: { maxUsd: string | undefined; concurrency: string | undefined; limit: string | undefined }): EvalLimits {
  const maxUsd = DECIMAL.test(raw.maxUsd ?? "") ? Number(raw.maxUsd) : NaN;
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error(`--max-usd must be a positive amount, got ${JSON.stringify(raw.maxUsd)}`);
  const concurrency = WHOLE.test(raw.concurrency ?? "") ? Number(raw.concurrency) : NaN;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_EVAL_CONCURRENCY) {
    throw new Error(`--concurrency must be a whole number from 1 to ${MAX_EVAL_CONCURRENCY}, got ${JSON.stringify(raw.concurrency)}`);
  }
  const limit = WHOLE.test(raw.limit ?? "") ? Number(raw.limit) : NaN;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`--limit must be a whole number, got ${JSON.stringify(raw.limit)}`);
  return { maxUsd, concurrency, limit };
}

/**
 * What one extraction call may cost at most: every UTF-8 byte of what is sent counted as a token (a token is never
 * shorter than a byte), at the dearest input rate (plain, cache read or cache write), plus the whole max_tokens as output.
 */
export function extractCallCeilingUsd(inputText: string, maxTokens: number, price: TokenPrice): number {
  const inputRate = Math.max(...price.slice(0, 1), ...price.slice(2));
  return (Buffer.byteLength(inputText, "utf8") * inputRate + maxTokens * price[1]) / 1_000_000;
}

export type EvalStop = "budget" | "failed" | "over_ceiling" | null;

export interface EvalRun<T, R> {
  done: Array<{ item: T; result: R }>;
  failed: Array<{ item: T; error: unknown }>;
  /** "budget": the next call did not fit. "failed": a call failed or its cost could not be read. "over_ceiling": a call cost more than it reserved. */
  stopped: EvalStop;
  /** Real costs of the calls that answered, plus the reservations of the calls that failed. */
  spentUsd: number;
  /** The reservations kept for failed calls: they may or may not have been billed. */
  unknownUsd: number;
  started: number;
}

export async function runWithinBudget<T, R>(opts: {
  items: readonly T[];
  concurrency: number;
  maxUsd: number;
  /** The most the call for this item may cost. */
  ceilingUsd: (item: T) => number;
  /** One paid call. `costUsd` is what it really cost, from the answer's usage. */
  call: (item: T) => Promise<{ result: R; costUsd: number }>;
  onSettled?: (state: { finished: number; spentUsd: number }) => void;
}): Promise<EvalRun<T, R>> {
  const { items, concurrency, maxUsd } = opts;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_EVAL_CONCURRENCY) throw new Error("concurrency out of range");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error("budget must be a positive amount");
  const budget = createBudget(maxUsd);
  const run: EvalRun<T, R> = { done: [], failed: [], stopped: null, spentUsd: 0, unknownUsd: 0, started: 0 };
  const running = new Set<Promise<void>>();
  let next = 0;

  const send = async (item: T, reserved: number) => {
    try {
      const { result, costUsd } = await opts.call(item);
      if (!Number.isFinite(costUsd) || costUsd < 0) {
        // An answer whose cost cannot be read is treated like a failed call: its reservation stays.
        run.unknownUsd += reserved;
        run.done.push({ item, result });
        run.stopped ??= "failed";
        return;
      }
      budget.settle(reserved, costUsd);
      run.done.push({ item, result });
      // The ceiling was wrong if a call cost more than it: stop rather than trust the next one.
      if (costUsd > reserved) run.stopped ??= "over_ceiling";
    } catch (error) {
      run.unknownUsd += reserved;
      run.failed.push({ item, error });
      run.stopped ??= "failed";
    } finally {
      opts.onSettled?.({ finished: run.done.length + run.failed.length, spentUsd: budget.spent() });
    }
  };

  while (next < items.length && run.stopped === null) {
    const item = items[next];
    const ceiling = opts.ceilingUsd(item);
    if (!Number.isFinite(ceiling) || ceiling < 0) throw new Error("a call's ceiling must be a finite amount");
    // Checked and counted in one synchronous step, so two workers can never both take the last of the budget.
    if (running.size < concurrency && budget.reserve(ceiling)) {
      next++;
      run.started++;
      const pending: Promise<void> = send(item, ceiling).finally(() => running.delete(pending));
      running.add(pending);
      continue;
    }
    if (running.size === 0) {
      run.stopped = "budget";
      break;
    }
    await Promise.race(running);
  }
  await Promise.all(running);
  run.spentUsd = budget.spent();
  return run;
}
