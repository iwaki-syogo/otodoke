"use client";

import { useState } from "react";
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

/** Opens the carrier's tracking page with the number already in, as far as the carrier allows. */
export function TrackingButton({ link, number }: { link: TrackingLink; number: string }) {
  const [copied, setCopied] = useState(false);

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
    return (
      <>
        {" "}
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK}
          onClick={() => setCopied(copyNow(number))}
        >
          番号をコピーして追跡ページを開く
        </a>
        <span className="mt-1 block text-neutral-500">
          {copied ? "番号をコピーしました。" : ""}佐川のページでは、番号の欄に貼り付けて「お問い合わせ開始」を押してください。
        </span>
      </>
    );
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
