import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL } from "@/lib/mail-notices";
import { CONTACT_EMAIL } from "./contact";

// Prerendered (○ in `next build`). Next renders the root not-found with every page as its
// fallback, so a root 404 that reads the request makes this page per request too: it did while
// src/app/not-found.tsx read the session. That 404 reads nothing now (review R3-6); the line stays
// so this page stays static if it ever does again. This page reads nothing from the request, and
// that fallback is never shown here.
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
 * The wording rules: short and polite, no brackets, 「データベースからは読めません」 only
 * of sealed mail, never 「絶対」 or 「知り得ない」 (src/lib/__tests__/privacy-page.test.ts).
 *
 * Statements tied to code elsewhere:
 * - 「これは荷物」: src/lib/screen-senders.ts (domains never remembered), src/lib/pipeline.ts
 *   secondLook (a remembered sender still gets the Haiku check), 設定「外す」 (forgetSender).
 * - パスワード: password-v1 (docs/crypto/password-v1.md). The browser makes the login value and the
 *   key that wraps the mail key from the password; Supabase Auth gets the login value as the
 *   account's password and keeps only its bcrypt hash (supabase.com/docs/guides/auth/password-security,
 *   checked 2026-11-06).
 * - The one cookie: Supabase's session. Only the two Supabase clients set cookies, and only the ones
 *   Supabase asks for (setAll in src/lib/supabase/server.ts and src/proxy.ts); signOut removes them
 *   on logout and on account deletion. A cookie of the app's own needs a line here
 *   (privacy-page.test.ts finds every place that sets one).
 * - メールの送信とログインを試した記録: login_mail_sends (supabase/migrations/20261106100000), claimed
 *   by src/lib/login-mail-limit.ts before a form of this site asks Supabase for a mail
 *   (claimLoginMail), before every sign-in with the login secret, the change's check of the
 *   current one included (claimLoginTry by IP, claimLoginAttempt by address and IP; login-auth.ts
 *   claimSignIn), and before /auth/confirm asks Supabase to check a mail's link (claimLoginLink by
 *   IP, the press of 「確認する」 or 「再設定する」). Each claim first removes the rows older than an hour.
 * - 11 月 14 日 and what a reset costs: src/lib/mail-notices.ts, the same words in
 *   mail-handling.tsx, the password panel of 設定 and README. Reword them all once
 *   supabase/pending/20261114090000 has run.
 * - What account deletion leaves: the receiving address's local part and when it was given out
 *   (supabase/migrations/20261106170000_issued_inbox_local_parts.sql), and the day's count of
 *   Claude calls with no user on it (20261106190000_claude_usage_keeps_deleted_calls.sql).
 */
