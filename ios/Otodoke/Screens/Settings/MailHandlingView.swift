// 「あなたのメールの扱い」: the same items as src/app/app/settings/mail-handling.tsx, one string literal per
// item, word for word (a vitest compares them). The last item's 「公開」 links to the repository. Task 19
// added the item about keeping the key in the Keychain with Face ID (also on the Web and in the README).

import SwiftUI

enum MailHandlingText {
    static let heading = "あなたのメールの扱い"
    static let items: [String] = [
        "届いたメールは、読み取る数秒のあいだ、サーバーと Claude API が中身を扱います。Anthropic は API のデータを、既定では学習に使いません。",
        "読み取って買い物に関係ないと分かったメールは、Otodoke に残しません。",
        "読み取った後のメールの件名・差出人・本文は、あなたのパスワードでしか開けない形で保存します。パスワードそのものはサーバーに送らないので、運営者もデータベースからは読めません。",
        "ただし、暗号化を始める前に読み取ったメールは、暗号化していません。「暗号化する」を押すまで、運営者が読める形で残ります。パスワードでログインしていない場合、Otodoke に保存した件名・差出人・本文は、11 月 14 日に Otodoke から消えます。荷物と、お使いのメールの受信箱は、そのままです。",
        "荷物の情報と読み取り結果、差出人のドメインは暗号化しません。荷物の情報は店・品名・金額・日付・注文番号・伝票番号、読み取り結果は根拠の行と読み取りメモです。根拠の行は本文の抜粋です。一覧・カレンダー・支出を出すのと、読み取った値を元の文で確かめるのと、同じメールを見分けるのに使うためです。",
        "メールごとの識別子の Message-ID と、Gmail の転送の確認メールにある承認リンクも暗号化しません。同じメールを二度読まないためと、承認ページを出すためです。",
        "1 日の上限を超えた分など、読み取る前のメールは、読み取るまで暗号化せずに置いておきます。",
        "Otodoke が暗号化を始めた後、パスワードでログインする前に読み取ったメールは、件名・差出人・本文を残しません。荷物の情報は残ります。",
        "パスワードを忘れたときは、メールで再設定できます。パスワードを決め直すと、前に暗号化して保存したメールは開けなくなります。荷物は残ります。パスワードを変えるだけなら、前のメールもそのまま開けます。",
        "受信を受け持つ Resend にも、メールの写しが一定期間残ります。",
        "暗号化していない状態のメールは、データベースのバックアップにも最大 7 日間残ります。読み取る前のものと、暗号化する前のものです。",
        "広告など読まなかったメールは、件名と差出人のドメインだけを 14 日間残します。「これは荷物」と押したメールは、その差出人を覚えている間は残します。「外す」で外すと、ほかと同じく 14 日で Otodoke から消えます。",
        "iOS アプリでは、パスワードで開いた鍵を、その端末のキーチェーンに Face ID 付きで保存できます。Touch ID の端末では Touch ID を使います。鍵は端末の外に出ず、iCloud などで同期もしません。ログアウトすると消え、アプリの設定で切ることもできます。",
        "運営者が正しいプログラムを動かしていることが前提です。コードはすべて公開しています。"
    ]
    static let repositoryURL = URL(string: "https://github.com/iwaki-syogo/otodoke")!
    /// The word of the last item that links to the repository.
    static let linkWord = "公開"
}

/// The section, as the Web draws it: a heading and a bulleted list in a card.
struct MailHandlingView: View {
    /// False on its own settings page, whose title already says it.
    var showsHeading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsHeading {
                Text(MailHandlingText.heading)
                    .font(.headline)
            }
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
