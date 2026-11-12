// 「あなたのメールの扱い」: the same items as src/app/app/settings/mail-handling.tsx, one string literal per
// item, word for word (a vitest compares them). The last item's 「公開」 links to the repository. Task 19
// added the item about keeping the key in the Keychain with Face ID (also on the Web and in the README).

import SwiftUI
import SafariServices

enum MailHandlingText {
    static let heading = "あなたのメールの扱い"
    static let readingPermission = "読み取りを許可しているときだけ、Anthropic の Claude に送ります。\(AIReadingConsentText.retainedResults)"
    static let waitingRetention = "\(AIReadingConsentText.waitingRetention)"
    static let items: [String] = [
        "届いたメールは、読み取りのあいだ、サーバーと Claude API が中身を扱います。Anthropic は API のデータを、既定では学習に使いません。",
        "買い物に関係ないと分かったメールは削除します。",
        "読み取り後の元メールの保存は、プライバシーポリシーの「保存と暗号化」をご確認ください。パスワードそのものはサーバーに送りません。",
        "パスワードでログインすると、暗号化前に読み取った実メールを順に暗号化します。鍵がないまま残る分は、11 月 14 日に件名・差出人・本文を消す予定です。荷物と、お使いのメールの受信箱は、そのままです。",
        "荷物の情報と読み取り結果、差出人のドメインは暗号化しません。荷物の情報は店・品名・金額・日付・注文番号・伝票番号、読み取り結果は根拠の行と読み取りメモです。根拠の行は、元のメールの件名や本文の抜粋です。一覧・カレンダー・支出を出すのと、読み取った値を元の文で確かめるのと、同じメールを見分けるのに使うためです。",
        "受け取りを元に戻す記録も暗号化しません。内容と保存期間は、プライバシーポリシーの「受け取りを元に戻す記録」をご確認ください。",
        "メールごとの識別子の Message-ID と、Gmail の転送の確認メールにある承認リンクも暗号化しません。同じメールを二度読まないためと、承認ページを出すためです。",
        "1 日の上限を超えた分など、読み取る前のメールは、読み取るまで暗号化せずに置いておきます。",
        "パスワードを忘れたときは、メールで再設定できます。パスワードを決め直すと、前に暗号化して保存したメールは開けなくなります。荷物は残ります。パスワードを変えるだけなら、前のメールもそのまま開けます。",
        "受信を受け持つ Resend にも、メールの写しが一定期間残ります。",
        "暗号化していない状態のメールは、データベースのバックアップにも最大 7 日間残ります。読み取る前のものと、暗号化する前のものです。",
        "広告など読まなかったメールは、件名と差出人のドメインを記録します。記録してから 14 日を過ぎた分は、毎日の掃除で消します。「これは荷物」と押したメールは、その差出人を覚えている間は残します。「外す」で外すと、記録してから 14 日を過ぎた分を、毎日の掃除で消します。",
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
    @State private var showsRepository = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsHeading {
                Text(MailHandlingText.heading)
                    .font(.headline)
            }
            VStack(alignment: .leading, spacing: 8) {
                Text(MailHandlingText.readingPermission)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                Text(MailHandlingText.waitingRetention)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
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
        .environment(\.openURL, OpenURLAction { url in
            guard url == MailHandlingText.repositoryURL else { return .discarded }
            showsRepository = true
            return .handled
        })
        .sheet(isPresented: $showsRepository) { RepositoryPage() }
    }

    /// The item with 「公開」 linked to the repository (an in-app Safari sheet), underlined as on the Web.
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

private struct RepositoryPage: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> SFSafariViewController { SFSafariViewController(url: MailHandlingText.repositoryURL) }
    func updateUIViewController(_ uiViewController: SFSafariViewController, context: Context) {}
}
