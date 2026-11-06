"use client";

import { useEffect, useState } from "react";
import { openMail, WrongKeyError, type MailPlaintext } from "@/lib/crypto/envelope";
import { useTabKey } from "@/lib/crypto/tab-key";
import { LOGIN_MESSAGES } from "@/lib/login-errors";
import { htmlToText } from "@/lib/text/html-to-text";
import { readSealedMail } from "@/app/app/settings/key-actions";
import { UnlockForm } from "../../unlock-form";

type Opened = { kind: "open"; mail: MailPlaintext } | { kind: "old-key" } | { kind: "failed" };

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
 * Mail sealed to an earlier key (made before a reset, or before password-v1) does not open with
 * the password: the screen says so, and offers nothing to open it with. `email` is the session's
 * address, which opening the key again needs.
 */
export function SealedMail({ userId, email, emailId, fromDomain, notes, confidence }: { userId: string; email: string | null; emailId: string; fromDomain: string | null; notes: string | null; confidence: React.ReactNode }) {
  const key = useTabKey(userId);
  const [opened, setOpened] = useState<{ keyId: string; result: Opened } | null>(null);
  const current = key && opened?.keyId === key.keyId ? opened.result : null;

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    (async (): Promise<Opened> => {
      const res = await readSealedMail({ emailId });
      if (!res.ok || !res.envelope) return { kind: "failed" };
      if (kidOf(res.envelope) !== key.keyId) return { kind: "old-key" };
      try {
        return { kind: "open", mail: await openMail(key, userId, emailId, res.envelope) };
      } catch (err) {
        return err instanceof WrongKeyError ? { kind: "old-key" } : { kind: "failed" };
      }
    })()
      .catch((): Opened => ({ kind: "failed" }))
      .then((result) => {
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
            email ? (
              <>
                <p className="mb-2 text-xs text-neutral-600">パスワードで開きます。このタブを閉じるまで覚えます。</p>
                <UnlockForm userId={userId} email={email} />
              </>
            ) : (
              <p className="text-xs text-neutral-600">{LOGIN_MESSAGES.signed_out}</p>
            )
          ) : !current ? (
            <p className="text-xs text-neutral-500">開いています…</p>
          ) : current.kind === "old-key" ? (
            <p className="text-xs text-neutral-600">前の鍵で暗号化したメールです。開けません。</p>
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
