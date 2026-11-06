import { CopyButton } from "./copy-button";

/** One filter for every shop: it names what the mail is about, never who sent it. */
const GMAIL_FILTER = "{注文 発送 出荷 配達 お届け 配送 到着 荷物}";

/**
 * 「自動転送の設定は最初の 1 回だけ」: the per-service guides. Kept apart from the page so a
 * fuller guide (steps, the link to each service's own settings page, pitfalls) can replace the
 * `Guide` entries below from a data module without touching the page.
 */
export function ForwardingGuide() {
  return (
    <section>
      <h2 className="text-base font-bold">自動転送の設定は最初の 1 回だけ</h2>
      <p className="mt-1 text-sm leading-6 text-neutral-600">店ごとの設定はいりません。新しい店で買っても、そのまま読み取ります。</p>
      <div className="mt-2 flex flex-col gap-2">
        <Guide title="Gmail">
          <ol className="list-decimal space-y-1 pl-5">
            <li>パソコンのブラウザで Gmail を開き、設定 › すべての設定を表示 › 「メール転送と POP/IMAP」を開く</li>
            <li>「転送先アドレスを追加」で上のアドレスを入れる。本人確認を求められたら済ませて、もう一度入れる。「次へ」の後に開く小窓で「続行」を押す</li>
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
          <p className="mt-2 text-xs text-neutral-500">転送するのは上の言葉を含むメールだけです。ただし、これらの言葉を含む私信も転送されます。たとえば「到着したよ」という連絡です。届いたメールのうち、買い物に関係しないものは本文を保存せずに捨てます。</p>
        </Guide>
        <Guide title="iCloud / Outlook / その他">
          <p>メールの設定にある自動転送で、すべてのメールを上のアドレスへ転送してください。</p>
          <p className="mt-2">Outlook は 設定 › メール › 転送 にあります。広告など買い物に関係しないメールは、本文を保存せずに捨てます。判断に迷うメールだけ Claude が確認します。</p>
        </Guide>
      </div>
    </section>
  );
}

function Guide({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-2xl border border-neutral-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{title}</summary>
      <div className="border-t border-neutral-100 px-4 py-3 text-sm leading-6 text-neutral-700">{children}</div>
    </details>
  );
}
