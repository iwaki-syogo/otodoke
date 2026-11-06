import { createClient, getUser } from "@/lib/supabase/server";
import { ensureInboxAddress, inboxEmail } from "@/lib/inbox";
import { CopyButton } from "./copy-button";
import Link from "next/link";
import { forgetSender, markWronglyDropped, readWaitingMail } from "./actions";
import { isRememberableDomain } from "@/lib/screen-senders";
import { forwardingConfirmUrl } from "@/lib/forwarding";
import { UNREAD_FILTER } from "@/lib/unread";
import { formatDateTimeJa } from "@/lib/format";
import { DemoLoader } from "./demo-loader";
import { MailKeyPanel } from "./mail-key-panel";
import { MailHandling } from "./mail-handling";
import { readAll } from "@/lib/supabase/read-all";
import { countPlainRead } from "@/lib/mail-keys";
import { demoCount, settingsErrorMessage } from "@/lib/settings-errors";
import type { Tables } from "@/lib/db/database.types";

export const metadata = { title: "設定" };

/** One filter for every shop: it names what the mail is about, never who sent it. */
const GMAIL_FILTER = "{注文 発送 出荷 配達 お届け 配送 到着 荷物}";

type DroppedRow = Pick<Tables<"screen_events">, "id" | "subject" | "from_domain" | "created_at" | "flagged_at">;

type SearchParams = Promise<{ demo?: string; error?: string; cleared?: string; flagged?: string; unflagged?: string }>;

