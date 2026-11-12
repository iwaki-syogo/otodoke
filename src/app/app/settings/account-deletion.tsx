"use client";

import { useActionState, useEffect, useRef, useState, type MouseEvent } from "react";
import { ACCOUNT_DELETE_CONFIRM, type DeleteAccountState } from "@/lib/account-deletion";
import { deleteAccount } from "./account-actions";

/**
 * The last section of 設定: 「アカウントを削除」.
 *
 * The first press deletes nothing: it opens the confirmation step, which says what goes, that it
 * cannot be undone, and to remove the automatic forwarding. Only that step has a form, and only
 * its form carries the field the Server Action asks for.
 *
 * 「削除する」 shows the press at once: a spinner and 「削除しています…」 until the page after it
 * opens, or the words of a failure appear. It is never `disabled` (a pressed button should look
 * pressed); a second press meanwhile is cancelled instead. 「やめる」 does nothing while deleting.
 */
export function AccountDeletion({ userId }: { userId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, formAction, pending] = useActionState<DeleteAccountState, FormData>(deleteAccount, null);
  // A failure already shown when the step was closed: opening it again starts without it.
  const [dismissed, setDismissed] = useState<DeleteAccountState>(null);
  // Refs, not state: a second press can come before React has drawn the first one.
  const pressed = useRef(false);
  const moved = useRef(false);
  const opener = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // The try is over (it failed, or never started): a press may send again.
    if (!pending) pressed.current = false;
  }, [pending, state]);

  useEffect(() => {
    // Focus follows the step when it opens or closes, never on the first draw.
    if (!moved.current) return;
    if (confirming) title.current?.focus();
    else opener.current?.focus();
  }, [confirming]);

  function toggle(open: boolean) {
    if (pending) return;
    moved.current = true;
    if (!open) setDismissed(state);
    setConfirming(open);
  }

  function press(event: MouseEvent<HTMLButtonElement>) {
    if (pending || pressed.current) {
      event.preventDefault();
      return;
    }
    pressed.current = true;
  }

  if (!confirming) {
    return (
      <section>
        <button ref={opener} type="button" onClick={() => toggle(true)} className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-800">
          アカウントを削除
        </button>
      </section>
    );
  }

  const error = state && state !== dismissed && !pending ? state.error : null;
  return (
    <section aria-labelledby="account-delete-title" className="rounded-2xl border border-red-200 bg-red-50 p-4">
      <h2 id="account-delete-title" ref={title} tabIndex={-1} className="text-base font-bold outline-none">
        アカウントを削除しますか？
      </h2>
      <p className="mt-1 text-sm leading-6">Otodoke の荷物、Otodoke に保存したメール、転送先アドレスを、アカウントごと消します。お使いのメールの受信箱は、そのままです。元に戻せません。</p>
      <p className="mt-1 text-sm leading-6">Gmail などで設定した自動転送も外してください。</p>
      <form action={formAction} className="mt-3 flex flex-wrap items-center gap-2">
        <input type="hidden" name="expectedUserId" value={userId} />
        <input type="hidden" name={ACCOUNT_DELETE_CONFIRM.name} value={ACCOUNT_DELETE_CONFIRM.value} />
        <button
          type="submit"
          aria-busy={pending || undefined}
          onClick={press}
          className="flex items-center justify-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-medium text-white active:opacity-80"
        >
          {pending ? (
            <>
              <span aria-hidden className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
              削除しています…
            </>
          ) : (
            "削除する"
          )}
        </button>
        <button type="button" onClick={() => toggle(false)} aria-disabled={pending || undefined} className="rounded-lg border border-neutral-300 bg-white px-4 py-2 text-sm aria-disabled:opacity-60">
          やめる
        </button>
      </form>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
    </section>
  );
}
