"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { passphraseProblem, PASSPHRASE_MIN_LENGTH, PASSPHRASE_RULE } from "@/lib/crypto/key-wrap";
import { changePassphrase, createMailKey, keyErrorText, PassphraseChangeUnconfirmedError, useTabKey } from "@/lib/crypto/tab-key";
import { UnlockForm } from "../unlock-form";
import { sealStoredMail } from "./key-actions";
import { BUSY, pressLabel } from "./press";

export interface MailKeyState {
  userId: string;
  /** When the key in use was made, or null when there is none. */
  keyCreatedAt: string | null;
  /** The id of the key in use (null: none). Sent back when a key is made, so a stale screen is refused. */
  currentKeyId: string | null;
  /** Read mail still stored in plaintext (from before encryption; public samples not counted). null: could not count. */
  plainCount: number | null;
  /** Mail sealed to a key that is no longer in use (the passphrase was forgotten). */
  oldKeyCount: number;
}

/**
 * Decision 7 (2026-11-06): the plaintext subject, sender and body of read mail of a user with no
 * key in use are removed on 2026-11-14 (supabase/pending/20261114090000). Told here and in
 * 「あなたのメールの扱い」 (mail-handling.tsx) until then; reword both once it has run.
 */
const PLAINTEXT_DROP_NOTICE = "決めないままだと、11 月 14 日に件名・差出人・本文を消します。荷物は残ります。";

/** Not knowing how many mails are in plaintext is said as such, with or without a key: never as "none". */
const PLAIN_COUNT_FAILED = "暗号化されていないメールの数を読み込めませんでした";

const input = "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base";
// Busy is shown with aria-disabled and BUSY, never `disabled` (src/app/app/settings/press.tsx).
const primary = "inline-flex items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-60";
const busyClass = (busy: boolean) => (busy ? ` ${BUSY}` : "");

