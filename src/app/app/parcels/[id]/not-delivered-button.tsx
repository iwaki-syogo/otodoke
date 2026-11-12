"use client";

import { useState } from "react";
import { PendingButton, usePendingAction } from "@/components/pending-button";
import { REMOVE_DELIVERED_LABEL } from "@/lib/parcel-action-text";
import { markNotDelivered } from "../../parcel-actions";

const FAILED = "更新できませんでした。開き直してください";

/** Removes the delivered record; current tracking info chooses shipped or ordered. */
export function NotDeliveredButton({ id }: { id: string }) {
  const { pending, run } = usePendingAction();
  const [error, setError] = useState<string | null>(null);

  function press() {
    setError(null);
    run(async () => {
      try {
        const r = await markNotDelivered(id);
        // On success the action's revalidatePath("/app", "layout") sends this page back redrawn.
        if (!r.ok) setError(r.error);
      } catch {
        setError(FAILED);
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
        {REMOVE_DELIVERED_LABEL}
      </PendingButton>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
