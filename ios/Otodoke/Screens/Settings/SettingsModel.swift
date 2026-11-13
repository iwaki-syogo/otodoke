// The view model of SettingsView (src/app/app/settings/page.tsx, 2541793). Every read fails on its own
// and a failure is told apart from 0 or an empty list. The address is read (or made) only when a key
// row is in use; the approval link is only Google's page (CX4). Old reads are dropped through ReadFence.

import Foundation
import Observation

/// The full privacy policy is the only settings action that opens a Web page.
enum SettingsWebAction: CaseIterable, Equatable, Sendable {
    /// 「プライバシーポリシー」
    case privacy
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

    /// The full privacy policy's https page; account operations use native models and APIs.
    static func webLink(_ action: SettingsWebAction) -> URL {
        switch action {
        case .privacy: WebLink.privacy
        }
    }

    let reader: SettingsReader
    let readingConsent: AIReadingConsentModel
    private(set) var requestsReadingConsent = false

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
    private var readIntakeNotice: LoadResult<String?>?
    /// nil is loading; a failed read is never the absence of a notice or an empty sender list.
    var intakeNotice: LoadResult<String?>? { isCurrentMailIdentity() ? readIntakeNotice : nil }
    var rememberedSenders: LoadResult<[String]>? {
        guard isCurrentMailIdentity() else { return nil }
        switch dropped {
        case let .loaded(rows)?: return .loaded(RememberedSenderRule.domains(rows.filter { $0.flaggedAt != nil }.map(\.fromDomain)))
        case .failed?: return .failed
        case nil: return nil
        }
    }
    private(set) var isSigningOut = false

    @ObservationIgnored private let inbox: InboxAddressService
    @ObservationIgnored private let auth: AuthService
    @ObservationIgnored private let generation: SessionStamp?
    @ObservationIgnored private let tokenReader: SessionAccessTokenReader
    @ObservationIgnored private let inboundDomain: String
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let mark: ChangeMark
    @ObservationIgnored private let isCurrentMailIdentity: @MainActor () -> Bool
    @ObservationIgnored private var fence = ReadFence()
    /// A read was started at least once (onAppear reads the first time only when none was).
    @ObservationIgnored private var hasRead = false
    /// Reads running now (load() adds one while it runs).
    @ObservationIgnored private var loadsRunning = 0
    /// How many full reads have begun (the auto refresh drops its answers when this moved).
    @ObservationIgnored private var loadsStarted = 0
    /// [CX-f2] The newest read's: raised as soon as its task is cancelled, before the read ends.
    @ObservationIgnored private var cutOff: CutOffSignal?
    @ObservationIgnored private var retired = false
    @ObservationIgnored private var addressEpoch = 0
    #if DEBUG
    /// Read-only view of how many full reads have begun.
    var debugLoadsStarted: Int { loadsStarted }
    @ObservationIgnored var debugConsentFixture = false
    @ObservationIgnored var debugConsentSaveCount: (@MainActor () -> Int)?
    @ObservationIgnored var debugFirstKeyCreated = false
    @ObservationIgnored var debugConsentIsHoldingLoad: (@MainActor () -> Bool)?
    @ObservationIgnored var debugConsentFinishLoad: (@MainActor () -> Void)?
    @ObservationIgnored var debugConsentAutoReadCount: (@MainActor () -> Int)?
    @ObservationIgnored var debugConsentManualReadCount: (@MainActor () -> Int)?
    @ObservationIgnored var debugConsentCompleteAuto: (@MainActor () -> Void)?
    @ObservationIgnored var debugConsentUnreadCount = 2
    @ObservationIgnored var debugConsentUnreadReasons = UnreadReasons(stopped: 0, overLimit: 0, failed: 2)
    #endif

    init(
        consent: AIReadingConsentModel? = nil,
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
        generation = auth.session.stamp()
        tokenReader = SessionAccessTokenReader(provider: auth.provider, isCurrent: { [weak auth] stamp in auth?.session.isCurrent(stamp) == true })
        self.inboundDomain = inboundDomain
        self.mark = ChangeMark(changes)
        self.now = now
        let stamp = generation
        isCurrentMailIdentity = { [weak auth] in
            guard let auth, let stamp else { return false }
            return auth.session.isCurrent(stamp)
                && auth.provider.auth.currentSession?.user.id.uuidString.lowercased() == stamp.userID
        }
        readingConsent = consent ?? Self.liveReadingConsent(auth: auth)
        readingConsent.onAddressPermissionChange = { [weak self] allowed in self?.addressPermissionChanged(allowed) }
    }

