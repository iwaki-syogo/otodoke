// The view model of SettingsView (src/app/app/settings/page.tsx, 2541793). Every read fails on its own
// and a failure is told apart from 0 or an empty list. The address is read (or made) only when a key
// row is in use; the approval link is only Google's page (CX4). Old reads are dropped through ReadFence.

import Foundation
import Observation

/// What the settings screen opens on the Web (task.md's 「Web で開く」 list).
enum SettingsWebAction: CaseIterable, Equatable, Sendable {
    /// 「鍵を作る」 (no key row)
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

    static let failedText = "読み込めませんでした"
    /// GMAIL_FILTER of settings/page.tsx.
    static let gmailFilter = "{注文 発送 出荷 配達 お届け 配送 到着 荷物}"
    /// 「暗号化されていないメールの数を読み込めませんでした」
    static let plainCountFailedText = "暗号化されていないメールの数を読み込めませんでした"

    /// S4: the Web's password-panel.tsx (integrate/password-v1): 「前の鍵で暗号化したメールが N 通あります。開けませんが、
    /// 荷物は残っています。」 (password-v1 opens no older key: no promise that it opens).
    static func oldKeyText(_ n: Int) -> String {
        "前の鍵で暗号化したメールが \(n) 通あります。開けませんが、荷物は残っています。"
    }

    /// The page each action opens: https://otodoke.app/… as task.md lists it.
    static func webLink(_ action: SettingsWebAction) -> URL {
        switch action {
        case .createPassphrase, .changePassphrase, .readWaiting, .markAsParcel, .clearAll: WebLink.settings
        case .sample: WebLink.settingsDemo
        case .openWeb: WebLink.app
        }
    }

    let reader: SettingsReader

    private(set) var keyPanel: KeyPanel?
    /// The forwarding address ("local@domain"); read (or made) only when a key row is there.
    private(set) var address: LoadResult<String>?
    /// The approval page, only Google's (Forwarding.confirmURL); nil when there is none.
    private(set) var confirmURL: URL?
    /// The forwarding confirmation could not be read (told apart from "none").
    private(set) var confirmationFailed = false
    private(set) var unread: LoadResult<Int>?
    private(set) var dropped: LoadResult<[DroppedMailRow]>?
    private(set) var isSigningOut = false

    @ObservationIgnored private let inbox: InboxAddressService
    @ObservationIgnored private let auth: AuthService
    @ObservationIgnored private let inboundDomain: String
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let mark: ChangeMark
    @ObservationIgnored private var fence = ReadFence()
    /// A read was started at least once (onAppear reads the first time only when none was).
    @ObservationIgnored private var hasRead = false
    /// [CX-f2] The newest read's: raised as soon as its task is cancelled, before the read ends.
    @ObservationIgnored private var cutOff: CutOffSignal?

    init(
        reader: SettingsReader,
        inbox: InboxAddressService,
        auth: AuthService,
        inboundDomain: String,
        changes: DataChanges?,
        now: @escaping @Sendable () -> Date
    ) {
        self.reader = reader
        self.inbox = inbox
        self.auth = auth
        self.inboundDomain = inboundDomain
        self.mark = ChangeMark(changes)
        self.now = now
    }

    /// The app's model: the signed-in session's provider, the device clock.
    static func live(auth: AuthService, changes: DataChanges?) -> SettingsModel {
        SettingsModel(
            reader: SettingsReader(provider: auth.provider),
            inbox: InboxAddressService(provider: auth.provider),
            auth: auth,
            inboundDomain: auth.provider.config.inboundDomain,
            changes: changes,
            now: { Date() }
        )
    }

    /// The 「この端末で Face ID を使う」 switch (set by MainScreens).
    @ObservationIgnored var faceID: FaceIDSwitch?
    /// The key step after the sign-in (set by MainScreens): its failure shows on the card without a key (S3).
    @ObservationIgnored var keySetup: KeySetup?

    /// S3: on the card without a key row, why the key step after the sign-in did not make one, and whether
    /// 「ログインし直す」 is offered (it makes the key again). N4: the address mismatch is shown without it.
    var keyStepFailure: (message: String, signInAgain: Bool)? {
        guard case .none? = keyPanel else { return nil }
        switch keySetup?.lastOutcome {
        case let .failed(message)?: return (message, KeySetupOutcome.failed(message: message).offersSignInAgain)
        case .addressMismatch?: return (LoginText.addressMismatch, false)
        default: return nil
        }
    }

    /// The switch shows only with a key row in use (not when none, not when the key could not be read)
    /// and a FaceIDSwitch.
    var showsFaceIDToggle: Bool {
        guard faceID != nil, case .present? = keyPanel else { return false }
        return true
    }

    /// The address shows only with a key row in use (never when the key could not be read).
    var showsAddress: Bool {
        if case .present? = keyPanel { return true }
        return false
    }

    /// 「未読のメールが N 通あります」 when N > 0; failedText when it could not be read; nil for 0.
    var unreadHeading: String? {
        switch unread {
        case let .loaded(n)?: n > 0 ? "未読のメールが \(n) 通あります" : nil
        case .failed?: Self.failedText
        case nil: nil
        }
    }

    /// 「ログイン中: …」
    var signedInEmail: String? {
        guard case .signedIn = auth.state else { return nil }
        return auth.provider.auth.currentSession?.user.email
    }

