// Settings words copied word for word from the Web (src/app/app/settings/ and src/lib/mail-notices.ts, merged
// from origin/dev). The file of each sentence is named in the comment above it.
// src/lib/__tests__/ios-settings-align.test.ts looks each one up in the Web's own source. The views draw only
// what is listed here.

import Foundation

enum SettingsWebText {
    // MARK: the list ((list)/page.tsx)

    /// (list)/page.tsx:73
    static let mailGroup = "メール"
    /// (list)/page.tsx:74
    static let accountGroup = "アカウント"
    /// (list)/page.tsx:68
    static let privacyTitle = "プライバシーポリシー"
    /// (list)/page.tsx:69
    static let deleteTitle = "アカウントの削除"
    /// (list)/page.tsx: the account card's first row
    static let loginTitle = "ログイン中"
    /// logout-form.tsx: the account card's second row
    static let logoutTitle = "ログアウト"

    // MARK: 「メールの転送」 (forwarding/page.tsx)

    /// forwarding/page.tsx:24
    static let keyReadFailed = "メールの鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。"
    /// forwarding/page.tsx:41
    static let keyNotMade = "メールの鍵を作ると、ここに出ます。サンプルは鍵なしで試せます。"
    /// forwarding/page.tsx:35
    static let noInboundDomain = "受信ドメインがまだ設定されていません。"
    /// forwarding/page.tsx (the approval card's read failed; welcome/page.tsx says the same)
    static let approvalReadFailed = "Gmail の承認の案内を読み込めませんでした"

    // MARK: 「パスワードとメールの鍵」 (password/page.tsx)

    /// password/page.tsx: the key in use could not be read
    static let passwordKeyReadFailed = "メールの鍵を読み込めませんでした"
    /// password/page.tsx: the count of mail sealed with an earlier key could not be read
    static let oldKeyCountFailed = "前の鍵のメールの数を読み込めませんでした"

    // MARK: 「うまく届かないとき」 (trouble/page.tsx)

    /// trouble/page.tsx: the count of unread mail could not be read
    static let unreadCountFailed = "未読のメールの数を読み込めませんでした"
    /// trouble/page.tsx: no unread mail
    static let unreadNone = "未読のメールはありません。"

    // MARK: 「読まなかったメール」 (dropped/page.tsx)

    /// dropped/page.tsx:68
    static let droppedLead = "広告など、買い物に関係なさそうなメールです。本文は保存せず、件名と差出人のドメインを記録します。記録してから 14 日を過ぎた分は、毎日の掃除で消します。「これは荷物」と押したメールは、その差出人を覚えている間は残します。"
    /// dropped/page.tsx:84
    static func droppedSummary(_ n: Int) -> String {
        "荷物のメールが混ざっていないか、\(n) 通を見る"
    }
    /// src/lib/mail-notices.ts NO_SUBJECT_TEXT (the dropped page draws it)
    static let noSubject = "件名はありません。"

    // MARK: 「パスワードとメールの鍵」, no key yet (password-panel.tsx)

    /// password-panel.tsx:62
    static let makeKeyHeading = "メールの鍵を作る"
    /// password-panel.tsx:63
    static let makeKeyLead = "読み取った後のメールの件名・差出人・本文は、あなたのパスワードでしか開けない形で保存します。"
    /// src/lib/mail-notices.ts:35 (PLAINTEXT_DROP_NOTICE)
    static let plainDropNotice = "パスワードでログインすると、暗号化前に読み取った実メールを順に暗号化します。鍵がないまま残っていた分は、11 月 14 日に件名・差出人・本文を消しました。荷物と、お使いのメールの受信箱は、そのままです。"

    // MARK: 「メールの自動転送の設定」 (forwarding-guide.tsx)

    /// forwarding-guide.tsx:15, in front of the time of each service
    static let timePrefix = "目安: "
}
