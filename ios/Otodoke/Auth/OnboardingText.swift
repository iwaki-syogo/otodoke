// The words from registering to the forwarding setup. The source is the owner's wording file
// (docs/ux-redo/onboarding-wording.md, fixed 2026-11-07), which the Web's screens use word for word. A vitest
// (src/lib/__tests__/ios-onboarding.test.ts) compares each constant with a copy of that file's sentences. When
// the Web's constants land in src, the copy moves there. Every sentence of the two screens lives here; the views
// hold no Japanese literal of these.

import Foundation

enum OnboardingText {
    // MARK: screen 1: waiting for the confirmation (after making an account)

    static let waitingTitle = "確認のメールを送りました"
    static let waitingLead = "メールのリンクを押してこの画面に戻ると、自動で次へ進みます。"
    static let confirmedButton = "確認しました"
    /// The secondary button: the confirmation mail again.
    static let resendButton = "メールを送り直す"
    /// Shown only after 「確認しました」 was pressed and the address is still not confirmed (never after the automatic try).
    static let notConfirmedYet = "まだ確認できていません。メールのリンクを押しましたか？"
    /// Right after the mail was sent again.
    static let resent = "送り直しました"
    /// Not in the wording file: the way out of the wait to the sign-up form (a different address).
    static let startOver = "別のアドレスでやり直す"

    // MARK: screen 3: the first guide (after the first key was made)

    static let guideTitle = "最後に、メールの自動転送を設定しますか？"
    static let guideLead = "設定は最初の 1 回だけです。"
    static let step1Heading = "1. 転送先アドレスをコピー"
    static let step2Heading = "2. お使いのメールで設定"
    static let doneButton = "設定しました"
    static let laterButton = "あとで"

    // MARK: the address when there is no key (the same words as 「メールの転送」)

    static let addressNoKey = "鍵ができると、ここに出ます。サンプルは鍵なしで試せます。"
    static let addressKeyFailed = "鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。"
}
