/** One action/RPC request; larger visible selections are split transparently by the UI. */
export const RECEIPT_CHUNK_SIZE = 200;

/** Server-owned receipt. The undo authority is the opaque id, never the caller's prior state. */
export interface ReceivedReceipt {
  id: string;
  receipt_id: string;
  received_at: string;
  updated_at: string;
  previous_status: string;
  previous_received_at: string | null;
}

export type ReceiptKey = Pick<ReceivedReceipt, "id" | "receipt_id">;
export type MarkReceivedResult = { saved: number; written: ReceivedReceipt[] };
export type RestoreResult = { restored: string[]; changed: string[]; failed: string[] };
