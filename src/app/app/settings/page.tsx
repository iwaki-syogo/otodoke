import { createClient, getUser } from "@/lib/supabase/server";
import { ensureInboxAddress, inboxEmail } from "@/lib/inbox";
import { CopyButton } from "./copy-button";
import { readWaitingMail } from "./actions";
import { DemoLoader } from "./demo-loader";

export const metadata = { title: "設定" };

/** One filter for every shop: it names what the mail is about, never who sent it. */
const GMAIL_FILTER = "{注文 発送 出荷 配達 お届け 配送 到着 荷物}";

type SearchParams = Promise<{ demo?: string; error?: string; cleared?: string }>;

// The demo loader runs several Claude calls in sequence.
export const maxDuration = 300;

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { demo, error, cleared } = await searchParams;
  const user = (await getUser())!;
  const supabase = await createClient();
  const localPart = await ensureInboxAddress(supabase, user.id);
  const address = inboxEmail(localPart);
  const { data: confirmation } = await supabase
    .from("emails")
    .select("text_body, html_body, sent_at")
    .eq("classification", "forwarding_confirmation")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { count: waiting } = await supabase
    .from("emails")
    .select("id", { count: "exact", head: true })
    .eq("processing_status", "over_limit");
  const confirmUrl = confirmation ? forwardingConfirmUrl(confirmation.text_body ?? confirmation.html_body ?? "") : null;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-bold">設定</h1>

      <section>
        <h2 className="text-base font-bold">転送先アドレス</h2>
        <p className="mt-1 text-sm leading-6 text-neutral-600">注文・発送のメールをこのアドレスに転送してください。自動転送を 1 回設定すれば、あとは何もしなくて大丈夫です。</p>
        <div className="mt-3 flex items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-3">
          <code className="min-w-0 flex-1 break-all text-sm">{address ?? `${localPart}@（受信ドメイン設定前）`}</code>
          {address ? <CopyButton text={address} /> : null}
        </div>
        <p className="mt-2 text-xs text-neutral-500">あなた専用のアドレスです。知らない人に教えないでください。</p>
      </section>

      {waiting ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-base font-bold">未読のメールが {waiting} 通あります</h2>
          <p className="mt-1 text-sm leading-6">1 日に読める上限を超えたメールです。保存してあるので、翌日以降に読み取れます。</p>
          <form action={readWaitingMail} className="mt-3">
            <button type="submit" className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
              読み取る
            </button>
          </form>
        </section>
      ) : null}

      {confirmUrl ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-base font-bold">Gmail の転送を承認してください</h2>
          <p className="mt-1 text-sm leading-6">Gmail から転送の確認が届いています。承認済みなら、この案内は無視して大丈夫です。</p>
          <a href={confirmUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white">
            承認ページを開く
          </a>
        </section>
      ) : null}

      <section>
        <h2 className="text-base font-bold">自動転送の設定（最初の 1 回だけ）</h2>
        <p className="mt-1 text-sm leading-6 text-neutral-600">店ごとの設定はいりません。新しい店で買っても、そのまま読み取ります。</p>
        <div className="mt-2 flex flex-col gap-2">
          <Guide title="Gmail">
            <ol className="list-decimal space-y-1 pl-5">
              <li>パソコンのブラウザで Gmail を開き、設定 › すべての設定を表示 › 「メール転送と POP/IMAP」を開く</li>
              <li>「転送先アドレスを追加」で上のアドレスを入れる</li>
              <li>少し待つと、このページの上に承認ページへのボタンが出るので開いて承認する</li>
              <li>
                検索ボックスの検索オプションを開き、「含む」に次の文字列を貼って「フィルタを作成」を押す
                <div className="my-2 flex items-center gap-2 rounded-xl bg-neutral-50 p-2">
                  <code className="min-w-0 flex-1 break-all text-xs">{GMAIL_FILTER}</code>
                  <CopyButton text={GMAIL_FILTER} />
                </div>
              </li>
              <li>「転送する」に上のアドレスを選んで作成する</li>
            </ol>
            <p className="mt-2 text-xs text-neutral-500">買い物に関係しそうなメールだけが届くので、私信は Otodoke に送られません。</p>
          </Guide>
          <Guide title="iCloud / Outlook / その他">
            <p>メールの設定にある自動転送で、すべてのメールを上のアドレスへ転送してください。</p>
            <p className="mt-2">Outlook は 設定 › メール › 転送 にあります。買い物に関係しないメールは Otodoke が読まずに捨て、保存もしません。</p>
          </Guide>
        </div>
      </section>

      <section className="rounded-2xl border border-dashed border-neutral-300 p-4">
        <h2 className="text-base font-bold">サンプルで試す</h2>
        <p className="mt-1 text-sm leading-6 text-neutral-600">匿名化した実際の注文・発送メールを読み込みます。日付は今日に合わせてずらしてあります。</p>
        <DemoLoader result={demo} error={error} cleared={cleared} />
      </section>

      <section className="flex flex-col gap-3">
        <p className="text-xs text-neutral-500">ログイン中: {user.email}</p>
        <form action="/auth/signout" method="post">
          <button type="submit" className="rounded-lg border border-neutral-300 px-4 py-2 text-sm">
            ログアウト
          </button>
        </form>
      </section>
    </div>
  );
}

function forwardingConfirmUrl(body: string): string | null {
  return body.match(/https:\/\/[\w.-]*google\.com\/[^\s<>"')]+/)?.[0] ?? null;
}

function Guide({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-2xl border border-neutral-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{title}</summary>
      <div className="border-t border-neutral-100 px-4 py-3 text-sm leading-6 text-neutral-700">{children}</div>
    </details>
  );
}
