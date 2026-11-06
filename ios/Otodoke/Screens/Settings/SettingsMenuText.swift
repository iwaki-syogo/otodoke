// The words of the settings list (the root of the 設定 tab) and the titles of its pages. The list is the only
// place that uses the subtitles and badges; the pages' own words stay where they were (SettingsKeyPage,
// ForwardingGuideView, MailHandlingText, …).

import Foundation

enum SettingsMenuText {
    static let forwardTitle = "メールの転送"
    static let forwardSubtitle = "転送先アドレス・設定の手順"
    static let keyTitle = "パスワードとメールの鍵"
    static let keySubtitle = "Face ID・パスワードを変える"
    static let droppedTitle = "読まなかったメール"
    static let handlingTitle = MailHandlingText.heading
    static let deliveryTitle = "うまく届かないとき"
    static let deliverySubtitle = "配送会社のメール・店の通知"
    static let sampleTitle = "サンプルで試す"
    static let webTitle = "Web で開く"

    /// The badge on the key row while there is no key.
    static let keyNoneBadge = "鍵なし"

    /// The badge on the key row while a count of mail could not be read (not drawn as 0).
    static let keyUnknownBadge = "確認できません"

    /// The badge on the key row while the key step after the sign-in did not make a key.
    static let keyStepFailedBadge = "鍵を作れませんでした"

    /// The hint of the 「Web で開く」 row (it leaves the app).
    static let webHint = "Safari で開きます"

    /// The value of an opening and closing card (VoiceOver).
    static let disclosureOpen = "開いています"
    static let disclosureClosed = "閉じています"

    /// The badge on the key row while mail from before the encryption is still readable by the operator.
    static func plainBadge(_ n: Int) -> String {
        "未暗号化 \(n) 通"
    }
}
