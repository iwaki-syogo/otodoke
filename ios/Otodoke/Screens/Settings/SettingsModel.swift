// TDD-STUB(task 10, task 11) — agreed API, placeholder bodies. Remove this marker once written.
// The view model of SettingsView (src/app/app/settings/page.tsx, 2541793).

import Foundation
import Observation

/// What the settings screen opens on the Web (task.md's 「Web で開く」 list).
enum SettingsWebAction: CaseIterable, Equatable, Sendable {
    /// 「合言葉を決める」 (no key row)
    case createPassphrase
    case changePassphrase
    /// 未読の「読み取る」
    case readWaiting
    /// 読まなかったメールの「これは荷物」
    case markAsParcel
    /// サンプル
    case sample
    /// すべて消す
    case clearAll
    /// 「Web で開く」
    case openWeb
}

@MainActor
@Observable
final class SettingsModel {
    /// The passphrase card: could not be read / no key in use / a key in use.
    enum KeyPanel: Equatable, Sendable {
        case failed
        case none(plainCount: LoadResult<Int>)
        case present(plainCount: LoadResult<Int>, oldKeyCount: LoadResult<Int>)
    }

    static let failedText = ""
    /// GMAIL_FILTER of settings/page.tsx.
    static let gmailFilter = ""
    /// 「暗号化されていないメールの数を読み込めませんでした」
    static let plainCountFailedText = ""

    /// 「前の合言葉で暗号化したメールが N 通あります。…」
    static func oldKeyText(_ n: Int) -> String { "" }

    /// The page each action opens: https://otodoke.app/… as task.md lists it.
    static func webLink(_ action: SettingsWebAction) -> URL { WebLink.base }

    let reader: SettingsReader

    private(set) var keyPanel: KeyPanel?
    /// The forwarding address ("local@domain"); read (or made) only when a key row is there.
    private(set) var address: LoadResult<String>?
    /// The approval page, only Google's (Forwarding.confirmURL); nil when there is none.
    private(set) var confirmURL: URL?
    private(set) var unread: LoadResult<Int>?
    private(set) var dropped: LoadResult<[DroppedMailRow]>?
    private(set) var isSigningOut = false

    init(
        reader: SettingsReader,
        inbox: InboxAddressService,
        auth: AuthService,
        inboundDomain: String,
        changes: DataChanges?,
        now: @escaping @Sendable () -> Date
    ) {
        self.reader = reader
    }

    /// The address shows only with a key row in use (never when the key could not be read).
    var showsAddress: Bool { true }
    /// 「未読のメールが N 通あります」 when N > 0; failedText when it could not be read; nil for 0.
    var unreadHeading: String? { nil }
    /// 「ログイン中: …」
    var signedInEmail: String? { nil }

    func load() async {}
    func signOut() async {}
    func onAppear() async {}
    func sceneBecameActive() async {}
}