    static func liveReadingConsent(auth: AuthService) -> AIReadingConsentModel {
        AIReadingConsentModel(
            store: AIReadingConsentClient(provider: auth.provider, isCurrent: { [weak auth] stamp in auth?.session.isCurrent(stamp) == true }),
            session: auth.session, loadFailureMessage: AIReadingConsentText.readFailed, saveFailureMessage: AIReadingConsentText.saveFailed
        )
    }

    /// The app's model: the signed-in session's provider, the device clock.
    static func live(auth: AuthService, changes: DataChanges?, consent: AIReadingConsentModel? = nil) -> SettingsModel {
        let model = SettingsModel(
            consent: consent,
            reader: SettingsReader(provider: auth.provider),
            inbox: InboxAddressService(provider: auth.provider),
            auth: auth,
            inboundDomain: auth.provider.config.inboundDomain,
            changes: changes,
            now: { Date() }
        )
        let provider = auth.provider
        let tokens = model.tokenReader, stamp = model.generation
        model.demo = DemoModel(
            api: DemoAPIClient(session: provider.urlSession),
            isCurrent: { [weak auth] in guard let auth, let stamp else { return false }; return auth.session.isCurrent(stamp) },
            accessToken: { await tokens.read(for: stamp) },
            changed: { ParcelWriter.announceOutsideChange(changes) }
        )
        return model
    }

    var mayShowReadingAddress: Bool { !requestsReadingConsent && readingConsent.mayShowAddress }

    private func addressPermissionChanged(_ allowed: Bool) {
        addressEpoch &+= 1
        if !allowed { clearReadingAddress() }
    }

    private func clearReadingAddress() {
        address = nil; confirmURL = nil; confirmationFailed = false
        approvalWaiting = false; approvalBadgeFailed = false; lastApprovalRead = nil
    }

    func requestReadingConsent() {
        guard !retired else { return }
        requestsReadingConsent = true
        addressEpoch &+= 1
        clearReadingAddress()
    }

    func dismissReadingConsent() { requestsReadingConsent = false }

    @discardableResult
    func chooseReadingConsent(_ allowed: Bool) async -> Bool {
        let saved = await readingConsent.choose(allowed)
        if saved { await readingConsentChoiceSaved() }
        return saved
    }

    func readingConsentChoiceSaved() async {
        guard !retired else { return }
        requestsReadingConsent = false
        if let receipt = readingConsent.takeConfirmedGrantReceipt() {
            mailActions.startReadingAfterConsent(receipt)
        }
        await loadSettings()
    }

    /// The first guide shares the consent read already completed by the tabs.
    func loadForwardingGuide() async { await loadSettings() }

    /// 「サンプルで試す」 (set by live()): the sample load and clear-everything, through the Web's endpoints.
    @ObservationIgnored var demo: DemoModel?

    /// The 「この端末で Face ID を使う」 switch (set by MainScreens).
    @ObservationIgnored var faceID: FaceIDSwitch?
    /// The key step after the sign-in (set by MainScreens): its failure shows on the card without a key (S3).
    @ObservationIgnored var keySetup: KeySetup?

    /// 「これは荷物」 and 「読み取る」, done in the app through the Web's mail endpoints (MailActionsModel). Made on first use
    /// with the signed-in session; a test sets its own.
    @ObservationIgnored lazy var mailActions: MailActionsModel = makeMailActions()

    @MainActor private func makeMailActions() -> MailActionsModel {
        let auth = self.auth
        let provider = auth.provider
        let tokens = tokenReader
        let stamp = generation
        return MailActionsModel(
            api: MailActionsClient(session: provider.urlSession),
            accessToken: { await tokens.read(for: stamp) },
            reload: { [weak self] in await self?.load() },
            announceChange: { [changes = mark.changes] in ParcelWriter.announceOutsideChange(changes) },
            mayRead: { [weak self] in self?.mayShowReadingAddress == true },
            requestReadingConsent: { [weak self] in self?.requestReadingConsent() },
            isCurrent: { [weak self] in self?.readingConsent.isActiveSession == true },
            authorizeAfterConsent: { [weak self] receipt in await self?.readingConsent.authorizeReadAfterConsent(receipt) == true },
            isCurrentGrant: { [weak self] receipt in self?.readingConsent.isCurrentGrant(receipt) == true },
            permissionGeneration: { [weak self] in self?.readingConsent.choiceGeneration ?? -1 }
        )
    }

