"use client";

import { useEffect, useRef, useState } from "react";
import type { TrackingLink } from "@/lib/carriers";

const LINK = "font-medium text-sky-700 underline underline-offset-4";

/**
 * Copies during the tap itself. The async Clipboard API is refused once the new tab has taken
 * focus, so the synchronous copy goes first and the API is only a fallback.
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
  if (!ok) navigator.clipboard?.writeText(text).catch(() => {});
  return ok;
}

/** How long the "copied" popup stays up before the carrier's page opens: long enough to read both lines. */
const OPEN_AFTER_MS = 1500;

/**
 * Opens a page in a new tab. A tab opened after a delay can be blocked as a popup (iOS Safari
 * especially), so the page then opens in this tab instead. "noopener" is not passed because it
 * makes window.open return null every time; the opener is cut by hand.
 */
function openLater(url: string) {
  const w = window.open(url, "_blank");
  if (w) w.opener = null;
  else window.location.assign(url);
}

/**
 * For carriers that take no number from outside (Sagawa): copies the number during the tap,
 * says so in a popup, then opens the carrier's page so the number can be pasted there.
 */
function CopyThenOpen({ url, number, pageName }: { url: string; number: string; pageName: string }) {
  // null: idle. Otherwise whether the copy worked; the popup stays up until the page opens.
  const [copied, setCopied] = useState<boolean | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function onTap() {
    if (copied !== null) return; // already on its way
    // Synchronous, inside the tap: the async Clipboard API fails once another tab has focus.
    setCopied(copyNow(number));
    timer.current = setTimeout(() => {
      timer.current = null;
      openLater(url);
      setCopied(null);
    }, OPEN_AFTER_MS);
  }

  return (
    <>
      {" "}
      <button type="button" onClick={onTap} disabled={copied !== null} className={LINK}>
        追跡ページを開く
      </button>
      {copied !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
          <div role="status" aria-live="polite" className="w-full max-w-sm rounded-2xl bg-white p-6 text-center shadow-xl">
            {copied ? (
              <svg aria-hidden="true" viewBox="0 0 24 24" className="mx-auto size-12 rounded-full bg-emerald-100 p-2.5 text-emerald-600">
                <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : null}
            <p className={`text-lg font-bold text-neutral-900 ${copied ? "mt-3" : ""}`}>
              {copied ? "追跡番号をコピーしました" : "追跡番号をコピーできませんでした"}
            </p>
            {copied ? null : (
              <p className="mt-3 select-all break-all font-mono text-2xl font-bold tracking-wider text-neutral-900">{number}</p>
            )}
            <p className="mt-3 text-sm text-neutral-600">
              {`${pageName}ページに`}
              {/* Kept on one line with the spinner, so a wrap on a phone never splits 移動中. */}
              <span className="whitespace-nowrap">
                移動中です
                <span
                  aria-hidden="true"
                  className="ml-1.5 inline-block size-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-neutral-600 align-[-2px]"
                />
              </span>
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Opens the carrier's tracking page with the number already in, as far as the carrier allows. */
export function TrackingButton({ link, number }: { link: TrackingLink; number: string }) {
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
  if (link.kind === "copy") return <CopyThenOpen url={link.url} number={number} pageName={link.pageName} />;
  return (
    <>
      {" "}
      <a href={link.url} target="_blank" rel="noopener noreferrer" className={LINK}>
        追跡ページを開く
      </a>
    </>
  );
}
