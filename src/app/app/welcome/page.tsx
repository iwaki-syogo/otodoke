import { RefreshUntilApproval } from "@/components/refresh-until-approval";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { ApprovalFilterCopy, FoldCard, GuideCardBody, VideoCredit } from "@/components/forwarding-steps";
import { FORWARDING_GUIDES, FORWARDING_TITLE, type ForwardingGuide } from "@/lib/forwarding-guide";
import { ensureInboxAddress, inboxEmail } from "@/lib/inbox";
import { AFTER_WELCOME_PATH, WELCOME } from "@/lib/onboarding";
import { createClient, getUser } from "@/lib/supabase/server";
import { readActiveKey, readConfirmUrl } from "../settings/settings-reads";

export const metadata = { title: FORWARDING_TITLE };

/** One service's steps, opened from its card: the words of src/lib/forwarding-guide.ts, as 設定 › メールの転送 shows them. */
function GuideCard({ guide }: { guide: ForwardingGuide }) {
  return (
    <FoldCard title={guide.title}>
      <GuideCardBody guide={guide} />
    </FoldCard>
  );
}

/**
 * /app/welcome: the first-run guide (onboarding screen 3), reached after the sign-in that made the
 * user's first mail key (landingAfterSignIn). 1. the forwarding address to copy, 2. the steps for
 * the person's mail, then 「設定しました」 or 「あとで」, both to the parcel list. Opened again by
 * hand, it is the same page, which does no harm.
 *
 * The address, Gmail's approval and the case without a key are 設定 › メールの転送's, with its words
 * (welcome-page.test.ts compares the two). No standing note of its own: the steps carry theirs.
 */
export default async function WelcomePage() {
  const user = (await getUser())!;
  const supabase = await createClient();
  const localPart = await ensureInboxAddress(supabase, user.id);
  const address = inboxEmail(localPart);
  // The key in use. Not knowing must not look like "no key": the address stays hidden then too.
  const [{ key, failed: keyError }, confirmation] = await Promise.all([readActiveKey(supabase, "welcome"), readConfirmUrl(supabase, "welcome")]);
  const confirmUrl = confirmation.url;
  // Polling only helps a person who has an address to forward to.
  const showsAddress = Boolean(key && address && !keyError);

  return (
    <div className="flex flex-col">
      <h1 className="text-2xl font-bold">{WELCOME.title}</h1>
      <p className="mt-2 text-sm leading-6 text-neutral-600">{WELCOME.body}</p>

      {confirmation.failed ? (
        <>
          <p className="mt-6 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">Gmail の承認の案内を読み込めませんでした</p>
          {showsAddress && <RefreshUntilApproval />}
        </>
      ) : confirmUrl ? (
        <section id="gmail-approval" className="mt-6 scroll-mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-base font-bold">Gmail の転送を承認してください</h2>
          <p className="mt-1 text-sm leading-6">Gmail から転送の確認が届いています。承認済みなら、この案内は無視して大丈夫です。</p>
          <a href={confirmUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
            承認ページを開く
          </a>
          <ApprovalFilterCopy />
        </section>
      ) : (
        showsAddress && <RefreshUntilApproval />
      )}

      <section className="mt-8">
        <h2 className="text-base font-bold">{WELCOME.copyStep}</h2>
        {keyError ? (
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">メールの鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。</p>
        ) : key ? (
          address ? (
            <div className="mt-3 flex items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-3">
              <code className="min-w-0 flex-1 break-all text-sm">{address}</code>
              <CopyButton text={address} />
            </div>
          ) : (
            <p className="mt-1 text-sm leading-6 text-neutral-600">受信ドメインがまだ設定されていません。</p>
          )
        ) : (
          <p className="mt-1 text-sm leading-6 text-neutral-600">メールの鍵を作ると、ここに出ます。サンプルは鍵なしで試せます。</p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-bold">{WELCOME.setUpStep}</h2>
        <div className="mt-3 flex flex-col gap-2">
          {FORWARDING_GUIDES.map((guide) => (
            <GuideCard key={guide.id} guide={guide} />
          ))}
        </div>
        <VideoCredit />
      </section>

      <div className="mt-8 flex flex-col gap-3">
        <Link href={AFTER_WELCOME_PATH} className="flex w-full items-center justify-center rounded-xl bg-neutral-900 py-4 text-base font-medium text-white active:opacity-80">
          {WELCOME.done}
        </Link>
        <Link href={AFTER_WELCOME_PATH} className="flex w-full items-center justify-center rounded-xl border border-neutral-300 bg-white py-4 text-base font-medium text-neutral-900 active:bg-neutral-100">
          {WELCOME.later}
        </Link>
      </div>
    </div>
  );
}
