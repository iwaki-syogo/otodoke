import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { CONTACT_EMAIL } from "./contact";

// Prerendered (○ in `next build`). src/app/not-found.tsx reads the session, and Next renders the
// root not-found with every page as its fallback, so without this line this page would be rendered
// per request too. It reads nothing from the request, and that fallback is never shown here.
export const dynamic = "force-static";

export const metadata: Metadata = { title: "プライバシーポリシー" };

/**
 * The privacy policy. A static page: readable before signing in, and it reads nothing from the
 * database or the request.
 *
 * Every statement is what the code, the migrations and the providers' own documents say (checked
 * 2026-11-06). Keep it in step with the settings' 「あなたのメールの扱い」
 * (src/app/app/settings/mail-handling.tsx) and the README section of the same name.
 *
 * The owner's wording rules: short and polite, no brackets, 「データベースからは読めません」 only
 * of sealed mail, never 「絶対」 or 「知り得ない」 (src/lib/__tests__/privacy-page.test.ts).
 *
 * Statements tied to code elsewhere:
 * - 「これは荷物」: src/lib/screen-senders.ts (domains never remembered), src/lib/pipeline.ts
 *   secondLook (a remembered sender still gets the Haiku check), 設定「外す」 (forgetSender).
 * - The two cookies: Supabase's session (removed by signOut on logout and on account deletion) and
 *   the login screen's address cookie (src/lib/login-email-cookie.ts, one hour, Path=/login),
 *   removed when that browser signs in, signs out or deletes its account: a link opened on
 *   another device leaves it its hour, so the hour is told first (review R3-22).
 * - 11 月 14 日: decision 7 (supabase/pending/20261114090000), told the same way in
 *   mail-handling.tsx and mail-key-panel.tsx. Reword all three once it has run.
 * - What account deletion leaves: the receiving address's local part and when it was given out
 *   (supabase/migrations/20261106170000_issued_inbox_local_parts.sql), and the day's count of
 *   Claude calls with no user on it (20261106190000_claude_usage_keeps_deleted_calls.sql).
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-10">
      <Link href="/" className="text-sm text-neutral-500">
        ← <Wordmark className="text-lg" />
      </Link>
      <h1 className="mt-8 text-2xl font-bold">プライバシーポリシー</h1>
      <p className="mt-3 text-sm leading-6 text-neutral-700">Otodoke 運営は、Otodoke で預かる情報を次のとおり扱います。</p>

      <Section title="運営者">
        <p>Otodoke 運営</p>
      </Section>

      <Section title="集める情報と使い道">
        <Terms>
          <Term name="ログインのメールアドレス">ログインのリンクを送り、あなたのアカウントを見分けるために使います。</Term>
          <Term name="転送されたメール">荷物の情報を読み取るために使います。読み取った後は、元のメールを見られるように暗号化して保存します。</Term>
          <Term name="荷物の情報と根拠の行">
            店・品名・金額・日付・注文番号・伝票番号などと、読み取った値の根拠になった元メールの行です。一覧・カレンダー・支出を出すのと、読み取った値を確かめるのに使います。
          </Term>
          <Term name="読まなかったメールの件名と差出人のドメイン">
            広告など読まなかったメールに荷物のメールが混ざっていないか、設定で確かめられるようにします。14 日で消します。ふるいを直すために、運営者が件数と差出人のドメインを見ることがあります。
          </Term>
          <Term name="「これは荷物」で覚えた差出人">
            押したメールの差出人のドメインを覚えます。次からその差出人のメールは、ふるいで落ちても Claude Haiku で確かめます。覚えている間は、押したメールの件名と差出人のドメインを残します。設定の「外す」で外すと、ほかと同じく 14 日で消します。Gmail など多くの人が使うドメインは覚えません。
          </Term>
          <Term name="ログインのリンクを送った記録">
            送りすぎを防ぐために使います。メールアドレスと接続元の IP アドレスをハッシュ値に変えて、送った時刻と一緒に記録します。どちらのアドレスも、そのままでは記録しません。1 時間を過ぎた記録は、次に送るときに消します。
          </Term>
          <Term name="Claude を使った回数">1 日の上限を守るために、あなたのメールに Claude を使った回数を日ごとに記録します。</Term>
          <Term name="接続の記録">Supabase と Vercel に、IP アドレスやブラウザの種類などの記録が残ります。障害や不正を調べるときに使うことがあります。</Term>
          <Term name="cookie">
            ログインのためだけに使います。広告やアクセス解析のための cookie は使いません。
            <Bullets className="mt-1">
              <li>ログインの状態を保つ cookie は、Supabase のログインの仕組みが使います。ログアウトしたときと、アカウントを削除したときに消えます。</li>
              <li>ログインのメールを送るとき、入れたアドレスと送った時刻を、ログインの画面でだけ使う cookie に入れます。1 時間で消えます。この端末でログインしたとき・ログアウトしたとき・アカウントを削除したときにも消します。</li>
            </Bullets>
          </Term>
        </Terms>
      </Section>

      <Section title="メールの扱い">
        <Terms>
          <Term name="ふるい">
            届いたメールは、まずサーバーの中の決まりで、広告などを分けます。迷うメールと、「これは荷物」で覚えた差出人のメールだけ、件名と本文の初めの部分を Claude Haiku に送って確かめます。読まないと決めたメールの本文は保存しません。
          </Term>
          <Term name="Claude での読み取り">
            残ったメールは Claude が読み取ります。読み取る数秒のあいだ、サーバーと Claude API がメールの中身を扱います。買い物に関係ないと分かったメールは消します。
          </Term>
          <Term name="保存と暗号化">
            読み取った後のメールの件名・差出人・本文は、あなたの合言葉でしか開けない形に暗号化して保存します。暗号化したメールは、運営者もデータベースからは読めません。合言葉そのものは、サーバーに送りません。
          </Term>
          <Term name="合言葉を決める前と、忘れたとき">
            Otodoke が暗号化を始めた後、合言葉を決める前に読み取ったメールは、件名・差出人・本文を残しません。荷物の情報は残ります。合言葉を忘れると、暗号化したメールは誰にも戻せません。荷物は残ります。
          </Term>
          <Term name="暗号化しないもの">
            <Bullets>
              <li>荷物の情報と、根拠の行・読み取りメモ。一覧・カレンダー・支出を出すのと、読み取った値を確かめるのに使います。根拠の行は本文の抜粋です。</li>
              <li>差出人のドメイン、メールごとの識別子、Gmail の転送の確認メールにある承認リンク。ふるいと、同じメールを二度読まないためと、承認ページを出すために使います。</li>
              <li>読み取る前のメール。1 日の上限を超えた分などは、読み取るまで暗号化せずに置きます。</li>
              <li>
                Otodoke が暗号化を始める前に読み取ったメール。設定で「暗号化する」を押すまで、運営者が読める形で残ります。合言葉を決めていない場合は、11 月 14 日に件名・差出人・本文を消します。荷物は残ります。
              </li>
            </Bullets>
          </Term>
          <Term name="バックアップ">データベースのバックアップは、最大 7 日間残ります。暗号化していないメールも、その間はバックアップに残ります。</Term>
        </Terms>
      </Section>

      <Section title="外部のサービスと置き場所">
        <Terms>
          <Term name="Supabase">データベースとログインの仕組みです。データは東京に保存されます。</Term>
          <Term name="Vercel">アプリの配信とサーバーの処理です。メールと荷物を扱う処理は東京で行います。</Term>
          <Term name="Resend">メールの受信と、ログインのメールの送信です。データは米国に保存されます。届いたメールの写しは、Resend にも一定期間残ります。</Term>
          <Term name="Anthropic">
            Claude API で、メールの判定と読み取りをします。データは米国に保存され、読み取りの処理は米国以外で行われることもあります。Anthropic は、API のデータを既定では学習に使わず、30 日以内に消すと定めています。利用ポリシーに反する疑いがあると判定されたものは、最長 2 年残ることがあります。
          </Term>
          <Term name="Cloudflare">
            Turnstile で、ログイン画面の操作がロボットでないかを確かめます。IP アドレスやブラウザの種類などを Cloudflare が受け取ります。Cloudflare は、これをロボットの判定と、その仕組みの改善にだけ使うと定めています。
          </Term>
        </Terms>
      </Section>

      <Section title="保存の期間と消し方">
        <Bullets>
          <li>荷物と保存したメールは、あなたが消すまで保存します。</li>
          <li>
            設定の「すべての荷物を消す」で、荷物と、保存したメール・読み取り結果を消せます。アカウント、転送先アドレス、合言葉の設定と、読まなかったメール・Claude を使った回数の記録は残ります。
          </li>
          <li>
            設定の「アカウントを削除」で、アカウントと、Otodoke に保存したあなたのデータをすべて消せます。転送先アドレスも使えなくなります。同じアドレスがほかの人に渡らないように、アドレスの文字と作った日時だけは残します。1 日の上限を守るために、Claude を使った回数も、誰のものか分からない形で日ごとに残します。
          </li>
          <li>アカウントを削除したら、メールの自動転送の設定も外してください。外さないと、転送されたメールは Otodoke では読みませんが、Resend には届き続けます。</li>
          <li>消したデータも、データベースのバックアップに最大 7 日間残ります。Resend や Anthropic など各社に渡ったデータは、各社の期間が過ぎるまで残ります。</li>
        </Bullets>
      </Section>

      <Section title="安全の対策">
        <Bullets>
          <li>アプリとの通信は暗号化しています。</li>
          <li>データベースは、利用者が自分のデータだけを読める設定にしています。メールと読み取り結果を書き込めるのは、サーバーだけです。</li>
          <li>届いたメールは、Resend の署名を確かめてから受け取ります。</li>
          <li>サーバーの記録に、メールの中身を書き出さないようにしています。</li>
          <li>
            暗号化は、運営者が公開しているとおりのプログラムを動かしていることが前提です。コードはすべて{" "}
            <a href="https://github.com/iwaki-syogo/otodoke" target="_blank" rel="noopener noreferrer" className="text-sky-700 underline underline-offset-4">
              GitHub
            </a>{" "}
            で公開しています。
          </li>
        </Bullets>
      </Section>

      <Section title="ポリシーを変えるとき">
        <p>内容を変えるときは、このページを更新し、変えた日を書きます。</p>
      </Section>

      <Section title="問い合わせ先">
        <p>このポリシーについてのお問い合わせと、あなたのデータの開示・訂正・削除などのお求めは、次のアドレスで受け付けます。</p>
        <p>
          <a href={`mailto:${CONTACT_EMAIL}`} className="break-all font-medium text-sky-700 underline underline-offset-4">
            {CONTACT_EMAIL}
          </a>
        </p>
      </Section>

      <p className="mt-10 text-xs text-neutral-500">制定日: 2026 年 11 月</p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="text-base font-bold">{title}</h2>
      <div className="mt-2 flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4 text-sm leading-6 text-neutral-700">{children}</div>
    </section>
  );
}

function Terms({ children }: { children: React.ReactNode }) {
  return <dl className="flex flex-col gap-3">{children}</dl>;
}

function Term({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-medium text-neutral-900">{name}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Bullets({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <ul className={`flex list-disc flex-col gap-2 pl-5 ${className}`.trim()}>{children}</ul>;
}
