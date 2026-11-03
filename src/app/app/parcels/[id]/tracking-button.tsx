"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { TrackingLink } from "@/lib/carriers";

const LINK = "font-medium text-sky-700 underline underline-offset-4";
/** A small framed control at the right end of a step row. */
const SMALL = "shrink-0 whitespace-nowrap rounded-lg border px-2.5 py-1 text-sm font-medium";

/**
 * Copies during the tap itself, without the async Clipboard API: that one needs a secure
 * context and focus, so it is only tried when this fails.
 */
function copyNow(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function StepNumber({ n }: { n: number }) {
  return (
    <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-bold text-sky-700">
      {n}
    </span>
  );
}

/**
 * For carriers that take no number from outside (Sagawa): a popup that walks through copying
 * the number and opening the carrier's page. Nothing happens on its own. The page opens from a
 * real link in a new tab, so it is never blocked as a popup and this page always stays put.
 */
function CopyThenOpen({
  url,
  number,
  shown,
  pageName,
  carrierName,
}: {
  url: string;
  number: string;
  shown: string;
  pageName: string;
  carrierName: string;
}) {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const titleId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  const firstButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        opener.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  function show() {
    setCopy("idle");
    setOpen(true);
  }

  function close() {
    setOpen(false);
    opener.current?.focus();
  }

  async function onCopy() {
    // Synchronous first, inside the tap; the Clipboard API only as a fallback.
    if (copyNow(number)) {
      setCopy("done");
      return;
    }
    try {
      if (!navigator.clipboard) throw new Error("no clipboard");
      await navigator.clipboard.writeText(number);
      setCopy("done");
    } catch {
      setCopy("failed");
    }
  }

  return (
    <>
      {" "}
      <button ref={opener} type="button" onClick={show} className={LINK}>
        追跡ページを開く
      </button>
      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="w-full max-w-sm rounded-2xl bg-white p-6 text-sm text-neutral-900 shadow-xl"
          >
            <h2 id={titleId} className="text-center text-lg font-bold">
              {carrierName}で追跡する
            </h2>
            <ol className="mt-5 flex flex-col gap-5">
              <li className="flex gap-3">
                <StepNumber n={1} />
                {copy === "failed" ? (
                  <div className="min-w-0 flex-1">
                    <p className="select-all break-all font-mono text-2xl font-bold tracking-wider">{shown}</p>
                    <p className="mt-1 text-neutral-600">長押ししてコピー</p>
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0 break-all font-mono text-base tracking-wider">{shown}</span>
                    <button
                      ref={firstButton}
                      type="button"
                      onClick={onCopy}
                      className={`${SMALL} ${copy === "done" ? "border-emerald-300 text-emerald-700" : "border-sky-300 text-sky-700"}`}
                    >
                      {copy === "done" ? "コピー済み ✓" : "コピー"}
                    </button>
                  </div>
                )}
              </li>
              <li className="flex gap-3">
                <StepNumber n={2} />
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="min-w-0">{pageName}</span>
                  <a href={url} target="_blank" rel="noopener noreferrer" className={`${SMALL} border-neutral-300 text-neutral-700`}>
                    開く ↗
                  </a>
                </div>
              </li>
              <li className="flex gap-3">
                <StepNumber n={3} />
                <p className="min-w-0 flex-1 pt-0.5 leading-relaxed text-neutral-700">送り状番号を貼り付けて『お問い合わせ開始』を押す</p>
              </li>
            </ol>
            <button type="button" onClick={close} className="mt-6 w-full rounded-xl px-4 py-2.5 font-medium text-neutral-600">
              閉じる
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Opens the carrier's tracking page with the number already in, as far as the carrier allows.
 * Always in a new tab: the parcel page itself never navigates away.
 */
export function TrackingButton({
  link,
  number,
  shown,
  carrierName,
}: {
  link: TrackingLink;
  /** Normalized: what is copied or sent. */
  number: string;
  /** As stored on the parcel, for reading. */
  shown: string;
  carrierName: string;
}) {
  if (link.kind === "post") {
    return (
      <form method="post" action={link.url} target="_blank" className="inline">
        {Object.entries(link.fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}{" "}
        <button type="submit" className={LINK}>
          追跡ページを開く
        </button>
      </form>
    );
  }
  if (link.kind === "copy") {
    return <CopyThenOpen url={link.url} number={number} shown={shown} pageName={link.pageName} carrierName={carrierName} />;
  }
  return (
    <>
      {" "}
      <a href={link.url} target="_blank" rel="noopener noreferrer" className={LINK}>
        追跡ページを開く
      </a>
    </>
  );
}
