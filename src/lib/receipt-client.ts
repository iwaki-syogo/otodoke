import { RECEIPT_CHUNK_SIZE, type MarkReceivedResult, type ReceivedReceipt } from "@/lib/receipt";

/** A full-list press remains a full-list operation; each server request has its own bounded budget. */
export async function markReceivedInChunks(ids: string[], mark: (ids: string[]) => Promise<MarkReceivedResult>): Promise<MarkReceivedResult> {
  const requested = [...new Set(ids)];
  const written = new Map<string, ReceivedReceipt>();
  let saved = 0;
  for (let start = 0; start < requested.length; start += RECEIPT_CHUNK_SIZE) {
    const chunk = requested.slice(start, start + RECEIPT_CHUNK_SIZE);
    try {
      const result = await mark(chunk);
      if (!Number.isInteger(result.saved) || result.saved < 0 || result.saved > chunk.length || !Array.isArray(result.written)) continue;
      saved += result.saved;
      for (const receipt of result.written) {
        if (chunk.includes(receipt.id) && typeof receipt.receipt_id === "string" && receipt.receipt_id.length > 0) written.set(receipt.id, receipt);
      }
    } catch {
      // An unanswered chunk contributes no confirmed save or undo token. Other chunks can still succeed.
    }
  }
  return { saved, written: [...written.values()] };
}
