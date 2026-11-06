"use client";

import { useEffect, useState } from "react";
import { openMail, WrongKeyError, type MailPlaintext } from "@/lib/crypto/envelope";
import { useRetiredTabKeys, useTabKey } from "@/lib/crypto/tab-key";
import { htmlToText } from "@/lib/text/html-to-text";
import { readSealedMail } from "@/app/app/settings/key-actions";
import { UnlockForm } from "../../unlock-form";

type Opened = { kind: "open"; mail: MailPlaintext } | { kind: "old-key"; keyId: string | null } | { kind: "failed" };

/** The key id an envelope was sealed to, or null when it has none readable. */
function kidOf(envelope: unknown): string | null {
  const kid = envelope && typeof envelope === "object" ? (envelope as { kid?: unknown }).kid : null;
  return typeof kid === "string" && /^[0-9a-f]{32}$/.test(kid) ? kid : null;
}

/**
 * A stored mail sealed to the user's key. Shown as a neutral line until the key is open in this
 * tab; then the envelope is fetched through a Server Action (the browser has no database client)
 * and opened here, in the browser. The body is shown as text only: the HTML part is turned into
 * text, never rendered.
 *
 * Mail sealed to a retired key (the key was made again) opens with that key: the one opened with
 * the same passphrase when the tab unlocked, or one opened here with the passphrase it had.
 */
export function SealedMail({ userId, emailId, fromDomain, notes, confidence }: { userId: string; emailId: string; fromDomain: string | null; notes: string | null; confidence: React.ReactNode }) {
  const key = useTabKey(userId);
  const retired = useRetiredTabKeys(userId);
  const [opened, setOpened] = useState<{ token: string; result: Opened } | null>(null);
  const token = key ? `${key.keyId}|${Object.keys(retired).sort().join(",")}` : null;
  const current = token && opened?.token === token ? opened.result : null;

  useEffect(() => {
    if (!key || !token) return;
    let cancelled = false;
    (async (): Promise<Opened> => {
      const res = await readSealedMail({ emailId });
      if (!res.ok || !res.envelope) return { kind: "failed" };
      const kid = kidOf(res.envelope);
      const recipient = kid === key.keyId ? key : kid ? retired[kid] : undefined;
      if (!recipient) return { kind: "old-key", keyId: kid };
      try {
        return { kind: "open", mail: await openMail(recipient, userId, emailId, res.envelope) };
      } catch (err) {
        return err instanceof WrongKeyError ? { kind: "old-key", keyId: kid } : { kind: "failed" };
      }
    })()
      .catch((): Opened => ({ kind: "failed" }))
      .then((result) => {
        if (!cancelled) setOpened({ token, result });
      });
    return () => {
      cancelled = true;
    };
  }, [key, retired, token, userId, emailId]);

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
            current.keyId ? (
              <>
                <p className="mb-2 text-xs text-neutral-600">前の合言葉で暗号化したメールです。前の合言葉で開けます。</p>
                <UnlockForm userId={userId} retiredKeyId={current.keyId} label="前の合言葉で開く" />
              </>
            ) : (
              <p className="text-xs text-neutral-600">前の合言葉で暗号化したメールです。開けませんでした。</p>
            )
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