/** What 「これは荷物」 / 「外す」 answer (?flagged= / ?unflagged=): fixed words for a code, never text from the link. */
const SENDER_NOTES = {
  flagged: {
    remembered: { ok: true, register: true, text: "覚えました。この差出人のメールは、次から Claude が確認します。今回の荷物は手で登録できます。" },
    shared: { ok: true, register: true, text: "Gmail など多くの人が使うアドレスは、差出人として覚えられません。今回の荷物は手で登録できます。" },
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

// The demo loader runs several Claude calls in sequence.
export const maxDuration = 300;

export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const { demo, error, cleared, flagged, unflagged } = await searchParams;
  const note = senderNote("flagged", flagged) ?? senderNote("unflagged", unflagged);
  // Only fixed words reach the page: ?error= is a code, ?demo= a number.
  const errorMessage = settingsErrorMessage(error);
  const demoLoaded = demoCount(demo);
  const user = (await getUser())!;
  const supabase = await createClient();
  const localPart = await ensureInboxAddress(supabase, user.id);
  const address = inboxEmail(localPart);
  // The key in use. Not knowing must not look like "no key": the address stays hidden then too.
  const { data: key, error: keyError } = await supabase
    .from("user_keys")
    .select("key_id, created_at")
    .not("activated_at", "is", null)
    .is("retired_at", null)
    .maybeSingle();
  if (keyError) console.error("settings page (key):", keyError.message);
  // Read mail still in plaintext, from before encryption. The public sample mails are not counted:
  // they are anonymized fixtures from the repository, not mail of the user's the operator could read.
  let plainCount: number | null;
  try {
    plainCount = await countPlainRead(supabase, user.id);
  } catch (err) {
    plainCount = null;
    console.error("settings page (plain count):", err instanceof Error ? err.message : "unknown error");
  }
  const { count: oldKeyCount } = key
    ? await supabase.from("emails").select("id", { count: "exact", head: true }).eq("body_state", "sealed").neq("body_envelope->>kid", key.key_id)
    : { count: 0 };
  const { data: confirmation } = await supabase
    .from("emails")
    .select("forwarding_confirm_url, text_body, html_body, sent_at")
    .eq("classification", "forwarding_confirmation")
    .order("sent_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { count: waiting } = await supabase
    .from("emails")
    .select("id", { count: "exact", head: true })
    .or(UNREAD_FILTER());
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
    console.error("settings page (dropped):", err instanceof Error ? err.message : err);
  }
  // A failed read is told apart from no dropped mail: by the failure, never by the empty list.
  const droppedError = dropped === null;
  // The senders 「これは荷物」 remembered, from the marked rows (kept past 14 days). A mark made on
  // a shared domain before that was refused is not honoured by the pipeline, so it is not listed.
  const remembered = [...new Set((dropped ?? []).filter((d) => d.flagged_at && isRememberableDomain(d.from_domain)).map((d) => d.from_domain!))].sort();
  // Checked again when shown: only Google's own page is ever linked.
  const confirmUrl = confirmation
    ? forwardingConfirmUrl(confirmation.forwarding_confirm_url ?? "") ?? forwardingConfirmUrl(confirmation.text_body ?? confirmation.html_body ?? "")
    : null;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-bold">設定</h1>

      {keyError ? (
        <section>
          <h2 className="text-base font-bold">合言葉</h2>
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
        </section>
      ) : (
        <MailKeyPanel state={{ userId: user.id, keyCreatedAt: key?.created_at ?? null, currentKeyId: key?.key_id ?? null, plainCount, oldKeyCount: oldKeyCount ?? 0 }} />
      )}
      {/* Which account this is, next to the passphrase and the address: a page signed in to someone
          else's account (a crafted login link) shows it here before anything is set up. */}
      <p className="-mt-6 text-xs text-neutral-500">
        ログイン中: <span className="break-all font-medium text-neutral-700">{user.email}</span>（自分のアドレスでなければ、何も設定せずにログアウトしてください）
      </p>

      <section>
        <h2 className="text-base font-bold">転送先アドレス</h2>
        {keyError ? (
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">合言葉を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。</p>
        ) : key ? (
          <>
            <p className="mt-1 text-sm leading-6 text-neutral-600">注文・発送のメールをこのアドレスに転送してください。自動転送を 1 回設定すれば、あとは何もしなくて大丈夫です。</p>
            <div className="mt-3 flex items-center gap-2 rounded-2xl border border-neutral-200 bg-white p-3">
              <code className="min-w-0 flex-1 break-all text-sm">{address ?? `${localPart}@（受信ドメイン設定前）`}</code>
              {address ? <CopyButton text={address} /> : null}
            </div>
            <p className="mt-2 text-xs text-neutral-500">あなた専用のアドレスです。知らない人に教えないでください。</p>
          </>
        ) : (
          <p className="mt-1 text-sm leading-6 text-neutral-600">合言葉を決めると、ここに出ます。サンプルは合言葉なしで試せます。</p>
        )}
      </section>

      {waiting ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4">
          <h2 className="text-base font-bold">未読のメールが {waiting} 通あります</h2>
          <p className="mt-1 text-sm leading-6">1 日の上限を超えたか、読み取りに失敗したメールです。保存してあるので、もう一度読み取れます。</p>
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
            <p className="mt-2 text-xs text-neutral-500">転送するのは上の言葉を含むメールだけです。ただし、これらの言葉を含む私信（「到着したよ」など）も転送されます。届いたメールのうち、買い物に関係しないものは本文を保存せずに捨てます。</p>
          </Guide>
          <Guide title="iCloud / Outlook / その他">
            <p>メールの設定にある自動転送で、すべてのメールを上のアドレスへ転送してください。</p>
            <p className="mt-2">Outlook は 設定 › メール › 転送 にあります。広告など買い物に関係しないメールは、本文を保存せずに捨てます。判断に迷うメールだけ Claude が確認します。</p>
          </Guide>
        </div>
      </section>

      <section>
        <h2 className="text-base font-bold">読まなかったメール</h2>
        <p className="mt-1 text-sm leading-6 text-neutral-600">広告など、買い物に関係なさそうなメールです。本文は保存せず、件名だけ 14 日間残します。</p>
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
        {droppedError ? (
          <p className="mt-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">読み込めませんでした</p>
        ) : dropped && dropped.length > 0 ? (
          <details className="mt-2 rounded-2xl border border-neutral-200 bg-white">
            <summary className="cursor-pointer px-4 py-3 text-sm font-medium">荷物のメールが混ざっていないか見る（{dropped.length} 通）</summary>
            <ul className="divide-y divide-neutral-100 border-t border-neutral-100">
              {dropped.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{d.subject || "（件名なし）"}</p>
                    <p className="truncate text-xs text-neutral-500">
                      {d.from_domain} ・ {formatDateTimeJa(d.created_at)}
                    </p>
                  </div>
                  {d.flagged_at ? (
                    <span className="shrink-0 text-xs text-emerald-800">荷物として記録済み</span>
                  ) : (
                    <form action={markWronglyDropped}>
                      <input type="hidden" name="id" value={d.id} />
                      <button type="submit" className="shrink-0 rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium">
                        これは荷物
                      </button>
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
                  <form action={forgetSender}>
                    <input type="hidden" name="domain" value={domain} />
                    <button type="submit" className="shrink-0 rounded-lg border border-neutral-300 px-3 py-2 text-xs font-medium">
                      外す
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <MailHandling />

      <section id="demo" className="scroll-mt-4 rounded-2xl border border-dashed border-neutral-300 p-4">
        <h2 className="text-base font-bold">サンプルで試す</h2>
        <p className="mt-1 text-sm leading-6 text-neutral-600">匿名化した実際の注文・発送メールを読み込みます。日付は今日に合わせてずらしてあります。</p>
        <DemoLoader loaded={demoLoaded} error={errorMessage} cleared={Boolean(cleared)} />
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

function Guide({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="rounded-2xl border border-neutral-200 bg-white">
      <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{title}</summary>
      <div className="border-t border-neutral-100 px-4 py-3 text-sm leading-6 text-neutral-700">{children}</div>
    </details>
  );
}
