"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PendingButton, usePendingAction } from "@/components/pending-button";
import { EXCLUDE_BUTTON_LABEL, EXCLUDE_FAILED } from "@/lib/not-parcel-text";
import { excludeParcel } from "../../parcel-actions";

/**
 * 「これは荷物ではありません」 on the parcel page. No confirmation: it is put back from the notice on the list
 * and from 外した荷物. On success this page cannot open the parcel any more, so it moves to the list
 * (replace, so going back does not land on a page that is gone); the list shows the notice with 元に戻す.
 * A refusal stays here and says so.
 */
export function NotParcelButton({ id }: { id: string }) {
  const router = useRouter();
  const { pending, run } = usePendingAction();
  const [error, setError] = useState<string | null>(null);

  function press() {
    setError(null);
    run(async () => {
      try {
        const r = await excludeParcel(id);
        if (r.ok) router.replace(`/app?excluded=${id}`);
        else setError(r.error);
      } catch {
        setError(EXCLUDE_FAILED);
      }
    });
  }

  return (
    <div className="flex flex-col items-start gap-2">
      <PendingButton
        pending={pending}
        pendingLabel="外しています…"
        onClick={press}
        className="inline-flex items-center gap-2 py-1 text-sm text-neutral-500 underline underline-offset-4"
      >
        {EXCLUDE_BUTTON_LABEL}
      </PendingButton>
      {error ? (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </div>
  );
}
