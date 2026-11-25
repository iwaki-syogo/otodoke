"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { PendingButton, usePendingAction } from "@/components/pending-button";
import { Spinner } from "@/components/spinner";
import { CANNOT_UNDO_NOTE, UNDO_CHANGED_NOTICE, UNDO_FAILED_NOTICE, UNDO_UNCONFIRMED_NOTICE } from "@/lib/format";
import { runUndo } from "@/lib/undo-outcome";
import { markReceivedInChunks } from "@/lib/receipt-client";
import type { ReceivedReceipt } from "@/lib/receipt";
import { useRouter, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";
import { listPathWithExcluded, listPathWithoutExcluded } from "@/lib/excluded-query";
import { EXCLUDED_TOAST, EXCLUDE_BUTTON_LABEL, EXCLUDE_FAILED, RESTORED_TOAST, RESTORE_FAILED } from "@/lib/not-parcel-text";
import { excludeParcel, markDeliveredForUndo, restoreExcluded, restoreStatuses } from "./parcel-actions";

type Marked = { id: string; status: string; received_at: string | null }[];
type Undoable = ReceivedReceipt[];
interface Toast {
  text: string;
  undo: Undoable | null;
  /** A second line under the text. */
  note?: string | null;
  /** The parcel taken out by 「これは荷物ではありません」: 元に戻す puts this one back. */
  exclusion?: string | null;
}

export const ToastContext = createContext<(t: Toast) => void>(() => {});

/** What a press shows from the tap until the parcels are saved. */
const SAVING = "保存しています…";
const UNDOING = "戻しています…";

/**
 * Holds the "受け取り済みにしました / 元に戻す" notice. It lives above the list because a marked
 * parcel moves to another page, and the card that was swiped is gone by then.
 */
export function DeliveredToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(Toast & { id: number }) | null>(null);
  const nextToastId = useRef(0);
  const showToast = useCallback((next: Toast) => setToast({ ...next, id: ++nextToastId.current }), []);
  const { pending, run } = usePendingAction();

  // Closes after a while, but never while 元に戻す is on the way: its answer must be seen.
  useEffect(() => {
    if (!toast || pending) return;
    const timer = setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 6000);
    return () => clearTimeout(timer);
  }, [toast, pending]);

  const undoExclusion = (parcelId: string, toastId: number) => {
    run(async () => {
      let ok = false;
      try {
        ok = (await restoreExcluded(parcelId)).ok;
      } catch {
        ok = false;
      }
      // The answer belongs only to the notice from which it started. The button is gone with it, so a
      // second press cannot start a second request.
      setToast((current) => (current?.id !== toastId ? current : { id: toastId, text: ok ? RESTORED_TOAST : RESTORE_FAILED, undo: null }));
    });
  };

  const undo = () => {
    if (toast?.exclusion) return undoExclusion(toast.exclusion, toast.id);
    const items = toast?.undo;
    if (!items) return;
    const toastId = toast.id;
    run(async () => {
      const outcome = await runUndo(restoreStatuses, items);
      // A slower undo belongs only to the notice from which it started.
      setToast((current) => {
        if (current?.id !== toastId) return current;
        if (outcome.unconfirmed?.length) return { id: toastId, text: UNDO_UNCONFIRMED_NOTICE, undo: null, note: outcome.changed.length > 0 ? UNDO_CHANGED_NOTICE : null };
        if (outcome.failed.length > 0) return { id: toastId, text: UNDO_FAILED_NOTICE, undo: null, note: outcome.changed.length > 0 ? UNDO_CHANGED_NOTICE : null };
        if (outcome.changed.length > 0) return { id: toastId, text: UNDO_CHANGED_NOTICE, undo: null };
        return null;
      });
    });
  };

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      {toast ? (
        <div role="status" className="fixed inset-x-4 bottom-24 z-20 mx-auto flex max-w-md items-center justify-between gap-3 rounded-xl bg-neutral-900 px-4 py-3 text-sm text-white shadow-lg">
          <span>
            {toast.text}
            {toast.note ? <span className="mt-0.5 block text-xs text-neutral-300">{toast.note}</span> : null}
          </span>
          {toast.undo || toast.exclusion ? (
            <PendingButton pending={pending} pendingLabel={UNDOING} tone="light" onClick={undo} className="tap inline-flex shrink-0 items-center gap-1.5 font-bold text-emerald-300">
              元に戻す
            </PendingButton>
          ) : null}
        </div>
      ) : null}
    </ToastContext.Provider>
  );
}

/**
 * The list is opened as /app?excluded=<id> after 「これは荷物ではありません」. It shows the notice once and
 * takes the query off the address (replace, not push), so going back or reloading does not show it again.
 * The id is only passed to 元に戻す; nothing of it is drawn. Put it inside the provider.
 */
