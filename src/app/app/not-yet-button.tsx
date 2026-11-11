"use client";

import { useState } from "react";
import { PendingButton, usePendingAction } from "@/components/pending-button";
import { dismissCheck } from "./parcel-actions";

const FAILED = "更新できませんでした。開き直してください";

/**
 * 「まだ」 under a delivered parcel in 要確認: it leaves 要確認, stays under 配達済み and is not asked
 * about again. No toast; the section redraws when the action revalidates the app.
 */
export function NotYetButton({ id }: { id: string }) {
  const { pending, run } = usePendingAction();
  const [error, setError] = useState<string | null>(null);

  function press() {
    setError(null);
    run(async () => {
      try {
        const r = await dismissCheck(id);
        if (!r.ok) setError(r.error);
      } catch {
        setError(FAILED);
      }
    });
  }

  return (
    <div className="mt-1 flex flex-col items-end gap-1">
      <PendingButton
        pending={pending}
        pendingLabel="保存しています…"
        onClick={press}
        className="inline-flex items-center gap-2 rounded-full border border-amber-400 bg-white px-3 py-1 text-sm text-amber-950 active:bg-amber-100"
      >
        まだ
      </PendingButton>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
