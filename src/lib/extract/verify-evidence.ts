import { withDefaults, type Extraction, type OtherOrder } from "./schema";
import { decodeEntities, emailBodyText, stripInvisible } from "@/lib/text/html-to-text";

type SourceMail = { subject: string; text?: string | null; html?: string | null; body?: string };
type Field = { value: unknown; evidence: string | null; confidence: number };

export const UNVERIFIED_UNRELATED_ERROR = "relevance_unverified";

/** After verification, an unsupported negative verdict must wait as mail, not become an order. */
export function hasUnverifiedUnrelatedVerdict(extraction: Extraction): boolean {
  return extraction.relevance === "unrelated" && extraction.evidence_review?.includes("relevance") === true;
}

/** Formatting differences are harmless; words and the order of quoted fragments are kept. */
function normalized(text: string): string {
  return decodeEntities(stripInvisible(text)).normalize("NFKC")
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/[¥￥]/g, "")
    .replace(/(\d)\s*(?:円|JPY)/gi, "$1")
    .replace(/\s+/g, " ");
}

/** Do not accept the tail of a different number as a quotation of this one. */
function findFragment(source: string, part: string, from: number, original: string, positions: number[]): number {
  for (let at = source.indexOf(part, from); at >= 0; at = source.indexOf(part, at + 1)) {
    const before = original[positions[at] - 1] ?? "";
    const after = original[positions[at + part.length - 1] + 1] ?? "";
    if (/^\d/.test(part) && /\d/.test(before)) continue;
    if (/\d$/.test(part) && /\d/.test(after)) continue;
    return at;
  }
  return -1;
}

function quoteIn(source: string, evidence: string | null): boolean {
  if (!evidence) return false;
  const parts = evidence.split(/\.{3,}|…+/).map((p) => normalized(p).replace(/ /g, "")).filter(Boolean);
  if (parts.length === 0 || parts.some((p) => !/[\p{L}\p{N}]/u.test(p))) return false;
  let end = 0;
  const positions: number[] = [];
  for (let i = 0; i < source.length; i++) if (source[i] !== " ") positions.push(i);
  const compact = source.replace(/ /g, "");
  for (const part of parts) {
    const at = findFragment(compact, part, end, source, positions);
    if (at < 0) return false;
    end = at + part.length;
  }
  return true;
}

export function validConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/** A quote may come from the subject or either body part, but never be stitched across them. */
export function evidenceIsPresent(evidence: string | null, mail: SourceMail): boolean {
  return [mail.subject, mail.body ?? emailBodyText(mail.text, mail.html)].map(normalized).some((s) => quoteIn(s, evidence));
}

/**
 * Check the model's quotations before storing or using a reading. A bad field becomes unknown;
 * other fields and the mail survive. This checks quotations, not the truth of a sender's claim
 * or whether a real quotation logically entails the value the model attached to it.
 */
export function verifyEvidence(input: Extraction, mail: SourceMail): Extraction {
  const x = withDefaults(input);
  const sources = [mail.subject, mail.body ?? emailBodyText(mail.text, mail.html)].map(normalized);
  const present = (evidence: string | null) => sources.some((s) => quoteIn(s, evidence));
  const common: string[] = (x.evidence_review ?? []).filter((s) => s === "relevance" || s === "overall_confidence");
  const review: string[] = (x.evidence_review ?? []).filter((s) => s !== "relevance" && s !== "overall_confidence");
  const field = <T extends Field>(name: string, value: T, issues: string[]): T => {
    if (value.value === null) return value;
    if (!validConfidence(value.confidence) || value.confidence < 0.6 || !present(value.evidence)) {
      issues.push(name);
      return { ...value, value: null, confidence: 0 };
    }
    return value;
  };
  const items = (values: Extraction["items"], issues: string[]) => values.filter((item, i) => {
    if (present(item.evidence)) return true;
    issues.push(`items.${i}`);
    return false;
  });
  const order = (value: OtherOrder): OtherOrder => {
    const issues: string[] = [...(value.evidence_review ?? [])];
    const result = {
      ...value,
      order_number: field("order_number", value.order_number, issues),
      total_amount: field("total_amount", value.total_amount, issues),
      expected_date: field("expected_date", value.expected_date, issues),
      expected_date_end: field("expected_date_end", value.expected_date_end, issues),
      items: items(value.items, issues),
    };
    if (result.expected_text && !present(result.expected_text)) {
      issues.push("expected_text");
      result.expected_text = null;
    }
    return { ...result, evidence_review: [...new Set([...common, ...issues])] };
  };

  const relevanceVerified = present(x.relevance_evidence);
  if (!relevanceVerified) common.push("relevance");
  if (!validConfidence(x.overall_confidence) || x.overall_confidence < 0.6) common.push("overall_confidence");

  const result: Extraction = {
    ...x,
    order_number: field("order_number", x.order_number, review),
    package_description: field("package_description", x.package_description, review),
    total_amount: field("total_amount", x.total_amount, review),
    ordered_at: field("ordered_at", x.ordered_at, review),
    carrier: field("carrier", x.carrier, review),
    tracking_number: field("tracking_number", x.tracking_number, review),
    expected_date: field("expected_date", x.expected_date, review),
    expected_date_end: field("expected_date_end", x.expected_date_end, review),
    expected_window_start: field("expected_window_start", x.expected_window_start, review),
    expected_window_end: field("expected_window_end", x.expected_window_end, review),
    requires_presence: field("requires_presence", x.requires_presence, review),
    items: items(x.items, review),
    overall_confidence: validConfidence(x.overall_confidence) ? x.overall_confidence : 0,
    other_orders: x.other_orders.map(order),
  };
  if (result.expected_text && !present(result.expected_text)) {
    review.push("expected_text");
    result.expected_text = null;
  }
  result.evidence_review = [...new Set([...common, ...review])];
  return result;
}
