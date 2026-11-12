import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/wordmark";
import { PublicPageLinks } from "@/components/public-page-links";
import { CLEAR_ALL_RETAINED_NOTICE, CLEARED_MAIL_MARKS_IDENTIFIERS_NOTICE, CLEARED_MAIL_MARKS_NOTICE, PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL, UNREAD_MAIL_STORAGE_NOTICE } from "@/lib/mail-notices";
import { CONTACT_EMAIL } from "./contact";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";

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
          <Term name="転送されたメール">荷物の情報を読み取るために使います。読み取り後の保存は、<a href="#mail-storage" className="text-sky-700 underline underline-offset-4">「保存と暗号化」</a>をご確認ください。</Term>
          <Term name="読み取りの許可">
            <p>許可するかどうかの選択と、選んだ日時、画面の文の版を、あなたのアカウントと結び付けて記録します。メールを読み取る前に、あなたが許可したかを確かめるためです。</p>
            <p className="mt-2">許可した直後の読み取りが重ならないよう、その許可の日時も、あなたのアカウントと結び付けて記録します。この記録は、最後の分だけを残します。</p>
          </Term>
          <Term name="荷物の情報と根拠の行">
            店・品名・金額・日付・注文番号・伝票番号などと、読み取った値の根拠になった元メールの行です。一覧・カレンダー・支出を出すのと、読み取った値を確かめるのに使います。
          </Term>
          <Term name="受け取りを元に戻す記録" id="receipt-records">
            受け取りを元に戻すため、変更前後の状態と操作の記録を残します。この記録は 24 時間で使えなくなります。期限を過ぎた記録は、毎日の掃除で消します。荷物やアカウントを削除すると、この記録も消えます。
          </Term>
          <Term name="読まなかったメールの件名と差出人のドメイン">
            広告など読まなかったメールに荷物のメールが混ざっていないか、設定で確かめられるようにします。記録してから 14 日を過ぎた分は、毎日の掃除で消します。ふるいを直すために、運営者が件数と差出人のドメインを見ることがあります。
          </Term>
          <Term name="「これは荷物」で覚えた差出人">
            押したメールの差出人のドメインを覚えます。次からその差出人のメールは、ふるいで落ちても Claude Haiku で確かめます。覚えている間は、押したメールの件名と差出人のドメインを残します。設定の「外す」で外すと、記録してから 14 日を過ぎた分を、毎日の掃除で消します。Gmail など多くの人が使うドメインは覚えません。
          </Term>
          <Term name="メールの送信とログインを試した記録">
            送りすぎを防ぐために使います。メールアドレスと接続元の IP アドレスをハッシュ値に変えて、送った時刻と一緒に記録します。ログインを試したときも、続けて試されるのを防ぐため、メールアドレスと接続元の IP アドレスのハッシュ値と日時を記録します。確認や再設定のリンクを使ったときも、混み合うのを防ぐため、接続元の IP アドレスのハッシュ値と日時を記録します。どちらのアドレスも、そのままでは記録しません。1 時間を過ぎた記録は、次に記録するときから順に消します。
          </Term>
          <Term name="Claude を使った回数">1 日の上限を守るために、あなたのメールに Claude を使った回数を日ごとに記録します。Claude が使えなかった呼び出しの分を戻せるように、呼び出しごとの時刻も記録します。この時刻は、呼び出した日の 2 日後から、次に記録するときに順に消します。日ごとの回数は残ります。</Term>
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
          <Term name="読み取りの許可と取り消し">
            <p>届いたメールを Anthropic の Claude に送る前に、読み取りの許可を求めます。許可しなくても、荷物は手で登録できます。</p>
            <p className="mt-2">許可すると、保存されている許可待ちのメールも、自動で読み取りを始めます。上限に達したときや、読み取りに失敗したときは止まることがあります。止まっても、読み取りの許可は残ります。</p>
            <p className="mt-2">設定の「あなたのメールの扱い」にある「{AI_CONSENT_TEXT.stop}」で、その後の読み取りを止められます。すでに読み取りを始めたメールは、最後まで処理されることがあります。{AI_CONSENT_TEXT.retainedResults}</p>
          </Term>
          <Term name="許可待ちのメール">
            <p>{AI_CONSENT_TEXT.waitingRetention}</p>
            <p className="mt-2">期限を過ぎたメールは、毎日の掃除で消します。</p>
          </Term>
          <Term name="ふるい">
            届いたメールは、まずサーバーの中の決まりで、広告などを分けます。読み取りを許可している場合だけ、迷うメールと、「これは荷物」で覚えた差出人のメールの件名と本文の初めの部分を Claude Haiku に送って確かめます。読まないと決めたメールの本文は保存しません。
          </Term>
          <Term name="Claude での読み取り">
            ふるいを通ったメールは、件名・差出人・送信日時・本文を Anthropic の Claude API に送り、荷物の情報を読み取ります。差出人には、名前とメールアドレスが含まれます。読み取りのあいだ、サーバーと Claude API がその内容を扱います。買い物に関係ないと分かったメールは削除します。
          </Term>
          <Term name="保存と暗号化" id="mail-storage">
            買い物に関係するメールは、読み取り後に次のように扱います。メールの鍵がある場合、読み取った件名・差出人・本文を、あなたのパスワードでしか開けない形に暗号化して保存します。鍵がない場合、あなたのメールの件名・差出人・本文は残しません。鍵がないサンプルは、暗号化せずに保存します。荷物の情報と読み取り結果は残ります。暗号化したメールは、運営者もデータベースからは読めません。パスワードそのものは、サーバーに送りません。メールの鍵は、パスワードでログインしたときにブラウザで作ります。開いた鍵は、そのタブの中にだけ置きます。iOS アプリでは、パスワードで開いた鍵を、その端末のキーチェーンに Face ID 付きで保存できます。Touch ID の端末では Touch ID を使います。鍵は端末の外に出ず、iCloud などで同期もせず、運営者にも送りません。ログアウトしたときと、アプリの設定で切ったときに消えます。
          </Term>
          <Term name="パスワードでログインする前と、忘れたとき">
            読み取り後の保存は、<a href="#mail-storage" className="text-sky-700 underline underline-offset-4">「保存と暗号化」</a>をご確認ください。パスワードを忘れたときは、メールで再設定できます。{RESET_LOSES_MAIL}
            パスワードを変えるだけなら、前のメールもそのまま開けます。{PLAINTEXT_DROP_NOTICE}
          </Term>
          <Term name="暗号化しないもの">
            <Bullets>
              <li>荷物の情報と、根拠の行・読み取りメモ。一覧・カレンダー・支出を出すのと、読み取った値を確かめるのに使います。根拠の行は、元のメールの件名や本文の抜粋です。</li>
              <li>
                差出人のドメイン、メールごとの識別子、Gmail の転送の確認メールにある承認リンク。ふるいと、同じメールを二度読まないためと、承認ページを出すために使います。
                <p className="mt-2">{CLEARED_MAIL_MARKS_IDENTIFIERS_NOTICE}</p>
                <p className="mt-2">期間と消し方は、<a href="#cleared-mail-marks" className="text-sky-700 underline underline-offset-4">「照合用の印」</a>をご確認ください。</p>
              </li>
              <li>読み取る前のメール。{UNREAD_MAIL_STORAGE_NOTICE}</li>
              <li>受け取りを元に戻す記録。内容と保存期間は、<a href="#receipt-records" className="text-sky-700 underline underline-offset-4">「受け取りを元に戻す記録」</a>をご確認ください。</li>
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
          <li>荷物と、暗号化して保存したメールは、あなたが消すまで残します。</li>
          <li>
            設定の「サンプルで試す」にある「すべての荷物を消す」で、荷物と、Otodoke に保存したメール・読み取り結果を消せます。{CLEAR_ALL_RETAINED_NOTICE}
          </li>
          <li id="cleared-mail-marks">{CLEARED_MAIL_MARKS_NOTICE}</li>
          <li>
            設定の「アカウントを削除」で、アカウントと、結び付いたデータを削除します。送信やログインを試した記録は、期限後の掃除まで残ります。転送先アドレスも使えなくなります。同じアドレスがほかの人に渡らないように、アドレスの文字と作った日時だけは残します。1 日の上限を守るために、Claude を使った回数も、誰のものか分からない形で日ごとに残します。
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
      {/* The reading-permission policy's release date. Change it if the release moves. */}
      <p className="mt-1 text-xs text-neutral-500">改定日: 2026 年 11 月 12 日</p>
      <PublicPageLinks includePrivacy={false} />
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

function Term({ name, children, id }: { name: string; children: React.ReactNode; id?: string }) {
  return (
    <div id={id}>
      <dt className="font-medium text-neutral-900">{name}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Bullets({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <ul className={`flex list-disc flex-col gap-2 pl-5 ${className}`.trim()}>{children}</ul>;
}
