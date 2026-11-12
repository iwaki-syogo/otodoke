import { RECEIPT_CHUNK_SIZE, type ReceivedReceipt, type RestoreResult } from "@/lib/receipt";

type ReceiptKey = Pick<ReceivedReceipt, "id" | "receipt_id">;

/** Keep known refusals separate from unanswered requests, without guessing a parcel's current state. */
export async function runUndo(restore: (items: ReceiptKey[]) => Promise<RestoreResult>, items: ReceiptKey[]): Promise<RestoreResult> {
  const receipts = [...new Map(items.map((item) => [item.id, { id: item.id, receipt_id: item.receipt_id }])).values()];
  const result: RestoreResult = { restored: [], changed: [], failed: [] };
  for (let start = 0; start < receipts.length; start += RECEIPT_CHUNK_SIZE) {
    const chunk = receipts.slice(start, start + RECEIPT_CHUNK_SIZE);
    try {
      const answer = await restore(chunk);
      const groups = { restored: new Set(Array.isArray(answer?.restored) ? answer.restored : []),
        changed: new Set(Array.isArray(answer?.changed) ? answer.changed : []), failed: new Set(Array.isArray(answer?.failed) ? answer.failed : []),
        unconfirmed: new Set(Array.isArray(answer?.unconfirmed) ? answer.unconfirmed : []) };
      for (const { id } of chunk) {
        const kinds = (["restored", "changed", "failed", "unconfirmed"] as const).filter((kind) => groups[kind].has(id));
        // A missing or contradictory answer is unconfirmed for this row, without discarding other rows.
        const kind = kinds.length === 1 ? kinds[0] : "unconfirmed";
        if (kind === "unconfirmed") (result.unconfirmed ??= []).push(id);
        else result[kind].push(id);
      }
    } catch {
      (result.unconfirmed ??= []).push(...chunk.map((item) => item.id));
    }
  }
  return result;
}
