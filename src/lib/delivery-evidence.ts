/** The line a delivery mail gave as its reason for reading it as 配達完了, for the parcel page. */
export const DELIVERY_EVIDENCE_LABEL = "配達完了";

interface Reading {
  result: unknown;
  sentAt: string | null;
  createdAt?: string | null;
}

/**
 * The newest delivery mail's `relevance_evidence`, exactly as read from the mail, or null when no
 * delivery mail gave one. Mails of other kinds never count, and nothing is made up.
 */
export function deliveryEvidence(readings: Reading[]): string | null {
  let best: { line: string; at: string } | null = null;
  for (const r of readings) {
    const result = r.result as { relevance?: unknown; relevance_evidence?: unknown } | null;
    if (!result || result.relevance !== "delivered") continue;
    const line = typeof result.relevance_evidence === "string" ? result.relevance_evidence.trim() : "";
    if (!line) continue;
    const at = r.sentAt ?? r.createdAt ?? "";
    if (best === null || at >= best.at) best = { line, at };
  }
  return best?.line ?? null;
}
