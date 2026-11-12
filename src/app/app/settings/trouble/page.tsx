import Link from "next/link";
import { FoldCard, PitfallBody } from "@/components/forwarding-steps";
import { FORWARDING_PITFALLS, PITFALLS_HEADING, PITFALLS_LEAD } from "@/lib/forwarding-guide";
import { createClient, getUser } from "@/lib/supabase/server";
import { readAiReadingConsent } from "@/lib/ai-consent";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";
import { READ_FAILED_REASON, READ_OVER_LIMIT_REASON, READ_STOPPED_BUTTON, READ_STOPPED_REASON, READ_STORAGE_LIMIT_NOTICE, READ_STORAGE_LIMIT_BODY, READ_STORAGE_LIMIT_REASON, READ_STORAGE_NOTICE_FAILED, READ_STORAGE_CONFIRM, READ_STORAGE_CONFIRMING } from "@/lib/read-notices";
import { settingsErrorMessage } from "@/lib/settings-errors";
import { dismissIntakeNotice, readWaitingMail } from "../actions";
import { PressButton } from "../press";
import { readIntakeNotice, readUnreadCount, readUnreadReasons } from "../settings-reads";
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
  // The reasons are told only from counts that were read; when they were not, no reason is stated.
  const intake = await readIntakeNotice(supabase, "settings trouble");
  const reasons = waiting !== null && waiting > 0 ? await readUnreadReasons(supabase, "settings trouble") : null;
  const user = waiting !== null && waiting > 0 ? await getUser() : null;
  const consent = user ? await readAiReadingConsent(supabase, user.id) : "unknown";

  return (
    <SubPage title="うまく届かないとき">
      {intake.failed ? <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{READ_STORAGE_NOTICE_FAILED}</p> : intake.at ? (
        <section role="alert" className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-sm">
          <p>{READ_STORAGE_LIMIT_NOTICE}</p>
          <p className="mt-1">{READ_STORAGE_LIMIT_BODY}</p>
          <p className="mt-1">{READ_STORAGE_LIMIT_REASON}</p>
          <form action={dismissIntakeNotice} className="mt-3">
            <input type="hidden" name="limited_at" value={intake.at} />
            <PressButton label={READ_STORAGE_CONFIRM} busyLabel={READ_STORAGE_CONFIRMING} className="rounded-lg border border-neutral-900 px-4 py-2 text-sm font-medium" />
          </form>
        </section>
      ) : null}
      {waiting === null ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">未読のメールの数を読み込めませんでした</p>
      ) : waiting > 0 ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-base font-bold">未読のメールが {waiting} 通あります</h2>
          {reasons && reasons.stopped > 0 ? (
            <>
              <p className="mt-1 text-sm leading-6">{READ_STOPPED_REASON}</p>
              <Link href="/app/parcels/new" className="mt-2 inline-block rounded-lg border border-neutral-900 px-4 py-2 text-sm font-medium">
                {READ_STOPPED_BUTTON}
              </Link>
            </>
          ) : null}
          {reasons && reasons.overLimit > 0 ? <p className="mt-1 text-sm leading-6">{READ_OVER_LIMIT_REASON}</p> : null}
          {reasons && reasons.failed > 0 ? <p className="mt-1 text-sm leading-6">{READ_FAILED_REASON}</p> : null}
          {consent === "granted" ? (
            <form action={readWaitingMail} className="mt-3">
              <PressButton label="読み取る" busyLabel="読み取っています…" className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white" />
            </form>
          ) : consent === "unknown" ? (
            <div role="alert" className="mt-3 text-sm">
              <p>{AI_CONSENT_TEXT.readFailed}</p>
              <Link href="/app/settings/trouble" className="mt-2 inline-flex min-h-11 items-center underline underline-offset-4">{AI_CONSENT_TEXT.retry}</Link>
            </div>
          ) : (
            <Link href="/app/reading?after=settings" className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white">{AI_CONSENT_TEXT.start}</Link>
          )}
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
