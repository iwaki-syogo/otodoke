"use client";

import { useState } from "react";
import { PendingButton, usePendingAction } from "@/components/pending-button";
import { markDelivered } from "../../parcel-actions";

const FAILED = "保存できませんでした。もう一度押してください。";

/**
 * 「届いた」 on the parcel page: the same as swiping its card in the list, for a keyboard and for
 * VoiceOver too (the list's swipe button shows only while swiping).
 */
export function MarkDeliveredButton({ id }: { id: string }) {
  const { pending, run } = usePendingAction();
  const [error, setError] = useState<string | null>(null);

  function press() {
    setError(null);
    run(async () => {
      try {
        // On success the action's revalidatePath("/app", "layout") sends this page back redrawn.
        // 0: nothing was saved (signed out, or the parcel was cancelled meanwhile).
        if ((await markDelivered([id])) !== 1) setError(FAILED);
      } catch {
        setError(FAILED);
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <PendingButton
        pending={pending}
        pendingLabel="保存しています…"
        onClick={press}
        className="inline-flex items-center gap-2 rounded-full border border-emerald-600 bg-white px-3 py-1 text-sm font-medium text-emerald-700 active:bg-emerald-50"
      >
        届いた
      </PendingButton>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