export function MailKeyPanel({ state }: { state: MailKeyState }) {
  const { userId, keyCreatedAt, currentKeyId, plainCount, oldKeyCount } = state;
  const opened = useTabKey(userId);

  if (!keyCreatedAt) {
    return (
      <section className="rounded-2xl border border-sky-300 bg-sky-50 p-4">
        <h2 className="text-base font-bold">合言葉を決める</h2>
        <p className="mt-1 text-sm leading-6">読み取った後のメールの件名・差出人・本文は、この合言葉でしか開けない形で保存します。運営者もデータベースからは読めません。</p>
        {plainCount ? (
          <p className="mt-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-bold leading-6">
            暗号化されていない保存済みのメール {plainCount} 通も、決めたあとに暗号化できます。それまでは運営者が読める形です。{PLAINTEXT_DROP_NOTICE}
          </p>
        ) : null}
        {plainCount === null ? <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{PLAIN_COUNT_FAILED}</p> : null}
        <NewKeyForm userId={userId} expectedKeyId={null} button="決める" busyLabel="準備しています…" acknowledge="忘れたら、前のメールは誰にも戻せない（荷物は残る）" />
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-bold">合言葉</h2>
      {plainCount ? <SealBanner count={plainCount} /> : null}
      {plainCount === null ? <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{PLAIN_COUNT_FAILED}</p> : null}
      {oldKeyCount > 0 ? <p className="text-sm leading-6 text-neutral-600">前の合言葉で暗号化したメールが {oldKeyCount} 通あります。前の合言葉を覚えていれば、メールの画面から開けます。荷物は残っています。</p> : null}
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
          <NewKeyForm userId={userId} expectedKeyId={currentKeyId} button="作り直す" busyLabel="作り直しています…" acknowledge="前のメールが開けなくなる" />
        </div>
      </details>
    </section>
  );
}

function NewKeyForm({ userId, expectedKeyId, button, busyLabel, acknowledge }: { userId: string; expectedKeyId: string | null; button: string; busyLabel: string; acknowledge: string }) {
  const router = useRouter();
  const [first, setFirst] = useState("");
  const [again, setAgain] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  // A ref, not state: a second press (or Enter) can come before React has drawn the first.
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    const problem = passphraseProblem(first, again);
    if (problem) return setError(problem);
    if (!agreed) return setError("チェックを入れてください");
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await createMailKey(userId, first, expectedKeyId);
      setFirst("");
      setAgain("");
      router.refresh();
    } catch (err) {
      setError(keyErrorText(err));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    // No `name` on any field, POST: submitted before the script runs, it sends nothing (see UnlockForm).
    <form method="post" onSubmit={submit} className="mt-3 flex flex-col gap-2">
      <input type="text" autoComplete="username" value="Otodoke 合言葉" readOnly hidden />
      <input type="password" autoComplete="new-password" aria-label="合言葉" placeholder={`合言葉（${PASSPHRASE_MIN_LENGTH} 文字以上）`} value={first} onChange={(e) => setFirst(e.target.value)} className={input} />
      <input type="password" autoComplete="new-password" aria-label="合言葉をもう一度" placeholder="もう一度" value={again} onChange={(e) => setAgain(e.target.value)} className={input} />
      <p className="text-xs leading-5 text-neutral-500">{PASSPHRASE_RULE}</p>
      <label className="flex items-start gap-2 text-sm leading-6">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-1 h-4 w-4 shrink-0" />
        {acknowledge}
      </label>
      <button type="submit" aria-disabled={busy || undefined} aria-busy={busy || undefined} className={`${primary}${busyClass(busy)}`}>
        {pressLabel(busy, button, busyLabel)}
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
  const running = useRef(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (running.current || !old) return;
    const problem = passphraseProblem(first, again);
    if (problem) return setMessage({ ok: false, text: problem });
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await changePassphrase(userId, old, first);
      setOld("");
      setFirst("");
      setAgain("");
      setMessage({ ok: true, text: "変えました。前のメールも新しい合言葉で開けます" });
    } catch (err) {
      // Most likely changed: the old passphrase no longer opens it, so do not leave it in the form.
      if (err instanceof PassphraseChangeUnconfirmedError) {
        setOld("");
        setFirst("");
        setAgain("");
      }
      setMessage({ ok: false, text: keyErrorText(err) });
    } finally {
      running.current = false;
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
      <p className="text-xs leading-5 text-neutral-500">{PASSPHRASE_RULE}</p>
      {/* disabled only while 「今の合言葉」 is empty (nothing to send yet), never while busy. */}
      <button type="submit" disabled={!busy && !old} aria-disabled={busy || undefined} aria-busy={busy || undefined} className={`${primary}${busyClass(busy)}`}>
        {pressLabel(busy, "変える", "変えています…")}
      </button>
      {message ? <p className={`text-sm ${message.ok ? "text-emerald-800" : "text-red-800"}`}>{message.text}</p> : null}
    </form>
  );
}

/** 「暗号化する」: batches of 50 until none is left, showing what remains (public samples are not counted). */
export function SealBanner({ count }: { count: number }) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(count);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [unsealable, setUnsealable] = useState(0);

  async function run() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    // Where this run is (the server's cursor), and how many rows could not be sealed on the way.
    // Every row a batch looks at ends up behind the cursor, so failed rows never hold the run back.
    let after: string | null = null;
    let failedCount = 0;
    try {
      for (;;) {
        const res = await sealStoredMail({ after });
        if (!res.ok) throw new Error(res.error);
        failedCount += res.failed.length;
        setUnsealable(failedCount);
        // Still in plaintext: what is left after the cursor plus what could not be sealed.
        setRemaining(res.remaining + failedCount);
        if (res.remaining === 0) {
          if (failedCount === 0) setDone(true);
          break;
        }
        // The cursor did not move: stop instead of looping.
        if (res.next === after) throw new Error("stalled");
        after = res.next;
      }
      router.refresh();
    } catch {
      setError("途中で止まりました。もう一度押すと続きから暗号化します");
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  if (done) return <p className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4 text-sm">すべて暗号化しました（残り 0 通）</p>;
  return (
    <div className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <p className="text-sm font-bold">暗号化されていないメールが {remaining} 通あります</p>
      <p className="mt-1 text-sm leading-6">暗号化を始める前に読み取ったメールなどです。押すまでは、運営者が読める形で残ります。</p>
      <button type="button" onClick={run} aria-disabled={busy || undefined} aria-busy={busy || undefined} className={`mt-3 ${primary}${busyClass(busy)}`}>
        {pressLabel(busy, "暗号化する", `暗号化しています…あと ${remaining} 通`)}
      </button>
      {error ? <p className="mt-2 text-sm text-red-800">{error}</p> : null}
      {unsealable > 0 && !busy ? <p className="mt-2 text-sm text-red-800">暗号化できなかったメールが {unsealable} 通ありました。もう一度押すと試し直します</p> : null}
    </div>
  );
}
