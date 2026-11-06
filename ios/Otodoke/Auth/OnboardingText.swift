// The words from registering to the forwarding setup: the same sentences as the Web's, character for character
// (src/lib/onboarding.ts: CONFIRM_WAIT and WELCOME). A vitest (src/lib/__tests__/ios-onboarding.test.ts) compares
// each constant with those exports. Every sentence of the two screens lives here; the views hold no Japanese
// literal of these.

import Foundation

enum OnboardingText {
    // MARK: screen 1: waiting for the confirmation (after making an account)

    static let waitingTitle = "確認のメールを送りました"
    static let waitingLead = "メールのリンクを開いて「確認する」を押すと、この画面が自動で次へ進みます。進まないときは「確認しました」を押してください。"
    static let confirmedButton = "確認しました"
    /// The secondary button: the confirmation mail again.
    static let resendButton = "メールを送り直す"
    /// Shown only after 「確認しました」 was pressed and the address is still not confirmed (never after the automatic try).
    static let notConfirmedYet = "まだ確認できていません。メールのリンクを開いて「確認する」を押しましたか？"
    /// Right after the mail was sent again.
    static let resent = "送り直しました"
    /// Not in the wording file: the way out of the wait to the sign-up form (a different address).
    static let startOver = "別のアドレスでやり直す"

    // MARK: the waiting screen's try is refused for credentials: the address already had an account

    // TODO: Web の onboarding.ts に入ったら、比べる先をそちらに替える (ios-onboarding.test.ts compares with the Web's
    // file by itself once it holds the sentence; until then with a copy in the test).
    /// Supabase answers a sign-up for a registered address with "sent" and sets no new password: the waiting screen's
    /// sign-in then fails for credentials. Shown in place of LoginText.credentials, under the sign-in form.
    static let existingAddress = "このアドレスは、もう登録されています。前に決めたパスワードでログインしてください。"
    /// The Web's RESET_LOSES_MAIL (src/lib/mail-notices.ts), shown with the link to the reset.
    static let resetLosesMail = "パスワードを決め直すと、前に暗号化して保存したメールは開けなくなります。荷物は残ります。"

    // MARK: the waiting screen's end when the key did not open or could not be made (the Web's signup-form.tsx)

    /// The first link of the amber box: on to the 荷物 tab.
    static let keyBoxProceed = "このまま進む"
    /// The second link: 設定's page of that name (SettingsMenuText.keyTitle).
    static let keyBoxKeyPage = "パスワードとメールの鍵"

    // MARK: screen 3: the first guide (after the first key was made)

    static let guideTitle = "最後に、メールの自動転送を設定しますか？"
    static let guideLead = "設定は最初の 1 回だけです。"
    static let step1Heading = "1. 転送先アドレスをコピー"
    static let step2Heading = "2. お使いのメールで設定"
    static let doneButton = "設定しました"
    static let laterButton = "あとで"

    // The address when there is no key uses the words of 「メールの転送」 (SettingsWebText.keyReadFailed, keyNotMade).
}
