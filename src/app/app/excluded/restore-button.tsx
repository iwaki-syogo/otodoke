"use client";

import { useState } from "react";
import { PendingButton, usePendingAction } from "@/components/pending-button";
import { RESTORE_BUTTON_LABEL, RESTORE_FAILED } from "@/lib/not-parcel-text";
import { restoreExcluded } from "../parcel-actions";

/**
 * 一覧に戻す on a row of 外した荷物. On success the action's revalidatePath("/app", "layout") sends this page
 * back redrawn, without the row. A failure says so in the words of putting back, not of taking out.
 */
export function RestoreExcludedButton({ id, onRestored }: { id: string; onRestored?: () => void }) {
  const { pending, run } = usePendingAction();
  const [error, setError] = useState<string | null>(null);

  function press() {
    setError(null);
    run(async () => {
      try {
        if ((await restoreExcluded(id)).ok) onRestored?.();
        else setError(RESTORE_FAILED);
      } catch {
        setError(RESTORE_FAILED);
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <PendingButton
        pending={pending}
        pendingLabel="戻しています…"
        onClick={press}
        className="inline-flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-3 py-1 text-sm active:bg-neutral-100"
      >
        {RESTORE_BUTTON_LABEL}
      </PendingButton>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
