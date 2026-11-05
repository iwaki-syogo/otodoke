"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { passphraseProblem, PASSPHRASE_MIN_LENGTH } from "@/lib/crypto/key-wrap";
import { changePassphrase, createMailKey, keyErrorText, useTabKey } from "@/lib/crypto/tab-key";
import { UnlockForm } from "../unlock-form";
import { sealStoredMail } from "./key-actions";

export interface MailKeyState {
  userId: string;
  /** When the key in use was made, or null when there is none. */
  keyCreatedAt: string | null;
  /** Read mail still stored in plaintext (from before encryption, or samples). null: could not count. */
  plainCount: number | null;
  /** Mail sealed to a key that is no longer in use (the passphrase was forgotten). */
  oldKeyCount: number;
}

const input = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base";
const primary = "rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-60";

export function MailKeyPanel({ state }: { state: MailKeyState }) {
  const { userId, keyCreatedAt, plainCount, oldKeyCount } = state;
  const opened = useTabKey(userId);

  if (!keyCreatedAt) {
    return (
      <section className="rounded-2xl border border-sky-300 bg-sky-50 p-4">
        <h2 className="text-base font-bold">合言葉を決める</h2>
        <p className="mt-1 text-sm leading-6">届いたメールは、この合言葉でしか開けない形で保存します。運営者にも読めません。</p>
        {plainCount ? <p className="mt-1 text-sm leading-6">保存済みのメール {plainCount} 通も、決めたあとに暗号化できます。</p> : null}
        <NewKeyForm userId={userId} button="決める" busyLabel="準備しています…" acknowledge="忘れたら、前のメールは誰にも戻せない（荷物は残る）" />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-bold">合言葉</h2>
      {plainCount ? <SealBanner count={plainCount} /> : null}
      {plainCount === null ? <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">暗号化されていないメールの数を読み込めませんでした</p> : null}
      {oldKeyCount > 0 ? <p className="text-sm leading-6 text-neutral-600">前の合言葉のメール {oldKeyCount} 通は、もう開けません。荷物は残っています。</p> : null}
      <div className="rounded-2xl border border-neutral-200 bg-white p-4">
        {opened ? (
          <p className="text-sm">このタブではメールを開けます。タブを閉じると忘れます。</p>
        ) : (
          <>
            <p className="mb-2 text-sm text-neutral-600">元メールを見るときに使います。</p>
            <UnlockForm userId={userId} />
          </>
        )}
      </div>
      <details className="rounded-2xl border border-neutral-200 bg-white">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">合言葉を変える</summary>
        <div className="border-t border-neutral-100 p-4">
          <ChangeForm userId={userId} />
        </div>
      </details>
      <details className="rounded-2xl border border-neutral-200 bg-white">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">合言葉を忘れたとき</summary>
        <div className="border-t border-neutral-100 p-4">
          <p className="text-sm leading-6">新しい合言葉を作ります。前のメールは開けなくなります。荷物は残ります。</p>
          <NewKeyForm userId={userId} button="作り直す" busyLabel="作り直しています…" acknowledge="前のメールが開けなくなる" />
        </div>
      </details>
    </section>
  );
}

function NewKeyForm({ userId, button, busyLabel, acknowledge }: { userId: string; button: string; busyLabel: string; acknowledge: string }) {
  const router = useRouter();
  const [first, setFirst] = useState("");
  const [again, setAgain] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = passphraseProblem(first, again);
    if (problem) return setError(problem);
    if (!agreed) return setError("チェックを入れてください");
    setBusy(true);
    setError(null);
    try {
      await createMailKey(userId, first);
      setFirst("");
      setAgain("");
      router.refresh();
    } catch (err) {
      setError(keyErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    // No `name` on any field, POST: submitted before the script runs, it sends nothing (see UnlockForm).
    <form method="post" onSubmit={submit} className="mt-3 flex flex-col gap-2">
      <input type="text" autoComplete="username" value="Otodoke 合言葉" readOnly hidden />
      <input type="password" autoComplete="new-password" aria-label="合言葉" placeholder={`合言葉（${PASSPHRASE_MIN_LENGTH} 文字以上）`} value={first} onChange={(e) => setFirst(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" aria-label="合言葉をもう一度" placeholder="もう一度" value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
      <label className="flex items-start gap-2 text-sm leading-6">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-4 w-4 shrink-0" />
        {acknowledge}
      </label>
      <button type="submit" disabled={busy} className={primary}>
        {busy ? busyLabel : button}
      </button>
      {error ? <p className="text-sm text-red-800">{error}</p> : null}
    </form>
  );
}

function ChangeForm({ userId }: { userId: string }) {
  const [old, setOld] = useState("");
  const [first, setFirst] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = passphraseProblem(first, again);
    if (problem) return setMessage({ ok: false, text: problem });
    setBusy(true);
    setMessage(null);
    try {
      await changePassphrase(userId, old, first);
      setOld("");
      setFirst("");
      setAgain("");
      setMessage({ ok: true, text: "変えました。前のメールも新しい合言葉で開けます" });
    } catch (err) {
      setMessage({ ok: false, text: keyErrorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    // No `name` on any field, POST: submitted before the script runs, it sends nothing (see UnlockForm).
    <form method="post" onSubmit={submit} className="flex flex-col gap-2">
      <input type="text" autoComplete="username" value="Otodoke 合言葉" readOnly hidden />
      <input type="password" autoComplete="current-password" aria-label="今の合言葉" placeholder="今の合言葉" value={old} onChange={(e) => setOld(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" aria-label="新しい合言葉" placeholder={`新しい合言葉（${PASSPHRASE_MIN_LENGTH} 文字以上）`} value={first} onChange={(e) => setFirst(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" aria-label="新しい合言葉をもう一度" placeholder="もう一度" value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
      <button type="submit" disabled={busy || !old} className={primary}>
        {busy ? "変えています…" : "変える"}
      </button>
      {message ? <p className={`text-sm ${message.ok ? "text-emerald-800" : "text-red-800"}`}>{message.text}</p> : null}
    </form>
  );
}

/** 「暗号化する」: batches of 50 until none is left, showing what remains. */
function SealBanner({ count }: { count: number }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(count);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function run() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      for (;;) {
        const res = await sealStoredMail();
        if (!res.ok) throw new Error(res.error);
        setRemaining(res.remaining);
        if (res.remaining === 0) {
          setDone(true);
          break;
        }
        // Nothing moved: stop instead of looping (another tab may be sealing the same rows).
        if (res.sealed === 0) throw new Error("stalled");
      }
      router.refresh();
    } catch {
      setError("途中で止まりました。もう一度押すと続きから暗号化します");
    } finally {
      setBusy(false);
    }
  }

  if (done) return <p className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm">すべて暗号化しました（残り 0 通）</p>;
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-bold">暗号化されていないメールが {remaining} 通あります</p>
      <button type="button" onClick={run} disabled={busy} className={`mt-3 ${primary}`}>
        {busy ? `暗号化しています…あと ${remaining} 通` : "暗号化する"}
      </button>
      {error ? <p className="mt-2 text-sm text-red-800">{error}</p> : null}
    </div>
  );
}
