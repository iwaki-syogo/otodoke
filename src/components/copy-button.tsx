"use client";

import { useState } from "react";

export function CopyButton({ text, label = "コピー" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={() => {
        // Clipboard must be called synchronously inside the click handler (user activation).
        navigator.clipboard
          .writeText(text)
          .then(() => setState("done"))
          .catch(() => setState("failed"));
        setTimeout(() => setState("idle"), 2000);
      }}
      className="shrink-0 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium active:bg-neutral-100"
    >
      {state === "done" ? "コピーしました" : state === "failed" ? "長押しでコピー" : label}
    </button>
  );
}
