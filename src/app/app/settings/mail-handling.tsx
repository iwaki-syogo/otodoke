import { PLAINTEXT_DROP_NOTICE, RESET_LOSES_MAIL } from "@/lib/mail-notices";

/** 「あなたのメールの扱い」: what happens to a forwarded mail, without promising more than the code does. Same facts as README. */
export function MailHandling() {
  return (
    <section>
      <h2 className="text-base font-bold">あなたのメールの扱い</h2>
      <ul className="mt-2 flex list-disc flex-col gap-2 rounded-2xl border border-neutral-200 bg-white py-3 pl-8 pr-4 text-sm leading-6 text-neutral-700">
        <li>届いたメールは、読み取る数秒のあいだ、サーバーと Claude API が中身を扱います。Anthropic は API のデータを、既定では学習に使いません。</li>
        <li>読み取った後のメールの件名・差出人・本文は、あなたのパスワードでしか開けない形で保存します。パスワードそのものはサーバーに送らないので、運営者もデータベースからは読めません。</li>
        <li>
          ただし、暗号化を始める前に読み取ったメールは、暗号化していません。「暗号化する」を押すまで、運営者が読める形で残ります。{PLAINTEXT_DROP_NOTICE}
        </li>
        <li>荷物の情報と読み取り結果、差出人のドメインは暗号化しません。荷物の情報は店・品名・金額・日付・注文番号・伝票番号、読み取り結果は根拠の行と読み取りメモです。根拠の行は本文の抜粋です。一覧・カレンダー・支出を出すのと、読み取った値を元の文で確かめるのと、同じメールを見分けるのに使うためです。</li>
        <li>メールごとの識別子の Message-ID と、Gmail の転送の確認メールにある承認リンクも暗号化しません。同じメールを二度読まないためと、承認ページを出すためです。</li>
        <li>1 日の上限を超えた分など、読み取る前のメールは、読み取るまで暗号化せずに置いておきます。</li>
        <li>Otodoke が暗号化を始めた後、パスワードでログインする前に読み取ったメールは、件名・差出人・本文を残しません。荷物の情報は残ります。</li>
        <li>パスワードを忘れたときは、メールで再設定できます。{RESET_LOSES_MAIL}パスワードを変えるだけなら、前のメールもそのまま開けます。</li>
        <li>受信を受け持つ Resend にも、メールの写しが一定期間残ります。</li>
        <li>暗号化していない状態のメールは、データベースのバックアップにも最大 7 日間残ります。読み取る前のものと、暗号化する前のものです。</li>
        <li>広告など読まなかったメールは、件名と差出人のドメインだけを 14 日間残します。「これは荷物」と押したメールは、その差出人を覚えている間は残します。「外す」で外すと、ほかと同じく 14 日で消します。</li>
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
