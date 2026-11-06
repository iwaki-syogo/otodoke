// 「あなたのメールの扱い」: the same items as src/app/app/settings/mail-handling.tsx, one string literal per
// item, word for word (a vitest compares them). The last item's 「公開」 links to the repository. Task 19
// added the item about keeping the key in the Keychain with Face ID (also on the Web and in the README).

import SwiftUI

enum MailHandlingText {
    static let heading = "あなたのメールの扱い"
    static let items: [String] = [
        "届いたメールは、読み取る数秒のあいだ、サーバーと Claude API が中身を扱います。Anthropic は API のデータを、既定では学習に使いません。",
        "読み取った後のメール（件名・差出人・本文）は、あなたの合言葉でしか開けない形で保存します。運営者もデータベースからは読めません。",
        "ただし、暗号化を始める前に読み取ったメールは、暗号化していません。合言葉を決めて「暗号化する」を押すまで、運営者が読める形で残ります。",
        "荷物の情報（店・品名・金額・日付・注文番号・伝票番号）、読み取り結果（根拠の行・読み取りメモ）、差出人のドメインは暗号化しません。根拠の行は本文の抜粋です。一覧・カレンダー・支出を出すのと、読み取った値を元の文で確かめるのと、同じメールを見分けるのに使うためです。",
        "メールごとの識別子（Message-ID）と、Gmail の転送の確認メールにある承認リンクも暗号化しません。同じメールを二度読まないためと、承認ページを出すためです。",
        "読み取る前のメール（1 日の上限を超えた分など）は、読み取るまで暗号化せずに置いておきます。",
        "暗号化を始めた後、合言葉を決める前に届いたメールは、件名・差出人・本文を保存しません。荷物の情報は残ります。",
        "合言葉を忘れると、前のメールは誰にも戻せません。荷物は残ります。",
        "受信を受け持つ Resend にも、メールの写しが一定期間残ります。",
        "暗号化していない状態のメール（読み取る前のもの、暗号化する前のもの）は、データベースのバックアップにも最大 7 日間残ります。",
        "広告など読まなかったメールは、件名と差出人のドメインだけを 14 日間残します。「これは荷物」と押したものは、次から読むために消さずに残します。",
        "iOS アプリでは、合言葉で開いた鍵を、その端末のキーチェーンに Face ID 付きで保存できます（Touch ID の端末では Touch ID）。鍵は端末の外に出ず、iCloud などで同期もしません。ログアウトすると消え、設定で切ることもできます。",
        "運営者が正しいプログラムを動かしていることが前提です。コードはすべて公開しています。"
    ]
    static let repositoryURL = URL(string: "https://github.com/iwaki-syogo/otodoke")!
    /// The word of the last item that links to the repository.
    static let linkWord = "公開"
}

/// The section, as the Web draws it: a heading and a bulleted list in a card.
struct MailHandlingView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(MailHandlingText.heading)
                .font(.headline)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(MailHandlingText.items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•")
                        if index == MailHandlingText.items.count - 1 {
                            Text(Self.linked(item))
                        } else {
                            Text(item)
                        }
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
        }
    }

    /// The item with 「公開」 linked to the repository (opens in Safari), underlined as on the Web.
    static func linked(_ item: String) -> AttributedString {
        var text = AttributedString(item)
        if let range = text.range(of: MailHandlingText.linkWord) {
            text[range].link = MailHandlingText.repositoryURL
            text[range].foregroundColor = OtodokeColor.link
            text[range].underlineStyle = .single
        }
        return text
    }
}