export function ExcludedToast({ id, text = EXCLUDED_TOAST }: { id: string; text?: string }) {
  const showToast = useContext(ToastContext);
  const router = useRouter();
  const query = useSearchParams();
  const shown = useRef(false);
  useEffect(() => {
    if (shown.current) return;
    shown.current = true;
    showToast({ text, undo: null, exclusion: id });
    // Only `excluded` goes; any other value in the query stays.
    router.replace(listPathWithoutExcluded(query));
  }, [id, text, query, router, showToast]);
  return null;
}

const REVEAL = 96;
const COMMIT = 120;
/** A move to the right that starts this close to the screen's left edge is the browser's 戻る, not ours. */
const BACK_EDGE = 24;

/**
 * The grey face under a card swiped to the right: 「外す」. Its own component so that useRouter
 * runs only for cards that can be taken out. It opens and stays open; only its button takes the parcel out.
 */
function ExcludeFace({ visible, busy, width, onPress }: { visible: boolean; busy: boolean; width: number; onPress: (router: ReturnType<typeof useRouter>, query: URLSearchParams | ReadonlyURLSearchParams) => void }) {
  const router = useRouter();
  // Read here, not in SwipeToDeliver: only cards that can be taken out need the current query.
  const query = useSearchParams();
  return (
    <div
      aria-hidden={!visible}
      className={`absolute inset-y-0 left-0 flex items-center bg-neutral-200 pr-6 pl-3 text-xs font-bold text-neutral-800 ${visible ? "" : "invisible"}`}
      style={{ width }}
    >
      <button
        type="button"
        onClick={() => onPress(router, query)}
        aria-busy={busy || undefined}
        aria-disabled={busy || undefined}
        className={`flex w-full self-stretch items-center justify-start gap-2 text-left leading-tight ${busy ? "pointer-events-none" : ""}`}
      >
        {busy ? (
          <>
            <Spinner />
            外しています…
          </>
        ) : (
          EXCLUDE_BUTTON_LABEL
        )}
      </button>
    </div>
  );
}

/**
 * Swipe a card to the left to say the parcel is received (受け取った). Vertical scrolling is left alone.
 * With canExclude, a swipe to the right opens 「外す」 (never a manual parcel: it cannot be taken out).
 */
