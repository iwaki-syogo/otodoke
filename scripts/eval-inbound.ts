/**
 * Scoring for the sender-side `inbound` reading, kept apart from scripts/eval.ts so a test can import it
 * (eval.ts calls the paid API when it runs). Pure: no file, network or API access.
 *
 * Every reading is passed through withDefaults and verifyEvidence first, exactly as the pipeline does before it
 * uses a reading: a false whose quotation is not in the mail becomes null there, so it must not count as a hit here.
 *
 * `inbound-labels.json` lists three kinds of mail:
 *   - "false":     the reader sent the parcel. A hit needs inbound=false with confidence >= MIN_CONFIDENCE
 *                  AND no tracking number in the verified reading (so no parcel can open from it).
 *   - "not_false": the parcel comes to the reader. A hit is anything but inbound=false (true and null both count).
 *   - "either":    a reading of false or not-false is both fair. Shown in the table, never counted.
 */
import { withDefaults, type Extraction } from "../src/lib/extract/schema";
import { verifyEvidence } from "../src/lib/extract/verify-evidence";

/** The confidence the matching code needs before it acts on a field (src/lib/match/index.ts MIN_CONFIDENCE). */
export const INBOUND_MIN_CONFIDENCE = 0.6;

export interface InboundLabels {
  false: Record<string, string>;
  not_false: Record<string, string>;
  either?: Record<string, string>;
}

/** The mail a reading came from: what the quotations are checked against. */
export interface InboundMail {
  subject: string;
  text: string | null;
  html: string | null;
}

export interface InboundResult {
  file: string;
  mail: InboundMail;
  /** The model's answer as saved; null when the mail was not read or its reading failed. */
  data: Extraction | null;
  error?: string;
}

export interface InboundRow {
  file: string;
  kind: "false" | "not_false" | "either";
  note: string;
  /** Either-mails are never counted; their ok is always true. */
  counted: boolean;
  ok: boolean;
  /** What went wrong (or, for an either-mail, what it was read as); empty for a plain hit. */
  miss: string;
}

export interface InboundScore {
  rows: InboundRow[];
  hit: number;
  total: number;
}

function describeInbound(value: boolean | null, confidence: number): string {
  return `inbound=${value === null ? "null" : String(value)} (confidence ${confidence})`;
}

function judge(kind: "false" | "not_false" | "either", result: InboundResult | undefined): { ok: boolean; miss: string } {
  if (!result) return { ok: false, miss: "not read" };
  if (result.error || !result.data) return { ok: false, miss: `reading failed${result.error ? `: ${result.error}` : ""}` };
  const raw = withDefaults(result.data);
  const x = verifyEvidence(raw, result.mail);
  const value = x.inbound.value ?? null;
  const confidence = x.inbound.confidence ?? 0;
  // A false the check turned into null is reported as such, so the model's answer and the quotation can be told apart.
  const dropped = raw.inbound.value === false && value === null ? " (the false was dropped: its quotation is not in the mail, or its confidence is under 0.6)" : "";
  if (kind === "either") return { ok: true, miss: describeInbound(value, confidence) + dropped };
  if (kind === "not_false") return value === false ? { ok: false, miss: describeInbound(value, confidence) } : { ok: true, miss: "" };
  const problems: string[] = [];
  if (value !== false) problems.push(`inbound=${value === null ? "null" : String(value)}${dropped}`);
  else if (!(confidence >= INBOUND_MIN_CONFIDENCE)) problems.push(`inbound=false but confidence ${confidence} < ${INBOUND_MIN_CONFIDENCE}`);
  const tracking = x.tracking_number.value;
  if (tracking !== null && tracking !== undefined && tracking !== "") problems.push(`tracking_number kept (${tracking})`);
  return problems.length === 0 ? { ok: true, miss: "" } : { ok: false, miss: problems.join("; ") };
}

export function scoreInbound(labels: InboundLabels, results: InboundResult[]): InboundScore {
  const byFile = new Map(results.map((r) => [r.file, r]));
  const rows: InboundRow[] = [];
  for (const kind of ["false", "not_false", "either"] as const) {
    for (const [file, note] of Object.entries(labels[kind] ?? {})) rows.push({ file, kind, note, counted: kind !== "either", ...judge(kind, byFile.get(file)) });
  }
  const counted = rows.filter((r) => r.counted);
  return { rows, hit: counted.filter((r) => r.ok).length, total: counted.length };
}

/** A table of the misses, one line per mail: file, kind, what missed; then the mails that are not counted. */
export function missTable(score: InboundScore): string {
  const misses = score.rows.filter((r) => r.counted && !r.ok);
  const lines = misses.length === 0 ? ["inbound: no misses"] : ["inbound misses (file | kind | what):", ...misses.map((r) => `  ${r.file} | ${r.kind} | ${r.miss}  [${r.note}]`)];
  const either = score.rows.filter((r) => !r.counted);
  if (either.length > 0) lines.push("not counted (either reading is fair) (file | read as):", ...either.map((r) => `  ${r.file} | ${r.miss || "-"}  [${r.note}]`));
  return lines.join("\n");
}
