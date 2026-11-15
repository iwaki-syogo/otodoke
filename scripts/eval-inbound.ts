/**
 * Scoring for the sender-side `inbound` reading, kept apart from scripts/eval.ts so a test can import it
 * (eval.ts calls the paid API when it runs). Pure: no file, network or API access.
 *
 * `inbound-labels.json` lists two kinds of mail:
 *   - "false":     the reader sent the parcel. A hit needs inbound=false with confidence >= MIN_CONFIDENCE
 *                  AND no tracking number in the reading (so no parcel can open from it).
 *   - "not_false": the parcel comes to the reader. A hit is anything but inbound=false (true and null both count).
 */

/** The confidence the matching code needs before it acts on a field (src/lib/match/index.ts MIN_CONFIDENCE). */
export const INBOUND_MIN_CONFIDENCE = 0.6;

export interface InboundLabels {
  false: Record<string, string>;
  not_false: Record<string, string>;
}

/** The part of one saved reading that this scoring looks at. */
export interface InboundReading {
  inbound?: { value: boolean | null; confidence: number } | null;
  tracking_number?: { value: string | null } | null;
}

export interface InboundResult {
  file: string;
  /** null when the mail was not read or its reading failed. */
  data: InboundReading | null;
  error?: string;
}

export interface InboundRow {
  file: string;
  kind: "false" | "not_false";
  note: string;
  ok: boolean;
  /** What went wrong; empty for a hit. */
  miss: string;
}

export interface InboundScore {
  rows: InboundRow[];
  hit: number;
  total: number;
}

function judge(kind: "false" | "not_false", result: InboundResult | undefined): { ok: boolean; miss: string } {
  if (!result) return { ok: false, miss: "not read" };
  if (result.error || !result.data) return { ok: false, miss: `reading failed${result.error ? `: ${result.error}` : ""}` };
  const value = result.data.inbound?.value ?? null;
  const confidence = result.data.inbound?.confidence ?? 0;
  if (kind === "not_false") return value === false ? { ok: false, miss: `inbound=false (confidence ${confidence})` } : { ok: true, miss: "" };
  const problems: string[] = [];
  if (value !== false) problems.push(`inbound=${value === null ? "null" : String(value)}`);
  else if (!(confidence >= INBOUND_MIN_CONFIDENCE)) problems.push(`inbound=false but confidence ${confidence} < ${INBOUND_MIN_CONFIDENCE}`);
  const tracking = result.data.tracking_number?.value;
  if (tracking !== null && tracking !== undefined && tracking !== "") problems.push(`tracking_number kept (${tracking})`);
  return problems.length === 0 ? { ok: true, miss: "" } : { ok: false, miss: problems.join("; ") };
}

export function scoreInbound(labels: InboundLabels, results: InboundResult[]): InboundScore {
  const byFile = new Map(results.map((r) => [r.file, r]));
  const rows: InboundRow[] = [];
  for (const kind of ["false", "not_false"] as const) {
    for (const [file, note] of Object.entries(labels[kind])) rows.push({ file, kind, note, ...judge(kind, byFile.get(file)) });
  }
  return { rows, hit: rows.filter((r) => r.ok).length, total: rows.length };
}

/** A table of the misses, one line per mail: file, kind, what missed. */
export function missTable(score: InboundScore): string {
  const misses = score.rows.filter((r) => !r.ok);
  if (misses.length === 0) return "inbound: no misses";
  return ["inbound misses (file | kind | what):", ...misses.map((r) => `  ${r.file} | ${r.kind} | ${r.miss}  [${r.note}]`)].join("\n");
}
