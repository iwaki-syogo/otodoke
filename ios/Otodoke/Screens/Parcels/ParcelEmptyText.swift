// The empty parcel list's guide in its three forms: the same sentences and button words as the Web's EMPTY_GUIDE
// (src/app/app/page.tsx), character for character. A vitest (src/lib/__tests__/ios-empty-list.test.ts) compares each
// constant with page.tsx. The view holds none of these words as literals.

import Foundation

/// Where an empty-list button goes. The Web's href → the iOS screen that is the same page.
enum EmptyDestination: Equatable {
    /// /app/settings/forwarding and /app/settings/forwarding#gmail-approval → 設定's 「メールの転送」 (the approval
    /// card is on that page; there is no anchor to scroll to on iOS).
    case forwarding
    /// /app/settings/trouble → 設定's 「うまく届かないとき」.
    case trouble
}

struct EmptyGuide: Equatable {
    let first: String
    let second: String
    let button: String
    let destination: EmptyDestination
}

enum ParcelEmptyText {
    static let noneFirst = "メールの自動転送を設定しますか？"
    static let noneSecond = "設定は最初の 1 回だけです。"
    static let noneButton = "設定する"

    static let receivedFirst = "メールは届いています。"
    static let receivedSecond = "荷物のメールが届くまで、お待ちください。"
    static let receivedButton = "設定を見る"

    static let approvalFirst = "Gmail の転送は承認しましたか？"
    static let approvalSecond = "承認すると、荷物のメールが届きはじめます。"
    static let approvalButton = "設定で承認する"

    static func guide(_ mail: MailSoFar) -> EmptyGuide {
        switch mail {
        case .none: EmptyGuide(first: noneFirst, second: noneSecond, button: noneButton, destination: .forwarding)
        case .received: EmptyGuide(first: receivedFirst, second: receivedSecond, button: receivedButton, destination: .trouble)
        case .approval: EmptyGuide(first: approvalFirst, second: approvalSecond, button: approvalButton, destination: .forwarding)
        }
    }
}