    /// Reads everything again. Each read fails on its own; a newer read drops this one's answers.
    func load() async {
        hasRead = true
        mark.markRead()
        let ticket = fence.beginRead()
        let signal = CutOffSignal()
        cutOff = signal
        let reader = self.reader
        let at = now()

        let (panel, readAddress, readConfirmation, readWaiting, readDropped) = await withTaskCancellationHandler {
            await readAll(reader, at: at)
        } onCancel: {
            signal.raise()
        }

        // [N-new2] A newer read began: it owns the state (this one being cut off changes nothing).
        guard fence.verdict(ticket) == .current else { return }
        // [S1] Cut off (the .task cancelled when the tab is left): the answers are dropped, not shown
        // as failures, and the next appearance reads again.
        guard !Task.isCancelled else {
            hasRead = false
            return
        }
        keyPanel = panel
        address = readAddress
        confirmURL = readConfirmation.value.flatMap { $0 }.flatMap(Self.approvalURL)
        if case .failed = readConfirmation { confirmationFailed = true } else { confirmationFailed = false }
        unread = readWaiting
        dropped = readDropped
    }

    /// The reads of load(): each fails on its own.
    private func readAll(_ reader: SettingsReader, at: Date) async -> (
        KeyPanel, LoadResult<String>?, LoadResult<ForwardingConfirmationRow?>, LoadResult<Int>, LoadResult<[DroppedMailRow]>
    ) {
        async let key = reader.currentKey()
        async let plain = reader.plainCount()
        async let confirmation = reader.forwardingConfirmation()
        async let waiting = reader.unreadCount(now: at)
        async let droppedRows = reader.dropped()

        // The old-key count and the address need the key row; the other reads run meanwhile.
        let panel: KeyPanel
        var readAddress: LoadResult<String>?
        switch await key {
        case .failed:
            panel = .failed
        case .loaded(nil):
            panel = .none(plainCount: await plain)
        case let .loaded(row?):
            async let old = reader.oldKeyCount(currentKeyID: row.keyId)
            readAddress = await readAddressOfKey()
            panel = .present(plainCount: await plain, oldKeyCount: await old)
        }
        return (panel, readAddress, await confirmation, await waiting, await droppedRows)
    }

    /// signOut of AuthService (the key's four steps are task 16). The spinner shows while it runs.
    func signOut() async {
        guard !isSigningOut else { return }
        isSigningOut = true
        await auth.signOut()
        isSigningOut = false
    }

    /// Shown (the tab opened): reads when never read, or when DataChanges moved since the last read.
    func onAppear() async {
        guard !hasRead || mark.isStale || cutOff?.isRaised == true else { return }
        await load()
    }

    /// iOS-12: the app came back to the front while this screen is shown.
    func sceneBecameActive() async {
        await load()
    }

    // MARK: helpers

    /// "local@domain" of the user's address (made on first use), .failed when it could not be read or made.
    /// With no inbound domain set the Web shows 「（受信ドメイン設定前）」 after the local part.
    private func readAddressOfKey() async -> LoadResult<String> {
        do {
            let local = try await inbox.ensure()
            return .loaded(InboxAddressService.email(localPart: local, domain: inboundDomain) ?? "\(local)@（受信ドメイン設定前）")
        } catch {
            return .failed
        }
    }

    /// The address can be copied (an inbound domain is set).
    var addressCanBeCopied: Bool {
        guard case let .loaded(text)? = address else { return false }
        return !inboundDomain.isEmpty && text.hasSuffix("@\(inboundDomain)")
    }

    /// [M1] The stored value first, then the body, as Forwarding.confirmURL (the Web's WHATWG reading),
    /// each also read by Foundation (what Safari opens): handed out only when both readers say Google's
    /// page. A stored value that only WHATWG passes goes on to the body.
    private static func approvalURL(_ row: ForwardingConfirmationRow) -> URL? {
        let texts = [
            Forwarding.confirmURL(stored: row.forwardingConfirmUrl, textBody: nil, htmlBody: nil),
            Forwarding.confirmURL(stored: nil, textBody: row.textBody, htmlBody: row.htmlBody),
        ]
        for case let text? in texts where !text.contains("\\") {
            if let url = URL(string: text), isApprovalPage(url) { return url }
        }
        return nil
    }
}

extension SettingsModel {
    /// [M1] The check right before the approval page is opened (and inside approvalURL): Foundation's
    /// reading of the URL must also be Google's page (https, host mail-settings.google.com, no user or
    /// password, port nil or 443, path from /mail/), not only the WHATWG reading of Forwarding.
    /// [SEC-N5] The `\` test is only a belt: URL(string:) writes `\` as %5C, so it does not fire for
    /// the links approvalURL hands out. The guards are approvalURL's test on the text and the host,
    /// user, password, port and path tests here.
    static func isApprovalPage(_ url: URL) -> Bool {
        url.absoluteString.contains("\\") == false
            && url.scheme?.lowercased() == "https"
            && url.host(percentEncoded: false)?.lowercased() == "mail-settings.google.com"
            && url.user(percentEncoded: false) == nil
            && url.password(percentEncoded: false) == nil
            && (url.port == nil || url.port == 443)
            && url.path(percentEncoded: false).hasPrefix("/mail/")
    }

    /// [S2] The line under the passphrase card about mail sealed with an earlier key:
    /// oldKeyText(n) for n > 0, failedText when the count could not be read, nil for 0 or no key row.
    var oldKeyNote: String? {
        guard case let .present(_, oldKeyCount)? = keyPanel else { return nil }
        switch oldKeyCount {
        case let .loaded(n): return n > 0 ? Self.oldKeyText(n) : nil
        case .failed: return Self.failedText
        }
    }

    /// [S2] failedText when the forwarding confirmation could not be read (told apart from "none");
    /// nil when it was read (whether or not there is one).
    var approvalNote: String? {
        confirmationFailed ? Self.failedText : nil
    }
}
