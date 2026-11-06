import { FoldCard, PitfallBody } from "@/components/forwarding-steps";
import { FORWARDING_PITFALLS, PITFALLS_HEADING, PITFALLS_LEAD } from "@/lib/forwarding-guide";
import { createClient } from "@/lib/supabase/server";
import { settingsErrorMessage } from "@/lib/settings-errors";
import { readWaitingMail } from "../actions";
import { PressButton } from "../press";
import { readUnreadCount } from "../settings-reads";
import { RowCard, RowLink } from "../settings-row";
import { SubPage } from "../sub-page";

export const metadata = { title: "うまく届かないとき" };

// 「読み取る」 posts readWaitingMail from this page: up to 20 mails read with Claude.
export const maxDuration = 300;

type SearchParams = Promise<{ error?: string }>;

export default async function TroublePage({ searchParams }: { searchParams: SearchParams }) {
  const { error } = await searchParams;
  const errorMessage = settingsErrorMessage(error);
  const supabase = await createClient();
  // A count that failed is told apart from none: by null, never by 0.
  const waiting = await readUnreadCount(supabase, "settings trouble");

  return (
    <SubPage title="うまく届かないとき">
      {waiting === null ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
      ) : waiting > 0 ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-base font-bold">未読のメールが {waiting} 通あります</h2>
          <p className="mt-1 text-sm leading-6">1 日の上限を超えたか、読み取りに失敗したメールです。保存してあるので、もう一度読み取れます。</p>
          <form action={readWaitingMail} className="mt-3">
            <PressButton label="読み取る" busyLabel="読み取っています…" className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white" />
          </form>
        </section>
      ) : (
        <p className="text-sm leading-6 text-neutral-600">未読のメールはありません。</p>
      )}
      {errorMessage ? <p className="-mt-4 break-words text-sm text-red-800">{errorMessage}</p> : null}
      <section>
        <h2 className="text-base font-bold">{PITFALLS_HEADING}</h2>
        <p className="mt-1 text-sm leading-6 text-neutral-600">{PITFALLS_LEAD}</p>
        <div className="mt-2 flex flex-col gap-2">
          {FORWARDING_PITFALLS.map((p) => (
            <FoldCard key={p.title} title={p.title}>
              <PitfallBody pitfall={p} />
            </FoldCard>
          ))}
        </div>
      </section>
      <RowCard>
        <RowLink href="/app/settings/dropped" icon="dropped" title="読まなかったメール" />
        <RowLink href="/app/settings/forwarding" icon="forwarding" title="メールの転送" />
      </RowCard>
    </SubPage>
  );
}
