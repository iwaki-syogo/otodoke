// The words of 「サンプルで試す」, as the Web's settings/demo page says them (src/app/app/settings/demo/page.tsx,
// demo-loader.tsx, src/lib/settings-errors.ts, demo-labels.ts, and the list's note in src/app/app/page.tsx).
// src/lib/__tests__/ios-demo-page.test.ts reads this file against those. The views carry no wording of their own.

import Foundation

enum DemoText {
    static let lead = "匿名化した実際の注文・発送メールと、見本として作った 1 年分の注文を読み込みます。日付は、読み込んだ日に合わせてずらします。"

    // MARK: loading

    /// LOAD_DEMO_LABEL (the list's busy note carries the same words).
    static let loadLabel = "サンプルのメールを読み込む"
    static let loadBusy = "読み込んでいます…"

    /// demo_failed
    static let loadFailed = "サンプルを最後まで読み込めませんでした。もう一度お試しください。"

    /// 「{N} 通は読み込めました。」 under a failed load that got some of the mails in.
    static func partialLoaded(_ count: Int) -> String {
        "\(count) 通は読み込めました。"
    }

    /// The note the list carries when another load is running (the Web's ?demo=busy; PENDING_GRACE_MS is 3 minutes).
    static let busyNote = "ほかの人がサンプルを読み込んでいるかもしれません。3 分ほど待ってから、もう一度サンプルを読み込んでください。"

    /// VoiceOver's hint on the busy note's button (the page it opens).
    static let busyHint = "サンプルの画面を開きます"

    // MARK: clearing

    static let clearSummary = "すべての荷物を消す"
    static let clearWarning = "Otodoke の荷物と、Otodoke に保存したメールを消します。お使いのメールの受信箱は、そのままです。消すと元に戻せません。"
    static let clearCheck = "本当に消す"
    static let clearButton = "消す"
    static let clearBusy = "消しています…"
    static let cleared = "Otodoke の荷物と、Otodoke に保存したメールを消しました。お使いのメールの受信箱は、そのままです。"

    /// clear_confirm
    static let clearConfirm = "「本当に消す」にチェックを入れてください"
    /// clear_failed
    static let clearFailed = "消せませんでした。もう一度お試しください。"
}
