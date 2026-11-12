import Link from "next/link";
import { PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL, UNREAD_MAIL_STORAGE_NOTICE } from "@/lib/mail-notices";
import { AI_CONSENT_TEXT } from "@/lib/ai-consent-text";

/** 「あなたのメールの扱い」: what happens to a forwarded mail, without promising more than the code does. Same facts as README. */
export function MailHandling({ hideHeading = false }: { hideHeading?: boolean } = {}) {
  return (
    <section>
      {/* On its own page the page's h1 says it; the default keeps the h2 for any other place. */}
      {hideHeading ? null : <h2 className="text-base font-bold">あなたのメールの扱い</h2>}
      <p className={`${hideHeading ? "" : "mt-2 "}mb-3 text-sm leading-6 text-neutral-700`}>読み取りを許可しているときだけ、Anthropic の Claude に送ります。{AI_CONSENT_TEXT.retainedResults}</p>
      <p className="mb-3 text-sm leading-6 text-neutral-700">{AI_CONSENT_TEXT.waitingRetention}</p>
      <ul className={`${hideHeading ? "" : "mt-2 "}flex list-disc flex-col gap-2 rounded-2xl border border-neutral-200 bg-white py-3 pl-8 pr-4 text-sm leading-6 text-neutral-700`}>
        <li>届いたメールは、読み取りのあいだ、サーバーと Claude API が中身を扱います。Anthropic は API のデータを、既定では学習に使いません。</li>
        <li>買い物に関係ないと分かったメールは削除します。</li>
        <li>読み取り後の元メールの保存は、プライバシーポリシーの<Link href="/privacy#mail-storage" className="text-sky-700 underline underline-offset-4">「保存と暗号化」</Link>をご確認ください。パスワードそのものはサーバーに送りません。</li>
        <li>{PLAINTEXT_DROP_NOTICE}</li>
        <li>荷物の情報と読み取り結果、差出人のドメインは暗号化しません。荷物の情報は店・品名・金額・日付・注文番号・伝票番号、読み取り結果は根拠の行と読み取りメモです。根拠の行は、元のメールの件名や本文の抜粋です。一覧・カレンダー・支出を出すのと、読み取った値を元の文で確かめるのと、同じメールを見分けるのに使うためです。</li>
        <li>受け取りを元に戻す記録も暗号化しません。内容と保存期間は、プライバシーポリシーの<Link href="/privacy#receipt-records" className="text-sky-700 underline underline-offset-4">「受け取りを元に戻す記録」</Link>をご確認ください。</li>
        <li>メールごとの識別子の Message-ID と、Gmail の転送の確認メールにある承認リンクも暗号化しません。同じメールを二度読まないためと、承認ページを出すためです。</li>
        <li>{UNREAD_MAIL_STORAGE_NOTICE}</li>
        <li>パスワードを忘れたときは、メールで再設定できます。{RESET_LOSES_MAIL}パスワードを変えるだけなら、前のメールもそのまま開けます。</li>
        <li>受信を受け持つ Resend にも、メールの写しが一定期間残ります。</li>
        <li>暗号化していない状態のメールは、データベースのバックアップにも最大 7 日間残ります。読み取る前のものと、暗号化する前のものです。</li>
        <li>広告など読まなかったメールは、件名と差出人のドメインを記録します。記録してから 14 日を過ぎた分は、毎日の掃除で消します。「これは荷物」と押したメールは、その差出人を覚えている間は残します。「外す」で外すと、記録してから 14 日を過ぎた分を、毎日の掃除で消します。</li>
        <li>iOS アプリでは、パスワードで開いた鍵を、その端末のキーチェーンに Face ID 付きで保存できます。Touch ID の端末では Touch ID を使います。鍵は端末の外に出ず、iCloud などで同期もしません。ログアウトすると消え、アプリの設定で切ることもできます。</li>
        <li>
          運営者が正しいプログラムを動かしていることが前提です。コードはすべて
          <a href="https://github.com/iwaki-syogo/otodoke" target="_blank" rel="noopener noreferrer" className="text-sky-700 underline underline-offset-4">
            公開
          </a>
          しています。
        </li>
      </ul>
    </section>
  );
}
