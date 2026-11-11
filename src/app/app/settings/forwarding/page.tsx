import { RefreshUntilApproval } from "@/components/refresh-until-approval";
import { ApprovalFilterCopy } from "@/components/forwarding-steps";
import { createClient, getUser } from "@/lib/supabase/server";
import { ensureInboxAddress, inboxEmail } from "@/lib/inbox";
import { CopyButton } from "@/components/copy-button";
import { ForwardingGuides } from "../forwarding-guide";
import { readActiveKey, readConfirmUrl } from "../settings-reads";
import { LoggedInAs, SubPage } from "../sub-page";
import Link from "next/link";
import { readAiReadingConsent } from "@/lib/ai-consent";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";

export const metadata = { title: "メールの転送" };

export default async function ForwardingPage() {
  const user = (await getUser())!;
  const supabase = await createClient();
  const consent = await readAiReadingConsent(supabase, user.id);
  if (consent !== "granted") {
    return (
      <SubPage title="メールの転送">
        {consent === "unknown" ? <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{AI_CONSENT_TEXT.readFailed}</p> : null}
        <Link href={consent === "unknown" ? "/app/settings/forwarding" : "/app/reading?after=welcome"} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-neutral-900 px-5 py-3 text-sm font-medium text-white">{consent === "unknown" ? AI_CONSENT_TEXT.retry : AI_CONSENT_TEXT.start}</Link>
        <Link href="/app/parcels/new" className="inline-flex min-h-11 items-center text-sm text-neutral-600 underline underline-offset-4">{AI_CONSENT_TEXT.manual}</Link>
        <Link href="/app/settings/demo" className="inline-flex min-h-11 items-center text-sm text-neutral-600 underline underline-offset-4">{AI_CONSENT_TEXT.sample}</Link>
      </SubPage>
    );
  }
  const localPart = await ensureInboxAddress(supabase, user.id);
  const address = inboxEmail(localPart);
  // The key in use. Not knowing must not look like "no key": the address stays hidden then too.
  const [{ key, failed: keyError }, confirmation] = await Promise.all([readActiveKey(supabase, "settings forwarding"), readConfirmUrl(supabase, "settings forwarding")]);
  const confirmUrl = confirmation.url;
  // Polling only helps a person who has an address to forward to.
  const showsAddress = Boolean(key && address && !keyError);

  return (
    <SubPage title="メールの転送">
      <section>
        <h2 className="text-base font-bold">転送先アドレス</h2>
        {keyError ? (
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">メールの鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。</p>
        ) : key ? (
          address ? (
            <>
              <p className="mt-1 text-sm leading-6 text-neutral-600">注文・発送のメールをこのアドレスに転送してください。自動転送を 1 回設定すれば、あとは何もしなくて大丈夫です。</p>
              <div className="mt-3 flex items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-3">
                <code className="min-w-0 flex-1 break-all text-sm">{address}</code>
                <CopyButton text={address} />
              </div>
              <p className="mt-2 text-xs text-neutral-500">あなた専用のアドレスです。知らない人に教えないでください。</p>
            </>
          ) : (
            <p className="mt-1 text-sm leading-6 text-neutral-600">受信ドメインがまだ設定されていません。</p>
          )
        ) : (
          <p className="mt-1 text-sm leading-6 text-neutral-600">メールの鍵を作ると、ここに出ます。サンプルは鍵なしで試せます。</p>
        )}
      </section>

      {/* Outside the address section, pulled up under it: whose account the address belongs to. */}
      <div className="-mt-6">
        <LoggedInAs email={user.email} />
      </div>

      {confirmation.failed ? (
        <p className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">Gmail の承認の案内を読み込めませんでした</p>
      ) : confirmUrl ? (
        <section id="gmail-approval" className="scroll-mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-base font-bold">Gmail の転送を承認してください</h2>
          <p className="mt-1 text-sm leading-6">Gmail から転送の確認が届いています。承認済みなら、この案内は無視して大丈夫です。</p>
          <a href={confirmUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
            承認ページを開く
          </a>
          <ApprovalFilterCopy />
        </section>
      ) : null}
      {/* One place for every branch, so the timer is not restarted when the branch changes. confirmUrl is null when reading failed. */}
      {showsAddress && !confirmUrl && <RefreshUntilApproval />}

      <ForwardingGuides />
    </SubPage>
  );
}
