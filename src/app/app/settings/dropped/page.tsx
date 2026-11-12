import Link from "next/link";
import { createClient, getUser } from "@/lib/supabase/server";
import { isRememberableDomain } from "@/lib/screen-senders";
import { formatDateTimeJa } from "@/lib/format";
import { NO_SUBJECT_TEXT, isBlankSubject } from "@/lib/mail-notices";
import { readAll } from "@/lib/supabase/read-all";
import { settingsErrorMessage } from "@/lib/settings-errors";
import type { Tables } from "@/lib/db/database.types";
import { forgetSender, markWronglyDropped } from "../actions";
import { PressButton } from "../press";
import { SubPage } from "../sub-page";
import { redirect } from "next/navigation";

export const metadata = { title: "読まなかったメール" };

type DroppedRow = Pick<Tables<"screen_events">, "id" | "subject" | "from_domain" | "created_at" | "flagged_at">;

type SearchParams = Promise<{ error?: string; flagged?: string; unflagged?: string }>;

/** What 「これは荷物」 / 「外す」 answer (?flagged= / ?unflagged=): fixed words for a code, never text from the link. */
const SENDER_NOTES = {
  flagged: {
    remembered: { ok: true, register: true, text: "覚えました。この差出人のメールは、次から Claude が確認します。今回の荷物は手で登録できます。" },
    shared: { ok: true, register: true, text: "Gmail など多くの人が使うアドレスは、差出人として覚えられません。今回の荷物は手で登録できます。" },
    forwarded: { ok: true, register: true, text: "手で転送されたメールは、差出人として覚えられません。今回の荷物は手で登録できます。" },
    own: { ok: true, register: true, text: "ご自身のアドレスから届いたメールは、差出人として覚えられません。今回の荷物は手で登録できます。" },
    failed: { ok: false, register: false, text: "記録できませんでした。もう一度お試しください。" },
  },
  unflagged: {
    done: { ok: true, register: false, text: "外しました。" },
    failed: { ok: false, register: false, text: "外せませんでした。もう一度お試しください。" },
  },
} as const;

type SenderNote = { ok: boolean; register: boolean; text: string };

function senderNote(kind: keyof typeof SENDER_NOTES, code: string | undefined): SenderNote | null {
  const notes: Record<string, SenderNote> = SENDER_NOTES[kind];
  return code && Object.hasOwn(notes, code) ? notes[code] : null;
}

export default async function DroppedPage({ searchParams }: { searchParams: SearchParams }) {
  const { error, flagged, unflagged } = await searchParams;
  const note = senderNote("flagged", flagged) ?? senderNote("unflagged", unflagged);
  const errorMessage = settingsErrorMessage(error);
  const supabase = await createClient();
  const user = await getUser();
  if (!user) redirect("/login");
  // Every dropped mail, newest first: the heading's count is the whole count, and each one can be marked.
  let dropped: DroppedRow[] | null;
  try {
    dropped = await readAll<DroppedRow>(() =>
      supabase
        .from("screen_events")
        .select("id, subject, from_domain, created_at, flagged_at", { count: "exact" })
        .eq("decision", "dropped")
        .order("created_at", { ascending: false }),
    );
  } catch (err) {
    dropped = null;
    console.error("settings dropped:", err instanceof Error ? err.message : err);
  }
  // A failed read is told apart from no dropped mail: by the failure, never by the empty list.
  const droppedError = dropped === null;
  // The senders 「これは荷物」 remembered, from the marked rows (kept past 14 days). A mark made on
  // a shared domain before that was refused is not honoured by the pipeline, so it is not listed.
  const remembered = [...new Set((dropped ?? []).filter((d) => d.flagged_at && isRememberableDomain(d.from_domain)).map((d) => d.from_domain!))].sort();

  return (
    <SubPage title="読まなかったメール">
      <section>
        <p className="text-sm leading-6 text-neutral-600">広告など、買い物に関係なさそうなメールです。本文は保存せず、件名と差出人のドメインだけ 14 日間残します。</p>
        {note ? (
          <div className={`mt-2 text-sm leading-6 ${note.ok ? "text-emerald-800" : "text-red-800"}`}>
            <p>{note.text}</p>
            {note.register ? (
              <Link href="/app/parcels/new" className="mt-2 inline-block rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm font-medium text-neutral-900">
                荷物を登録する
              </Link>
            ) : null}
          </div>
        ) : null}
        {errorMessage ? <p className="mt-2 break-words text-sm text-red-800">{errorMessage}</p> : null}
        {droppedError ? (
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
        ) : dropped && dropped.length > 0 ? (
          <details className="mt-2 rounded-2xl border border-neutral-200 bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">荷物のメールが混ざっていないか、{dropped.length} 通を見る</summary>
            <ul className="divide-y divide-neutral-100 border-t border-neutral-100">
              {dropped.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className={!isBlankSubject(d.subject) ? "truncate text-sm" : "truncate text-sm text-neutral-500"}>{!isBlankSubject(d.subject) ? d.subject : NO_SUBJECT_TEXT}</p>
                    <p className="truncate text-xs text-neutral-500">
                      {d.from_domain} ・ {formatDateTimeJa(d.created_at)}
                    </p>
                  </div>
                  {d.flagged_at ? (
                    <span className="shrink-0 text-xs text-emerald-800">荷物として記録済み</span>
                  ) : (
                    <form action={markWronglyDropped} className="shrink-0">
                      <input type="hidden" name="expectedUserId" value={user.id} />
                      <input type="hidden" name="id" value={d.id} />
                      <PressButton label="これは荷物" busyLabel="記録しています…" className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium" />
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">まだありません</p>
        )}
        {remembered.length > 0 ? (
          <div className="mt-3">
            <h3 className="text-sm font-bold">覚えた差出人</h3>
            <ul className="mt-2 divide-y divide-neutral-100 rounded-2xl border border-neutral-200 bg-white">
              {remembered.map((domain) => (
                <li key={domain} className="flex items-center gap-3 px-4 py-3">
                  <p className="min-w-0 flex-1 truncate text-sm">{domain}</p>
                  <form action={forgetSender} className="shrink-0">
                    <input type="hidden" name="expectedUserId" value={user.id} />
                    <input type="hidden" name="domain" value={domain} />
                    <PressButton label="外す" busyLabel="外しています…" className="rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium" />
                  </form>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </SubPage>
  );
}
