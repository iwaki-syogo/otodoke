// The view model of SettingsView (src/app/app/settings/page.tsx, 2541793). Every read fails on its own
// and a failure is told apart from 0 or an empty list. The address is read (or made) only when a key
// row is in use; the approval link is only Google's page (CX4). Old reads are dropped through ReadFence.

import Foundation
import Observation

/// What the settings screen opens on the Web (task.md's 「Web で開く」 list).
enum SettingsWebAction: CaseIterable, Equatable, Sendable {
    case changePassphrase
    /// 「Web で開く」
    case openWeb
    /// 「プライバシーポリシー」
    case privacy
    /// 「アカウントの削除」
    case deleteAccount
}

@MainActor
@Observable
final class SettingsModel {
    /// The passphrase card: could not be read / no key in use / a key in use.
    enum KeyPanel: Equatable, Sendable {
        case failed
        case none
        case present(oldKeyCount: LoadResult<Int>)
    }

    static let failedText = "読み込めませんでした"
    /// GMAIL_FILTER of src/lib/forwarding-guide.ts.
    static let gmailFilter = "{注文 発送 出荷 配達 お届け 配送 到着 荷物}"

    /// S4: the Web's password-panel.tsx (integrate/password-v1): 「前の鍵で暗号化したメールが N 通あります。開けませんが、
    /// 荷物は残っています。」 (password-v1 opens no older key: no promise that it opens).
    static func oldKeyText(_ n: Int) -> String {
        "前の鍵で暗号化したメールが \(n) 通あります。開けませんが、荷物は残っています。"
    }