    /// The person who created this settings model owns both the displayed data and these writes.
    @ObservationIgnored lazy var mailRecovery: SettingsMailRecoveryModel = makeMailRecovery()

    @MainActor private func makeMailRecovery() -> SettingsMailRecoveryModel {
        let auth = self.auth
        let provider = auth.provider
        let tokens = tokenReader
        let stamp = generation
        return SettingsMailRecoveryModel(
            api: SettingsMailActionsClient(session: provider.urlSession),
            accessToken: { [weak self] in
                guard let self, self.isCurrentMailIdentity() else { return nil }
                let token = await tokens.read(for: stamp)
                guard self.isCurrentMailIdentity() else { return nil }
                return token
            },
            isCurrent: { [weak self, weak auth] in
                guard let self, let auth, let stamp else { return false }
                return !self.retired && self.isCurrentMailIdentity() && auth.session.isCurrent(stamp)
            },
            reload: { [weak self] in await self?.load() },
            beginWrite: { [weak self] in self?.fence.beginWrite() },
            endWrite: { [weak self] in self?.fence.endWrite() }
        )
    }

    @ObservationIgnored lazy var accountDeletion: AccountDeletionModel = makeAccountDeletion()

    @MainActor private func makeAccountDeletion() -> AccountDeletionModel {
        let auth = self.auth
        let provider = auth.provider
        let tokens = tokenReader
        let stamp = generation
        return AccountDeletionModel(
            api: AccountAPIClient(session: provider.urlSession),
            accessToken: { await tokens.read(for: stamp) },
            isCurrent: { [weak auth] in
                guard let auth, let stamp, auth.session.isCurrent(stamp) else { return false }
                // A missing SDK session after a confirmed POST still needs the existing local cleanup.
                guard let session = provider.auth.currentSession else { return true }
                return session.user.id.uuidString.lowercased() == stamp.userID
            },
            completed: { [weak auth] in await auth?.signOut() }
        )
    }

    @ObservationIgnored lazy var passwordChange: PasswordChangeModel = makePasswordChange()

    @MainActor private func makePasswordChange() -> PasswordChangeModel {
        let auth = self.auth
        let provider = auth.provider
        let tokens = tokenReader
        let stamp = generation
        return PasswordChangeModel(
            keys: MailKeyReader(provider: provider), api: PasswordAccountClient(session: provider.urlSession), deriver: auth.deriver,
            identity: { [weak auth] in
                guard let auth, case let .signedIn(id) = auth.state, let email = auth.signedInEmail else { return nil }
                return (id, email)
            },
            isCurrent: { [weak auth] in guard let auth, let stamp else { return false }; return auth.session.isCurrent(stamp) },
            accessToken: { await tokens.read(for: stamp) }, signOut: { [weak auth] in await auth?.signOut() }
        )
    }

