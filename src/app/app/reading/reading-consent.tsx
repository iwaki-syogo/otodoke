import Link from "next/link";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";
import { setAiReadingDecision } from "./actions";

/** Used before the first choice and when the person asks to allow reading again. */
export function ReadingConsent({ userId, unknown = false, error, after = "list" }: { userId: string; unknown?: boolean; error?: "save"; after?: "list" | "welcome" | "settings" }) {
  const retryHref = after === "list" ? "/app/reading" : `/app/reading?after=${after}`;
  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">{AI_CONSENT_TEXT.title}</h1>
        <p className="mt-3 text-sm leading-6 text-neutral-700">{AI_CONSENT_TEXT.body}</p>
        <p className="mt-2 text-sm leading-6 text-neutral-700">{AI_CONSENT_TEXT.detail}</p>
        <Link href="/privacy" className="mt-2 inline-flex min-h-11 items-center text-sm text-sky-700 underline underline-offset-4">{AI_CONSENT_TEXT.privacy}</Link>
      </div>
      {unknown ? (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p>{AI_CONSENT_TEXT.readFailed}</p>
          <Link href={retryHref} className="mt-3 inline-flex min-h-11 items-center underline underline-offset-4">{AI_CONSENT_TEXT.retry}</Link>
        </div>
      ) : (
        <form action={setAiReadingDecision} className="flex flex-col gap-3">
          <input type="hidden" name="expectedUserId" value={userId} />
          <input type="hidden" name="after" value={after} />
          {error ? <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{AI_CONSENT_TEXT.saveFailed}</p> : null}
          <button name="decision" value="granted" type="submit" className="min-h-12 w-full rounded-xl bg-neutral-900 px-5 py-3 text-base font-medium text-white active:opacity-80">{AI_CONSENT_TEXT.allow}</button>
          <button name="decision" value="declined" type="submit" className="min-h-12 w-full rounded-xl border border-neutral-300 bg-white px-5 py-3 text-base font-medium active:bg-neutral-100">{AI_CONSENT_TEXT.decline}</button>
        </form>
      )}
      <div className="flex flex-col gap-3">
        <Link href="/app/settings/demo" className="inline-flex min-h-12 w-full items-center justify-center rounded-xl border border-neutral-300 bg-white px-5 py-3 text-sm font-medium active:bg-neutral-100">{AI_CONSENT_TEXT.sample}</Link>
        <Link href="/app/parcels/new" className="inline-flex min-h-11 items-center justify-center text-sm text-neutral-600 underline underline-offset-4">{AI_CONSENT_TEXT.manual}</Link>
      </div>
    </section>
  );
}