export function SwipeToDeliver({ id, children, canExclude = false }: { id: string; status: string; receivedAt?: string | null; children: ReactNode; canExclude?: boolean }) {
  const showToast = useContext(ToastContext);
  const [dx, setDx] = useState(0);
  const [state, setState] = useState<"idle" | "dragging" | "saving" | "error">("idle");
  const [excluding, setExcluding] = useState(false);
  const [excludeError, setExcludeError] = useState<string | null>(null);
  const start = useRef<{ x: number; y: number; horizontal: boolean | null; fromEdge: boolean } | null>(null);
  const moved = useRef(false);
  // Set before anything is awaited: a second swipe or tap meanwhile saves nothing more.
  const saving = useRef(false);
  const [, startTransition] = useTransition();

  const commit = useCallback(() => {
    if (saving.current) return;
    saving.current = true;
    setState("saving");
    setDx(-COMMIT * 3);
    startTransition(async () => {
      try {
        // 0: nothing was saved (signed out, or the parcel was cancelled meanwhile). Not received.
        const done = await markReceivedInChunks([id], markDeliveredForUndo);
        if (done.saved === 0) throw new Error("nothing saved");
        // Nothing written (already received on another screen): saved, with no 元に戻す to offer.
        showToast({ text: "受け取り済みにしました", undo: done.written.length > 0 ? done.written : null });
      } catch {
        saving.current = false;
        setState("error");
        setDx(0);
      }
    });
  }, [id, showToast]);

  // Only the button takes a parcel out. One `saving` ref serves both sides: while 受け取った or this is in flight, the other does not start.
  const exclude = (router: ReturnType<typeof useRouter>, query: URLSearchParams | ReadonlyURLSearchParams) => {
    if (saving.current) return;
    saving.current = true;
    setExcluding(true);
    setExcludeError(null);
    setDx(REVEAL);
    void (async () => {
        try {
        const r = await excludeParcel(id);
        if (r.ok) {
          // Every other value in the query stays (?sample=1, ?demo=busy), so the list is not sent to the consent screen.
          router.replace(listPathWithExcluded(query, id));
          // excludeParcel asks for no redraw on the server (the parcel page is gone by then), so the list asks for its own:
          // the card must be gone from the list, not only the query changed.
          router.refresh();
          return;
        }
      } catch {
        // The same words as on the parcel page, whatever the answer or the failure was.
      }
      saving.current = false;
      setExcluding(false);
      setExcludeError(EXCLUDE_FAILED);
      setDx(0);
    })();
  };
  const rightOpen = canExclude && state !== "saving" && !excluding;

  const onPointerDown = (e: React.PointerEvent) => {
    if (state === "saving" || saving.current) return;
    start.current = { x: e.clientX, y: e.clientY, horizontal: null, fromEdge: e.clientX <= BACK_EDGE };
    moved.current = false;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (s.horizontal === null && Math.hypot(mx, my) > 8) s.horizontal = Math.abs(mx) > Math.abs(my);
    if (!s.horizontal) return;
    moved.current = true;
    setState("dragging");
    setDx(Math.max(-COMMIT * 1.5, Math.min(rightOpen && !s.fromEdge ? REVEAL * 1.25 : 0, mx)));
  };
  const onPointerUp = () => {
    const s = start.current;
    start.current = null;
    if (!s?.horizontal) return;
    if (dx <= -COMMIT) commit();
    else {
      setState("idle");
      // To the right it opens and waits; it never takes the parcel out by itself.
      setDx(dx <= -REVEAL / 2 ? -REVEAL : dx >= REVEAL / 2 ? REVEAL : 0);
    }
  };

  return (
    <div className="relative overflow-hidden rounded-2xl">
      <div
        aria-hidden={dx >= 0}
        className={`absolute inset-y-0 right-0 flex items-center bg-emerald-600 pr-4 pl-6 text-sm font-bold text-white ${dx >= 0 && state !== "saving" ? "invisible" : ""}`}
        style={{ width: Math.max(REVEAL, -dx) }}
      >
        <button
          type="button"
          onClick={commit}
          aria-busy={state === "saving" || undefined}
          aria-disabled={state === "saving" || undefined}
          className={`flex w-full self-stretch items-center justify-end gap-2 ${state === "saving" ? "pointer-events-none" : ""}`}
        >
          {state === "saving" ? (
            <>
              <Spinner tone="light" />
              {SAVING}
            </>
          ) : (
            "受け取った"
          )}
        </button>
      </div>
      {canExclude ? <ExcludeFace visible={dx > 0} busy={excluding} width={Math.max(REVEAL, dx)} onPress={exclude} /> : null}
      <div
        className={`relative touch-pan-y ${state === "dragging" ? "" : "transition-transform duration-200"}`}
        style={{ transform: `translateX(${dx}px)` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={(e) => {
          // A swipe ends with a click on the card's link; it must not open the parcel.
          if (moved.current || dx !== 0) {
            e.preventDefault();
            e.stopPropagation();
            moved.current = false;
            if (state !== "saving") setDx(0);
          }
        }}
      >
        {children}
      </div>
      {state === "error" ? <p className="mt-1 text-xs text-red-700">保存できませんでした。もう一度スワイプしてください。</p> : null}
      {excludeError ? (
        <p role="alert" className="mt-1 text-xs text-red-800">
          {excludeError}
        </p>
      ) : null}
    </div>
  );
}

/** "Mark all as received" for the parcels waiting for a check, with a second tap to confirm. */
export function DeliverAll({ items }: { items: Marked }) {
  const showToast = useContext(ToastContext);
  const [step, setStep] = useState<"idle" | "confirm" | "error" | "partial">("idle");
  const { pending, run } = usePendingAction();

  const save = () =>
    run(async () => {
      try {
        const done = await markReceivedInChunks(items.map((it) => it.id), markDeliveredForUndo);
        // 0: nothing was saved (signed out, or all cancelled meanwhile).
        if (done.saved === 0) {
          setStep("error");
          return;
        }
        const partial = done.saved < new Set(items.map((it) => it.id)).size;
        setStep(partial ? "partial" : "idle");
        // 元に戻す covers only what this press wrote; the rest (already received) is said in a note.
        const undo = done.written;
        showToast({ text: partial ? "一部を保存できませんでした" : "受け取り済みにしました", undo: undo.length > 0 ? undo : null, note: undo.length > 0 && undo.length < done.saved ? CANNOT_UNDO_NOTE : null });
      } catch {
        setStep("error");
      }
    });

  if (step === "confirm" || pending) {
    return (
      <div className="flex gap-2">
        <PendingButton
          pending={pending}
          pendingLabel={SAVING}
          tone="light"
          onClick={save}
          className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-sm font-bold text-white"
        >
          受け取り済みにする
        </PendingButton>
        <button type="button" onClick={() => setStep("idle")} disabled={pending} className="rounded-xl border border-neutral-300 px-4 py-3 text-sm disabled:opacity-60">
          やめる
        </button>
      </div>
    );
  }
  return (
    <div>
      <button type="button" onClick={() => setStep("confirm")} className="w-full rounded-xl border border-emerald-600 px-4 py-3 text-sm font-bold text-emerald-700">
        すべて受け取り済みにする
      </button>
      {step === "error" ? <p className="mt-1 text-xs text-red-700">保存できませんでした。もう一度押してください。</p> : null}
      {step === "partial" ? <p className="mt-1 text-xs text-red-700">保存できなかった荷物があります。開き直してください。</p> : null}
    </div>
  );
}
