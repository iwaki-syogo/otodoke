"use client";

import { useState, useTransition } from "react";
import { markNotDelivered } from "../../parcel-actions";

const FAILED = "更新できませんでした。開き直してください";

/** 「届いていない」: puts a parcel marked as arrived back to where it was. */
export function NotDeliveredButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function press() {
    setError(null);
    startTransition(async () => {
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
      <button
        type="button"
        onClick={press}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-full border border-neutral-300 bg-white px-3 py-1 text-sm active:bg-neutral-100 disabled:opacity-60"
      >
        {pending ? <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-700" /> : null}
        届いていない
      </button>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
