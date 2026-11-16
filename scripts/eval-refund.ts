/**
 * Scoring for the refund and cancellation reading, kept apart from scripts/eval.ts so a test can import it
 * (eval.ts calls the paid API when it runs). Pure: no file, network or API access.
 *
 * Every reading is passed through withDefaults and verifyEvidence first, exactly as the pipeline does before it
 * uses a reading: a `cancel_partial: true` whose quotation is not in the mail becomes null there, so it must not
 * count as a hit here.
 *
 * `refund-labels.json` lists two kinds of mail:
 *   - "no_cancel": the mail must not cancel the parcel. A hit is relevance other than `cancelled`,
 *                  or `cancelled` with a confident `cancel_partial: true` (the pipeline then moves nothing).
 *   - "cancel":    an order cancelled as a whole. A hit is relevance `cancelled` with `cancel_partial` not a
 *                  confident true.
 */
import { withDefaults, type Extraction } from "../src/lib/extract/schema";
import { verifyEvidence } from "../src/lib/extract/verify-evidence";

/** The confidence the matching code needs before it acts on a field (src/lib/match/index.ts MIN_CONFIDENCE). */
export const REFUND_MIN_CONFIDENCE = 0.6;

export interface RefundLabels {
  no_cancel: Record<string, string>;
  cancel: Record<string, string>;
}

/** The mail a reading came from: what the quotations are checked against. */
export interface RefundMail {
  subject: string;
  text: string | null;
  html: string | null;
}

export interface RefundResult {
  file: string;
  mail: RefundMail;
  /** The model's answer as saved; null when the mail was not read or its reading failed. */
  data: Extraction | null;
  error?: string;
}

export interface RefundRow {
  file: string;
  kind: "no_cancel" | "cancel";
  note: string;
  ok: boolean;
  /** What went wrong; empty for a hit. */
  miss: string;
}

export interface RefundScore {
  rows: RefundRow[];
  hit: number;
  total: number;
}

function judge(kind: "no_cancel" | "cancel", result: RefundResult | undefined): { ok: boolean; miss: string } {
  if (!result) return { ok: false, miss: "not read" };
  if (result.error || !result.data) return { ok: false, miss: `reading failed${result.error ? `: ${result.error}` : ""}` };
  const raw = withDefaults(result.data);
  const x = verifyEvidence(raw, result.mail);
  const partial = x.cancel_partial.value === true && (x.cancel_partial.confidence ?? 0) >= REFUND_MIN_CONFIDENCE;
  const seen = `relevance=${x.relevance} cancel_partial=${x.cancel_partial.value === null ? "null" : String(x.cancel_partial.value)}`;
  // A true the check turned into null is reported as such, so the model's answer and the quotation can be told apart.
  const dropped = raw.cancel_partial.value === true && x.cancel_partial.value === null ? " (the true was dropped: its quotation is not in the mail)" : "";
  if (kind === "no_cancel") return x.relevance !== "cancelled" || partial ? { ok: true, miss: "" } : { ok: false, miss: seen + dropped };
  return x.relevance === "cancelled" && !partial ? { ok: true, miss: "" } : { ok: false, miss: seen + dropped };
}

export function scoreRefund(labels: RefundLabels, results: RefundResult[]): RefundScore {
  const byFile = new Map(results.map((r) => [r.file, r]));
  const rows: RefundRow[] = [];
  for (const kind of ["no_cancel", "cancel"] as const) {
    for (const [file, note] of Object.entries(labels[kind] ?? {})) rows.push({ file, kind, note, ...judge(kind, byFile.get(file)) });
  }
  return { rows, hit: rows.filter((r) => r.ok).length, total: rows.length };
}

/** A table of the misses, one line per mail: file, kind, what missed. */
export function refundMissTable(score: RefundScore): string {
  const misses = score.rows.filter((r) => !r.ok);
  return misses.length === 0 ? "refund: no misses" : ["refund misses (file | kind | what):", ...misses.map((r) => `  ${r.file} | ${r.kind} | ${r.miss}  [${r.note}]`)].join("\n");
}