export default function PrivacyPage() {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-10">
      <Link href="/" className="-my-2 inline-block py-2 text-sm text-neutral-500">
        <span aria-hidden="true">←</span> <Wordmark className="text-lg" />
      </Link>
      <h1 className="mt-8 text-2xl font-bold">プライバシーポリシー</h1>
      <p className="mt-3 text-sm leading-6 text-neutral-700">Otodoke 運営は、Otodoke で預かる情報を次のとおり扱います。</p>

      <Section title="運営者">
        <p>Otodoke 運営</p>
      </Section>

      <Section title="集める情報と使い道">
        <Terms>
          <Term name="ログインのメールアドレス">確認や再設定のメールを送り、あなたのアカウントを見分けるために使います。</Term>
          <Term name="パスワード">
            ブラウザで、ログイン用の値とメールの鍵を開く値の 2 つに分け、ログイン用の値だけをサーバーに送ります。ログイン用の値は、Supabase がハッシュ値に変えて保存します。
          </Term>
          <Term name="転送されたメール">荷物の情報を読み取るために使います。読み取った後は、元のメールを見られるように暗号化して保存します。</Term>
          <Term name="荷物の情報と根拠の行">
            店・品名・金額・日付・注文番号・伝票番号などと、読み取った値の根拠になった元メールの行です。一覧・カレンダー・支出を出すのと、読み取った値を確かめるのに使います。
          </Term>
          <Term name="読まなかったメールの件名と差出人のドメイン">
            広告など読まなかったメールに荷物のメールが混ざっていないか、設定で確かめられるようにします。14 日で Otodoke から消えます。ふるいを直すために、運営者が件数と差出人のドメインを見ることがあります。
          </Term>
          <Term name="「これは荷物」で覚えた差出人">
            押したメールの差出人のドメインを覚えます。次からその差出人のメールは、ふるいで落ちても Claude Haiku で確かめます。覚えている間は、押したメールの件名と差出人のドメインを残します。設定の「外す」で外すと、ほかと同じく 14 日で Otodoke から消えます。Gmail など多くの人が使うドメインは覚えません。
          </Term>
          <Term name="メールの送信とログインを試した記録">
            送りすぎを防ぐために使います。メールアドレスと接続元の IP アドレスをハッシュ値に変えて、送った時刻と一緒に記録します。ログインを試したときも、続けて試されるのを防ぐため、メールアドレスと接続元の IP アドレスのハッシュ値と日時を記録します。確認や再設定のリンクを使ったときも、混み合うのを防ぐため、接続元の IP アドレスのハッシュ値と日時を記録します。どちらのアドレスも、そのままでは記録しません。1 時間を過ぎた記録は、次に記録するときに消します。
          </Term>
          <Term name="Claude を使った回数">1 日の上限を守るために、あなたのメールに Claude を使った回数を日ごとに記録します。</Term>
          {/* The plans set these periods: Supabase Pro log retention (API & Database) 7 days, Vercel Pro
              runtime logs 1 day (supabase.com/pricing, vercel.com/docs/logs/runtime, checked 2026-11-06).
              Change this and 「最大 7 日間」 under 保存の期間と消し方 when either plan changes. */}
          <Term name="接続の記録">
            Supabase と Vercel に、IP アドレスやブラウザの種類などの記録が残ります。Supabase の記録には、ログインに使ったメールアドレスも入ります。Supabase は 7 日、Vercel は 1 日で消えます。障害や不正を調べるときに使うことがあります。
          </Term>
          <Term name="cookie">
            ログインのためだけに使います。広告やアクセス解析のための cookie は使いません。ログインの状態を保つ cookie は、Supabase のログインの仕組みが使います。ログアウトしたときと、アカウントを削除したときに消えます。
          </Term>
        </Terms>
      </Section>

      <Section title="メールの扱い">
        <Terms>
          <Term name="ふるい">
            届いたメールは、まずサーバーの中の決まりで、広告などを分けます。迷うメールと、「これは荷物」で覚えた差出人のメールだけ、件名と本文の初めの部分を Claude Haiku に送って確かめます。読まないと決めたメールの本文は保存しません。
          </Term>
          <Term name="Claude での読み取り">
            残ったメールは Claude が読み取ります。読み取る数秒のあいだ、サーバーと Claude API がメールの中身を扱います。買い物に関係ないと分かったメールは、Otodoke に残しません。
          </Term>
          <Term name="保存と暗号化">
            読み取った後のメールの件名・差出人・本文は、あなたのパスワードでしか開けない形に暗号化して保存します。暗号化したメールは、運営者もデータベースからは読めません。パスワードそのものは、サーバーに送りません。メールの鍵は、パスワードでログインしたときにブラウザで作ります。開いた鍵は、そのタブの中にだけ置きます。iOS アプリでは、パスワードで開いた鍵を、その端末のキーチェーンに Face ID 付きで保存できます。Touch ID の端末では Touch ID を使います。鍵は端末の外に出ず、iCloud などで同期もせず、運営者にも送りません。ログアウトしたときと、アプリの設定で切ったときに消えます。
          </Term>
          <Term name="パスワードでログインする前と、忘れたとき">
            Otodoke が暗号化を始めた後、パスワードでログインする前に読み取ったメールは、件名・差出人・本文を残しません。荷物の情報は残ります。パスワードを忘れたときは、メールで再設定できます。{RESET_LOSES_MAIL}
            パスワードを変えるだけなら、前のメールもそのまま開けます。
          </Term>
          <Term name="暗号化しないもの">
            <Bullets>
              <li>荷物の情報と、根拠の行・読み取りメモ。一覧・カレンダー・支出を出すのと、読み取った値を確かめるのに使います。根拠の行は本文の抜粋です。</li>
              <li>差出人のドメイン、メールごとの識別子、Gmail の転送の確認メールにある承認リンク。ふるいと、同じメールを二度読まないためと、承認ページを出すために使います。</li>
              <li>読み取る前のメール。1 日の上限を超えた分などは、読み取るまで暗号化せずに置きます。</li>
              <li>
                Otodoke が暗号化を始める前に読み取ったメール。設定で「暗号化する」を押すまで、運営者が読める形で残ります。{PLAINTEXT_DROP_NOTICE}
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
          <Term name="Resend">メールの受信と、確認・再設定などのメールの送信です。データは米国に保存されます。届いたメールの写しは、Resend にも一定期間残ります。</Term>
          <Term name="Anthropic">
            Claude API で、メールの判定と読み取りをします。データは米国に保存され、読み取りの処理は米国以外で行われることもあります。Anthropic は、API のデータを既定では学習に使わず、30 日以内に消すと定めています。利用ポリシーに反する疑いがあると判定されたものは、最長 2 年残ることがあります。
          </Term>
          <Term name="Cloudflare">
            Turnstile で、ログイン・アカウント作成・再設定の画面と、設定で鍵を作る操作とパスワードを変える操作が、ロボットでないかを確かめます。IP アドレスやブラウザの種類などを Cloudflare が受け取ります。Cloudflare は、これをロボットの判定と、その仕組みの改善にだけ使うと定めています。
          </Term>
        </Terms>
      </Section>

      <Section title="保存の期間と消し方">
        <Bullets>
          <li>荷物と、Otodoke に保存したメールは、あなたが消すまで保存します。</li>
          <li>
            設定の「サンプルで試す」にある「すべての荷物を消す」で、荷物と、Otodoke に保存したメール・読み取り結果を消せます。アカウント、転送先アドレス、メールの鍵と、読まなかったメール・Claude を使った回数の記録は残ります。
          </li>
          <li>
            設定の「アカウントを削除」で、アカウントと、Otodoke に保存したあなたのデータをすべて消せます。転送先アドレスも使えなくなります。同じアドレスがほかの人に渡らないように、アドレスの文字と作った日時だけは残します。1 日の上限を守るために、Claude を使った回数も、誰のものか分からない形で日ごとに残します。
          </li>
          <li>アカウントを削除したら、メールの自動転送の設定も外してください。外さないと、転送されたメールは Otodoke では読みませんが、Resend には届き続けます。</li>
          {/* 最大 7 日間: the longest of the database backups and the logs of 接続の記録 (see the note there). */}
          <li>消したデータも、データベースのバックアップと接続の記録に、最大 7 日間残ります。Resend や Anthropic など各社に渡ったデータは、各社の期間が過ぎるまで残ります。</li>
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
      {/* The day the password sign-in reaches production (「変えた日を書きます」 above). Change it if that day moves. */}
      <p className="mt-1 text-xs text-neutral-500">改定日: 2026 年 11 月 7 日</p>
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
