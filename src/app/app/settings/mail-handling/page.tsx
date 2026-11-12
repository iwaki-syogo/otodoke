import Link from "next/link";
import { MailHandling } from "../mail-handling";
import { SubPage } from "../sub-page";
import { readAiReadingConsent } from "@/lib/ai-consent";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";
import { createClient, getUser } from "@/lib/supabase/server";
import { setAiReadingDecision } from "../../reading/actions";
import { PressButton } from "../press";

export const metadata = { title: "あなたのメールの扱い" };
// The same permission action may read the waiting mail after a grant.
export const maxDuration = 300;

export default async function MailHandlingPage() {
  const user = (await getUser())!;
  const consent = await readAiReadingConsent(await createClient(), user.id);
  return (
    <SubPage title="あなたのメールの扱い">
      {consent === "granted" ? (
        <div className="flex flex-col gap-3">
          <form action={setAiReadingDecision}>
            <input type="hidden" name="expectedUserId" value={user.id} />
            <input type="hidden" name="decision" value="declined" />
            <input type="hidden" name="after" value="settings" />
            <PressButton label={AI_CONSENT_TEXT.stop} busyLabel={AI_CONSENT_TEXT.stop} className="min-h-12 w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-medium active:bg-neutral-100" />
          </form>
          <Link href="/app/settings/trouble" className="inline-flex min-h-11 items-center text-sm text-sky-700 underline underline-offset-4">{AI_CONSENT_TEXT.waiting}</Link>
        </div>
      ) : consent === "unknown" ? (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p>{AI_CONSENT_TEXT.readFailed}</p>
          <Link href="/app/settings/mail-handling" className="mt-3 inline-flex min-h-11 items-center underline underline-offset-4">{AI_CONSENT_TEXT.retry}</Link>
        </div>
      ) : (
        <Link href="/app/reading?after=settings" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-medium active:bg-neutral-100">{AI_CONSENT_TEXT.start}</Link>
      )}
      <MailHandling hideHeading />
      {/* The whole policy, right under the summary of how mail is handled. */}
      <p className="-mt-6 text-xs text-neutral-500">
        <Link href="/privacy" className="underline underline-offset-4">
          プライバシーポリシー
        </Link>
      </p>
    </SubPage>
  );
}