    func clearForSignOut() {
        retired = true
        readingConsent.retire()
        requestsReadingConsent = false
        _ = fence.beginRead()
        loadsStarted += 1
        cutOff?.raise()
        keyPanel = nil; address = nil; confirmURL = nil; unread = nil; unreadReasons = nil; dropped = nil
        readIntakeNotice = nil
        confirmationFailed = false; approvalWaiting = false; approvalBadgeFailed = false
        lastApprovalRead = nil
        passwordChange.clearPasswords()
        mailActions.retire()
        mailRecovery.retire()
    }

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
        guard mayShowReadingAddress else { return false }
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
        guard !retired else { return }
        await readingConsent.load()
        await loadSettings()
    }

    private func loadSettings() async {
        guard !retired else { return }
        #if DEBUG
        if debugConsentFixture {
            hasRead = true
            keyPanel = .present(oldKeyCount: .loaded(0))
            unread = .loaded(debugConsentUnreadCount); dropped = .loaded([])
            unreadReasons = .loaded(debugConsentUnreadReasons)
            readIntakeNotice = .loaded(nil)
            if mayShowReadingAddress {
                address = .loaded("inbox@\(inboundDomain)")
                confirmURL = URL(string: "https://mail-settings.google.com/mail/vf-preview")
                approvalWaiting = true
            } else {
                clearReadingAddress()
            }
            return
        }
        #endif
        hasRead = true
        loadsStarted += 1
        loadsRunning += 1
        defer { loadsRunning -= 1 }
        mark.markRead()
        let ticket = fence.beginRead()
        let signal = CutOffSignal()
        cutOff = signal
        let reader = self.reader
        guard isCurrentMailIdentity() else {
            readIntakeNotice = nil
            // Same generation but the signed-in person cannot be confirmed (stored session unreadable):
            // show a failure and let the next appearance or pull read again. A moved generation shows nothing.
            if let stamp = generation, auth.session.isCurrent(stamp) {
                keyPanel = .failed
                hasRead = false
            }
            return
        }
        readIntakeNotice = nil
        let at = now()
        let epoch = addressEpoch

        let (panel, readAddress, readConfirmation, readLater, readWaiting, readDropped, readReasons, intake) = await withTaskCancellationHandler {
            await readAll(reader, at: at, epoch: epoch)
        } onCancel: {
            signal.raise()
        }

        // [N-new2] A newer read began: it owns the state (this one being cut off changes nothing).
        guard !retired, fence.verdict(ticket) == .current else { return }
        guard isCurrentMailIdentity() else { return }
        // [S1] Cut off (the .task cancelled when the tab is left): the answers are dropped, not shown
        // as failures, and the next appearance reads again.
        guard !Task.isCancelled else {
            hasRead = false
            return
        }
        keyPanel = panel
        if mayShowReadingAddress, epoch == addressEpoch {
            address = readAddress
            if let readConfirmation { applyApproval(readConfirmation, later: readLater) }
        } else {
            clearReadingAddress()
        }
        unread = readWaiting
        unreadReasons = readReasons
        dropped = readDropped
        readIntakeNotice = intake
        if mayShowReadingAddress { lastApprovalRead = at }
    }

    /// The reads of load(): each fails on its own.
    private func readAll(_ reader: SettingsReader, at: Date, epoch: Int) async -> (
        KeyPanel, LoadResult<String>?, LoadResult<[ForwardingConfirmationRow]>?, LoadResult<Int>?, LoadResult<Int>, LoadResult<[DroppedMailRow]>,
        LoadResult<UnreadReasons>?, LoadResult<String?>
    ) {
        async let key = reader.currentKey()
        async let confirmation = readConfirmationIfAllowed(reader, epoch: epoch)
        async let waiting = reader.unreadCount(now: at)
        async let droppedRows = reader.dropped()
        async let intake = reader.intakeNotice()

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
            readAddress = await readAddressOfKey(epoch: epoch)
            panel = .present(oldKeyCount: await old)
        }
        // What arrived after the confirmation the card shows (the badge's time rule).
        let confirmationRows = await confirmation
        var later: LoadResult<Int>?
        if mayShowReadingAddress, epoch == addressEpoch, let pick = confirmationRows?.value.flatMap(Self.pickApproval), let at = pick.at {
            later = await reader.arrivedAfter(at)
        }
        let waitingResult = await waiting
        // The reasons are read only when a count was read and some mail waits (the Web's trouble page).
        var reasons: LoadResult<UnreadReasons>?
        if case let .loaded(n) = waitingResult, n > 0 { reasons = await reader.unreadReasons(now: at) }
        return (panel, readAddress, confirmationRows, later, waitingResult, await droppedRows, reasons, await intake)
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
        guard mayShowReadingAddress else { return false }
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
        guard !retired, pollsForApproval, loadsRunning == 0 else { return }
        let started = loadsStarted
        let epoch = addressEpoch
        let confirmation = await reader.forwardingConfirmations()
        var later: LoadResult<Int>?
        if !Task.isCancelled, let at = confirmation.value.flatMap(Self.pickApproval)?.at {
            later = await reader.arrivedAfter(at)
        }
        guard !retired, !Task.isCancelled, started == loadsStarted, loadsRunning == 0, pollsForApproval, epoch == addressEpoch else { return }
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
    private func readAddressOfKey(epoch: Int) async -> LoadResult<String>? {
        guard mayShowReadingAddress, epoch == addressEpoch else { return nil }
        do {
            let local = try await inbox.ensure()
            guard mayShowReadingAddress, epoch == addressEpoch else { return nil }
            return .loaded(InboxAddressService.email(localPart: local, domain: inboundDomain) ?? SettingsWebText.noInboundDomain)
        } catch {
            return .failed
        }
    }

    /// The address can be copied (an inbound domain is set).
    var addressCanBeCopied: Bool {
        guard mayShowReadingAddress else { return false }
        guard case let .loaded(text)? = address else { return false }
        return !inboundDomain.isEmpty && text.hasSuffix("@\(inboundDomain)")
    }

    private func readConfirmationIfAllowed(_ reader: SettingsReader, epoch: Int) async -> LoadResult<[ForwardingConfirmationRow]>? {
        guard mayShowReadingAddress, epoch == addressEpoch else { return nil }
        return await reader.forwardingConfirmations()
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
