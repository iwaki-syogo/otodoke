import { RECEIPT_CHUNK_SIZE, type ReceivedReceipt, type RestoreResult } from "@/lib/receipt";

type ReceiptKey = Pick<ReceivedReceipt, "id" | "receipt_id">;

/** Keep all three facts: a changed parcel is never described as still received, and a failed request is not a conflict. */
export async function runUndo(restore: (items: ReceiptKey[]) => Promise<RestoreResult>, items: ReceiptKey[]): Promise<RestoreResult> {
  const receipts = [...new Map(items.map((item) => [item.id, { id: item.id, receipt_id: item.receipt_id }])).values()];
  const result: RestoreResult = { restored: [], changed: [], failed: [] };
  for (let start = 0; start < receipts.length; start += RECEIPT_CHUNK_SIZE) {
    const chunk = receipts.slice(start, start + RECEIPT_CHUNK_SIZE);
    try {
      const answer = await restore(chunk);
      const groups = { restored: new Set(Array.isArray(answer?.restored) ? answer.restored : []),
        changed: new Set(Array.isArray(answer?.changed) ? answer.changed : []), failed: new Set(Array.isArray(answer?.failed) ? answer.failed : []) };
      for (const { id } of chunk) {
        const kinds = (["restored", "changed", "failed"] as const).filter((kind) => groups[kind].has(id));
        // A missing or contradictory answer is unconfirmed for this row, without discarding other rows.
        result[kinds.length === 1 ? kinds[0] : "failed"].push(id);
      }
    } catch {
      result.failed.push(...chunk.map((item) => item.id));
    }
  }
  return result;
}
