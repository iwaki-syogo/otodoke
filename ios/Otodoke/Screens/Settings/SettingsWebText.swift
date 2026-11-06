// Settings words copied word for word from the Web (origin/dev 173667c, src/app/app/settings/ and
// src/lib/mail-notices.ts). The line of each sentence is in the comment above it. No sentence is written
// here: src/lib/__tests__/ios-settings-align.test.ts pins each one (when dev is merged into this branch that
// test turns into a comparison with the Web files themselves). The views draw only what is listed here.

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

    // MARK: 「メールの転送」 (forwarding/page.tsx)

    /// forwarding/page.tsx:24
    static let keyReadFailed = "メールの鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。"
    /// forwarding/page.tsx:41
    static let keyNotMade = "メールの鍵を作ると、ここに出ます。サンプルは鍵なしで試せます。"
    /// forwarding/page.tsx:35
    static let noInboundDomain = "受信ドメインがまだ設定されていません。"

    // MARK: 「読まなかったメール」 (dropped/page.tsx)

    /// dropped/page.tsx:68
    static let droppedLead = "広告など、買い物に関係なさそうなメールです。本文は保存せず、件名と差出人のドメインだけ 14 日間残します。"
    /// dropped/page.tsx:84
    static func droppedSummary(_ n: Int) -> String {
        "荷物のメールが混ざっていないか、\(n) 通を見る"
    }
    /// dropped/page.tsx:89
    static let noSubject = "件名はありません。"

    // MARK: 「パスワードとメールの鍵」, no key yet (password-panel.tsx)

    /// password-panel.tsx:62
    static let makeKeyHeading = "メールの鍵を作る"
    /// password-panel.tsx:63
    static let makeKeyLead = "読み取った後のメールの件名・差出人・本文は、あなたのパスワードでしか開けない形で保存します。"
    /// password-panel.tsx:66, then PLAINTEXT_DROP_NOTICE (src/lib/mail-notices.ts:35) right after it
    static func plainMailNote(_ n: Int) -> String {
        "暗号化されていない保存済みのメール \(n) 通も、鍵を作ったあとに暗号化できます。それまでは運営者が読める形です。" + plainDropNotice
    }
    /// src/lib/mail-notices.ts:35 (PLAINTEXT_DROP_NOTICE)
    static let plainDropNotice = "パスワードでログインしていない場合は、11 月 14 日に件名・差出人・本文を消します。荷物は残ります。"

    // MARK: 「メールの自動転送の設定」 (forwarding-guide.tsx)

    /// forwarding-guide.tsx:15, in front of the time of each service
    static let timePrefix = "目安: "
}
