/** 「あなたのメールの扱い」: what happens to a forwarded mail, without promising more than the code does. Same facts as README. */
export function MailHandling() {
  return (
    <section>
      <h2 className="text-base font-bold">あなたのメールの扱い</h2>
      <ul className="mt-2 flex list-disc flex-col gap-2 rounded-2xl border border-neutral-200 bg-white py-3 pl-8 pr-4 text-sm leading-6 text-neutral-700">
        <li>届いたメールは、読み取る数秒のあいだ、サーバーと Claude API が中身を扱います。Anthropic は API のデータを、既定では学習に使いません。</li>
        <li>読み取った後のメール（件名・差出人・本文）は、あなたの合言葉でしか開けない形で保存します。運営者もデータベースからは読めません。</li>
        <li>荷物の情報（店・品名・金額・日付・注文番号・伝票番号・根拠の行）と、差出人のドメインは暗号化しません。一覧・カレンダー・支出を出すのと、同じメールを見分けるのに使うためです。</li>
        <li>読み取る前のメール（1 日の上限を超えた分など）は、読み取るまで暗号化せずに置いておきます。</li>
        <li>合言葉を決める前に届いたメールは、件名・差出人・本文を保存しません。荷物の情報は残ります。</li>
        <li>合言葉を忘れると、前のメールは誰にも戻せません。荷物は残ります。</li>
        <li>受信を受け持つ Resend にも、メールの写しが一定期間残ります。</li>
        <li>暗号化を始める前のバックアップには、最大 7 日間、暗号化していないメールが残ります。</li>
        <li>広告など読まなかったメールは、件名と差出人のドメインだけを 14 日間残します。</li>
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
