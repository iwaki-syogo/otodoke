// The words of 「これは荷物」 (読まなかったメール) and 「読み取る」 (未読のメール), copied word for word from the Web:
// src/app/app/settings/dropped/page.tsx (SENDER_NOTES, the buttons), trouble/page.tsx (the button) and
// src/lib/settings-errors.ts. src/lib/__tests__/ios-mail-actions.test.ts looks each one up in the Web's own source.
// The views draw only what is listed here.

import Foundation

enum SettingsMailText {
    // MARK: 「これは荷物」 (dropped/page.tsx)

    /// dropped/page.tsx: the button
    static let markLabel = "これは荷物"
    /// dropped/page.tsx: the button while it works
    static let markBusy = "記録しています…"
    /// dropped/page.tsx: the row that was marked
    static let marked = "荷物として記録済み"
    /// dropped/page.tsx: SENDER_NOTES.flagged.remembered
    static let rememberedNote = "覚えました。この差出人のメールは、次から Claude が確認します。今回の荷物は手で登録できます。"
    /// dropped/page.tsx: SENDER_NOTES.flagged.shared
    static let sharedNote = "Gmail など多くの人が使うアドレスは、差出人として覚えられません。今回の荷物は手で登録できます。"
    /// dropped/page.tsx: SENDER_NOTES.flagged.forwarded
    static let forwardedNote = "手で転送されたメールは、差出人として覚えられません。今回の荷物は手で登録できます。"
    /// dropped/page.tsx: SENDER_NOTES.flagged.own
    static let ownNote = "ご自身のアドレスから届いたメールは、差出人として覚えられません。今回の荷物は手で登録できます。"
    /// dropped/page.tsx: SENDER_NOTES.flagged.failed
    static let markFailed = "記録できませんでした。もう一度お試しください。"
    /// dropped/page.tsx: the link under a note that says the parcel can be registered by hand
    static let register = "荷物を登録する"

    // MARK: 「読み取る」 (trouble/page.tsx, settings-errors.ts)

    /// trouble/page.tsx: the button
    static let readLabel = "読み取る"
    /// trouble/page.tsx: the button while it works
    static let readBusy = "読み取っています…"
    /// settings-errors.ts: SETTINGS_ERROR_MESSAGES.read_failed
    static let readFailed = "読み取れなかったメールがあります。少し時間をおいて、もう一度お試しください。"
    /// settings-errors.ts: UNKNOWN_SETTINGS_ERROR
    static let unknownFailure = "うまくいきませんでした。もう一度お試しください。"

    /// The sentence of an outcome of 「これは荷物」.
    static func note(for outcome: MarkParcelOutcome) -> String {
        switch outcome {
        case .remembered: rememberedNote
        case .shared: sharedNote
        case .forwarded: forwardedNote
        case .own: ownNote
        }
    }
}
