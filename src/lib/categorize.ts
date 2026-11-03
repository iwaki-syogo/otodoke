import { isCategory, type Category } from "@/lib/category";

/**
 * Pure parts of the one-off categorizer (scripts/categorize.ts): how parcels are grouped into
 * calls, which answers are trusted, and the spending limit kept before each call.
 */

/** Parcels sent in one call. */
export const BATCH_SIZE = 40;

/** Consecutive groups of at most `size`, in order. */
export function toBatches<T>(items: readonly T[], size = BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`batch size must be a positive integer, got ${size}`);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/**
 * The answers worth writing, by parcel id. An answer counts only when its id is in the batch,
 * the id is answered once, and the category is one of the seven. Each bad entry is dropped on
 * its own; anything that is not a list gives nothing. A dropped parcel stays uncategorised.
 */
export function acceptAnswers(batchIds: readonly string[], answers: unknown): Map<string, Category> {
  const accepted = new Map<string, Category>();
  if (!Array.isArray(answers)) return accepted;
  const inBatch = new Set(batchIds);
  const seen = new Map<string, number>();
  for (const a of answers) {
    const id = typeof a === "object" && a !== null ? (a as { id?: unknown }).id : undefined;
    if (typeof id === "string" && inBatch.has(id)) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const a of answers) {
    if (typeof a !== "object" || a === null) continue;
    const { id, category } = a as { id?: unknown; category?: unknown };
    if (typeof id !== "string" || seen.get(id) !== 1 || !isCategory(category)) continue;
    accepted.set(id, category);
  }
  return accepted;
}

/** USD per million tokens; the first two are input and output. */
export type TokenPrice = readonly [input: number, output: number, ...rest: number[]];

/**
 * What a call may cost at most, worked out before sending it: one input token per character
 * (Japanese runs below that, ASCII far below), plus the whole max_tokens as output.
 */
export function estimateCallUsd(call: { inputChars: number; maxTokens: number }, price: TokenPrice): number {
  return (Math.ceil(call.inputChars) * price[0] + call.maxTokens * price[1]) / 1_000_000;
}

export interface Budget {
  /** Counts `usd` as spent before a call. False, with nothing counted, when it would pass the limit. */
  reserve(usd: number): boolean;
  /** After a call that answered: swaps its reservation for the real cost. */
  settle(reservedUsd: number, actualUsd: number): void;
  spent(): number;
}

/**
 * The spending limit of one run. A failed call whose charge is unknown is never settled,
 * so its reservation stays counted.
 */
export function createBudget(maxUsd: number): Budget {
  let spent = 0;
  // Sums of decimal fractions land a hair above the limit (0.6 + 0.4).
  const slack = 1e-9;
  return {
    reserve(usd) {
      if (!(usd >= 0) || spent + usd > maxUsd + slack) return false;
      spent += usd;
      return true;
    },
    settle(reservedUsd, actualUsd) {
      spent += actualUsd - reservedUsd;
    },
    spent: () => spent,
  };
}

/** How many items from the front of a batch fit in what is left; 0 means send nothing. */
export function affordableCount<T>(items: readonly T[], estimate: (xs: T[]) => number, leftUsd: number): number {
  for (let n = items.length; n > 0; n--) {
    if (estimate(items.slice(0, n)) <= leftUsd) return n;
  }
  return 0;
}

export interface CategorizeArgs {
  user: string;
  apply: boolean;
  maxUsd: number | null;
}

/** `--user <email>` is required; a dry run unless `--apply`, which needs a positive `--max-usd`. */
export function parseCategorizeArgs(argv: readonly string[]): CategorizeArgs {
  let user: string | null = null;
  let apply = false;
  let dryRun = false;
  let maxUsdRaw: string | null = null;
  const valueAfter = (i: number, name: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${name} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user") user = valueAfter(i++, a).trim();
    else if (a === "--max-usd") maxUsdRaw = valueAfter(i++, a);
    else if (a === "--apply") apply = true;
    else if (a === "--dry-run") dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!user) throw new Error("--user <email> is required");
  if (apply && dryRun) throw new Error("choose --apply or --dry-run, not both");
  let maxUsd: number | null = null;
  if (maxUsdRaw !== null) {
    maxUsd = maxUsdRaw.trim() === "" ? NaN : Number(maxUsdRaw);
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Error(`--max-usd must be a positive number, got "${maxUsdRaw}"`);
  }
  if (apply && maxUsd === null) throw new Error("--apply needs --max-usd <usd>");
  return { user, apply, maxUsd };
}