    /// The page each action opens: https://otodoke.app/… as task.md lists it.
    static func webLink(_ action: SettingsWebAction) -> URL {
        switch action {
        case .changePassphrase: WebLink.settingsPassword
        case .openWeb: WebLink.app
        case .privacy: WebLink.privacy
        case .deleteAccount: WebLink.settingsDelete
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
    /// The 「承認待ち」 badge of the list (the Web's readApprovalBadge): the confirmation with Google's link exists and
    /// nothing arrived after it (by created_at). The card itself does not use this: it shows whenever such a
    /// confirmation exists.
    private(set) var approvalWaiting = false
    /// The confirmation, or what the badge needs after it, could not be read (the badge says it cannot be checked).
    private(set) var approvalBadgeFailed = false
    private(set) var unread: LoadResult<Int>?
    /// Why the unread mail waits (stopped, over the limit, failed); read only when some is waiting. .failed or nil:
    /// no reason is stated (the Web's `reasons` null).
    private(set) var unreadReasons: LoadResult<UnreadReasons>?
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
    /// Reads running now (load() adds one while it runs).
    @ObservationIgnored private var loadsRunning = 0
    /// How many full reads have begun (the auto refresh drops its answers when this moved).
    @ObservationIgnored private var loadsStarted = 0
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
        let model = SettingsModel(
            reader: SettingsReader(provider: auth.provider),
            inbox: InboxAddressService(provider: auth.provider),
            auth: auth,
            inboundDomain: auth.provider.config.inboundDomain,
            changes: changes,
            now: { Date() }
        )
        let provider = auth.provider
        model.demo = DemoModel(
            api: DemoAPIClient(session: provider.urlSession),
            accessToken: { try? await provider.auth.session.accessToken },
            changed: { ParcelWriter.announceOutsideChange(changes) }
        )
        return model
    }

    /// 「サンプルで試す」 (set by live()): the sample load and clear-everything, through the Web's endpoints.
    @ObservationIgnored var demo: DemoModel?

    /// The 「この端末で Face ID を使う」 switch (set by MainScreens).
    @ObservationIgnored var faceID: FaceIDSwitch?
    /// The key step after the sign-in (set by MainScreens): its failure shows on the card without a key (S3).
    @ObservationIgnored var keySetup: KeySetup?

    /// 「これは荷物」 and 「読み取る」, done in the app through the Web's mail endpoints (MailActionsModel). Made on first use
    /// with the signed-in session; a test sets its own.
    @ObservationIgnored lazy var mailActions: MailActionsModel = {
        let provider = auth.provider
        return MailActionsModel(
            api: MailActionsClient(session: provider.urlSession),
            accessToken: { try? await provider.auth.session.accessToken },
            reload: { [weak self] in await self?.load() },
            announceChange: { [changes = mark.changes] in ParcelWriter.announceOutsideChange(changes) }
        )
    }()

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

    /// 「未読のメールが N 通あります」 when N > 0; unreadCountFailed when it could not be read; nil for 0.
    var unreadHeading: String? {
        switch unread {
        case let .loaded(n)?: n > 0 ? "未読のメールが \(n) 通あります" : nil
        case .failed?: SettingsWebText.unreadCountFailed
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
        loadsStarted += 1
        loadsRunning += 1
        defer { loadsRunning -= 1 }
        mark.markRead()
        let ticket = fence.beginRead()
        let signal = CutOffSignal()
        cutOff = signal
        let reader = self.reader
        let at = now()

        let (panel, readAddress, readConfirmation, readLater, readWaiting, readDropped, readReasons) = await withTaskCancellationHandler {
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
        applyApproval(readConfirmation, later: readLater)
        unread = readWaiting
        unreadReasons = readReasons
        dropped = readDropped
        lastApprovalRead = at
    }

    /// The reads of load(): each fails on its own.
    private func readAll(_ reader: SettingsReader, at: Date) async -> (
        KeyPanel, LoadResult<String>?, LoadResult<[ForwardingConfirmationRow]>, LoadResult<Int>?, LoadResult<Int>, LoadResult<[DroppedMailRow]>,
        LoadResult<UnreadReasons>?
    ) {
        async let key = reader.currentKey()
        async let confirmation = reader.forwardingConfirmations()
        async let waiting = reader.unreadCount(now: at)
        async let droppedRows = reader.dropped()

        // The old-key count and the address need the key row; the other reads run meanwhile.
        let panel: KeyPanel
        var readAddress: LoadResult<String>?
        switch await key {
        case .failed:
            panel = .failed
        case .loaded(nil):
            panel = .none
        case let .loaded(row?):
            async let old = reader.oldKeyCount(currentKeyID: row.keyId)
            readAddress = await readAddressOfKey()
            panel = .present(oldKeyCount: await old)
        }
        // What arrived after the confirmation the card shows (the badge's time rule).
        let confirmationRows = await confirmation
        var later: LoadResult<Int>?
        if let pick = confirmationRows.value.flatMap(Self.pickApproval), let at = pick.at {
            later = await reader.arrivedAfter(at)
        }
        let waitingResult = await waiting
        // The reasons are read only when a count was read and some mail waits (the Web's trouble page).
        var reasons: LoadResult<UnreadReasons>?
        if case let .loaded(n) = waitingResult, n > 0 { reasons = await reader.unreadReasons(now: at) }
        return (panel, readAddress, confirmationRows, later, waitingResult, await droppedRows, reasons)
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

    /// A page of the list was shown (pushed or come back to): reads again through load(), so a mail that
    /// came while the tab stayed open (the Gmail approval) shows without leaving the
    /// tab. Nothing is cleared while it reads. Skipped while a read is running, unless that read was
    /// cut off (its answers will be dropped).
    func pageShown() async {
        guard loadsRunning == 0 || cutOff?.isRaised == true else { return }
        await load()
    }

    /// The card's auto refresh runs only for a person who has an address to forward to and no approval link yet
    /// (a failed read of the confirmation counts as "no link yet", as on the Web).
    var pollsForApproval: Bool {
        guard case .present? = keyPanel, addressCanBeCopied, confirmURL == nil else { return false }
        return true
    }

    /// When the confirmation mail was last read (by load() or refreshApproval()).
    private(set) var lastApprovalRead: Date?

    /// The confirmation, the card it shows and the list's 「承認待ち」 badge, decided in one place for load() and the auto refresh.
    private func applyApproval(_ confirmation: LoadResult<[ForwardingConfirmationRow]>, later: LoadResult<Int>?) {
        let pick = confirmation.value.flatMap(Self.pickApproval)
        confirmURL = pick?.url
        if case .failed = confirmation { confirmationFailed = true } else { confirmationFailed = false }
        if let later {
            approvalWaiting = (later.value ?? 1) <= 0
            approvalBadgeFailed = later == .failed
        } else {
            approvalWaiting = false
            approvalBadgeFailed = confirmationFailed
        }
    }

    /// Reads only the approval again (the auto refresh): the confirmation mail and, as load() does, what arrived after
    /// it for the badge. No other state is touched. Skipped while a full read runs; the answers are dropped when a
    /// full read began meanwhile (it owns the state), and when the refresh was cancelled (the page was left: a
    /// cut-off read is not a failed read, and it does not count as a read).
    func refreshApproval() async {
        guard pollsForApproval, loadsRunning == 0 else { return }
        let started = loadsStarted
        let confirmation = await reader.forwardingConfirmations()
        var later: LoadResult<Int>?
        if !Task.isCancelled, let at = confirmation.value.flatMap(Self.pickApproval)?.at {
            later = await reader.arrivedAfter(at)
        }
        guard !Task.isCancelled, started == loadsStarted, loadsRunning == 0, pollsForApproval else { return }
        lastApprovalRead = now()
        applyApproval(confirmation, later: later)
    }

    /// iOS-12: the app came back to the front while this screen is shown.
    func sceneBecameActive() async {
        await load()
    }

    // MARK: helpers

    /// "local@domain" of the user's address (made on first use), .failed when it could not be read or made.
    /// With no inbound domain set the Web shows 「受信ドメインがまだ設定されていません。」 in place of the address.
    private func readAddressOfKey() async -> LoadResult<String> {
        do {
            let local = try await inbox.ensure()
            return .loaded(InboxAddressService.email(localPart: local, domain: inboundDomain) ?? SettingsWebText.noInboundDomain)
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
    /// The Web's readConfirmUrl: of the newest few confirmations (created_at ↓) the first whose link is Google's
    /// own; a look-alike newer than the real one (no link, or another host) is passed over. `at` is its created_at.
    static func pickApproval(_ rows: [ForwardingConfirmationRow]) -> (url: URL, at: String?)? {
        for row in rows {
            if let url = approvalURL(row) { return (url, row.createdAt) }
        }
        return nil
    }

    static func approvalURL(_ row: ForwardingConfirmationRow) -> URL? {
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
    /// oldKeyText(n) for n > 0, oldKeyCountFailed when the count could not be read, nil for 0 or no key row.
    var oldKeyNote: String? {
        guard case let .present(oldKeyCount)? = keyPanel else { return nil }
        switch oldKeyCount {
        case let .loaded(n): return n > 0 ? Self.oldKeyText(n) : nil
        case .failed: return SettingsWebText.oldKeyCountFailed
        }
    }

    /// [S2] approvalReadFailed when the forwarding confirmation could not be read (told apart from "none");
    /// nil when it was read (whether or not there is one).
    var approvalNote: String? {
        confirmationFailed ? SettingsWebText.approvalReadFailed : nil
    }
}
