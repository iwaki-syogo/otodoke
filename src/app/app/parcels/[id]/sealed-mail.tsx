"use client";

import { useEffect, useState } from "react";
import { openMail, WrongKeyError, type MailPlaintext } from "@/lib/crypto/envelope";
import { useTabKey } from "@/lib/crypto/tab-key";
import { createClient } from "@/lib/supabase/client";
import { htmlToText } from "@/lib/text/html-to-text";
import { UnlockForm } from "../../unlock-form";

type Opened = { kind: "open"; mail: MailPlaintext } | { kind: "old-key" } | { kind: "failed" };

/**
 * A stored mail sealed to the user's key. Shown as a neutral line until the key is open in this
 * tab; then the envelope is fetched with the user's own session and opened here, in the browser.
 * The body is shown as text only: the HTML part is turned into text, never rendered.
 */
export function SealedMail({ userId, emailId, fromDomain, notes, confidence }: { userId: string; emailId: string; fromDomain: string | null; notes: string | null; confidence: React.ReactNode }) {
  const key = useTabKey(userId);
  const [opened, setOpened] = useState<{ keyId: string; result: Opened } | null>(null);
  const current = key && opened?.keyId === key.keyId ? opened.result : null;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await createClient().from("emails").select("body_envelope").eq("id", emailId).maybeSingle();
      if (error || !data?.body_envelope) return { kind: "failed" } as const;
      try {
        return { kind: "open", mail: await openMail(key, userId, emailId, data.body_envelope) } as const;
      } catch (err) {
        return err instanceof WrongKeyError ? ({ kind: "old-key" } as const) : ({ kind: "failed" } as const);
      }
    })().then((result) => {
      if (!cancelled) setOpened({ keyId: key.keyId, result });
    });
    return () => {
      cancelled = true;
    };
  }, [key, userId, emailId]);

  const mail = current?.kind === "open" ? current.mail : null;
  const body = mail ? mail.text?.trim() || (mail.html ? htmlToText(mail.html) : "") : "";

  return (
    <>
      {mail ? (
        <>
          <p className="mt-1 text-sm leading-snug">{mail.subject}</p>
          <p className="mt-0.5 truncate text-xs text-neutral-500">{mail.from_name ? `${mail.from_name} <${mail.from_address}>` : mail.from_address}</p>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm leading-snug text-neutral-500">🔒 暗号化されたメール</p>
          {fromDomain ? <p className="mt-0.5 truncate text-xs text-neutral-500">{fromDomain}</p> : null}
        </>
      )}
      {confidence}
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-sky-700">元メールを見る</summary>
        {notes ? <p className="mt-2 text-xs leading-5 text-neutral-500">読み取りメモ: {notes}</p> : null}
        <div className="mt-2">
          {!key ? (
            <>
              <p className="mb-2 text-xs text-neutral-600">合言葉で開きます。このタブを閉じるまで覚えます。</p>
              <UnlockForm userId={userId} />
            </>
          ) : !current ? (
            <p className="text-xs text-neutral-500">開いています…</p>
          ) : current.kind === "old-key" ? (
            <p className="text-xs text-neutral-600">前の合言葉で暗号化したメールです。もう開けません。</p>
          ) : current.kind === "failed" ? (
            <p className="text-xs text-red-800">開けませんでした</p>
          ) : (
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-neutral-50 p-3 text-xs leading-5 text-neutral-700">{body || "（本文なし）"}</pre>
          )}
        </div>
      </details>
    </>
  );
}
