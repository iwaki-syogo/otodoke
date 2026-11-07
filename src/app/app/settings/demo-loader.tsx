"use client";

import { useId } from "react";
import { clearAllParcels, loadDemo } from "./actions";
import { LOAD_DEMO_LABEL } from "./demo-labels";
import { PressButton } from "./press";

/**
 * `error` is fixed wording chosen by the page from a code (src/lib/settings-errors.ts), and
 * `loaded` a number: nothing from the link is shown as it came.
 */
export function DemoLoader({ loaded, error, cleared }: { loaded: number | null; error: string | null; cleared: boolean }) {
  const warningId = useId();
  return (
    <div className="mt-3 flex flex-col gap-3">
      <form action={loadDemo}>
        <LoadButton />
      </form>
      {loaded !== null && error ? <p className="text-sm text-neutral-700">{loaded} 通は読み込めました。</p> : null}
      {cleared ? <p className="text-sm text-neutral-700">荷物と保存したメールを消しました。</p> : null}
      {error ? <p className="break-words text-sm text-red-800">{error}</p> : null}

      <details className="text-sm">
        <summary className="cursor-pointer text-neutral-500">すべての荷物を消す</summary>
        <form action={clearAllParcels} className="mt-2 flex flex-col gap-2 rounded-xl bg-neutral-50 p-3">
          <p id={warningId} className="text-sm leading-6">荷物と保存したメールを消します。消すと元に戻せません。</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirm" value="yes" aria-describedby={warningId} className="h-4 w-4" />
            本当に消す
          </label>
          <ClearButton />
        </form>
      </details>
    </div>
  );
}

function LoadButton() {
  return <PressButton label={LOAD_DEMO_LABEL} busyLabel="読み込んでいます…" className="w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white" />;
}

function ClearButton() {
  return <PressButton label="消す" busyLabel="消しています…" className="self-start rounded-lg border border-red-300 px-3 py-2 text-sm text-red-800" />;
}
