"use client";

import { useFormStatus } from "react-dom";
import { clearAllParcels, loadDemo } from "./actions";

export function DemoLoader({ result, error, cleared }: { result?: string; error?: string; cleared?: string }) {
  return (
    <div className="mt-3 flex flex-col gap-3">
      <form action={loadDemo}>
        <LoadButton />
      </form>
      {result ? (
        <p className="text-sm text-emerald-800">
          {result} 通のメールを読み込みました。「荷物」タブで確認できます。
        </p>
      ) : null}
      {cleared ? <p className="text-sm text-neutral-700">荷物とメールを消しました。</p> : null}
      {error ? <p className="break-words text-sm text-red-800">{error}</p> : null}

      <details className="text-sm">
        <summary className="cursor-pointer text-neutral-500">すべての荷物を消す</summary>
        <form action={clearAllParcels} className="mt-2 flex flex-col gap-2 rounded-xl bg-neutral-50 p-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" name="confirm" value="yes" className="h-4 w-4" />
            本当に消す（元に戻せません）
          </label>
          <ClearButton />
        </form>
      </details>
    </div>
  );
}

function LoadButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-60"
    >
      {pending ? "読み込み中…" : "サンプルのメールを読み込む"}
    </button>
  );
}

function ClearButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="self-start rounded-lg border border-red-300 px-3 py-2 text-sm text-red-800 disabled:opacity-60">
      {pending ? "消しています…" : "消す"}
    </button>
  );
}
