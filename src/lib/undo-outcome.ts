/** What the person is told after 元に戻す: all back, only some back, or nothing could be saved. */
export type UndoOutcome = "done" | "partly" | "failed";

export async function runUndo(restore: () => Promise<{ leftReceived: boolean }>): Promise<UndoOutcome> {
  try {
    return (await restore()).leftReceived ? "partly" : "done";
  } catch {
    return "failed";
  }
}
