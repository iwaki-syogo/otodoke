import Foundation
import Observation

/// One signed-in generation's choice. Consent gates the forwarding address and AI reading only;
/// manual parcels and the stored sample do not depend on it.
@MainActor
@Observable
final class AIReadingConsentModel {
    /// Last successfully confirmed server decision. nil means no decision has been read successfully.
    private(set) var decision: AIReadingDecision?
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var message: String?
    private(set) var choiceGeneration = 0

    @ObservationIgnored var onAddressPermissionChange: (@MainActor (Bool) -> Void)? {
        didSet { onAddressPermissionChange?(mayShowAddress) }
    }

    @ObservationIgnored private let store: any AIReadingConsentStoring
    @ObservationIgnored private let session: any SessionStamping
    @ObservationIgnored private let stamp: SessionStamp?
    @ObservationIgnored private let loadFailureMessage: String
    @ObservationIgnored private let saveFailureMessage: String
    @ObservationIgnored private var retired = false
    @ObservationIgnored private var revision = 0
    @ObservationIgnored private var loadTicket: Int?
    @ObservationIgnored private var saveTicket: Int?
    @ObservationIgnored private var pendingGrant: AIReadingConsentSaveReceipt?
    @ObservationIgnored private var savedGrant: AIReadingConsentSaveReceipt?
    @ObservationIgnored private var authorizationWaiters: [CheckedContinuation<Void, Never>] = []
    private var addressConfirmed = false
    @ObservationIgnored private var publishedAddressPermission = false

    init(store: any AIReadingConsentStoring, session: any SessionStamping,
         loadFailureMessage: String, saveFailureMessage: String) {
        self.store = store
        self.session = session
        stamp = session.stamp()
        self.loadFailureMessage = loadFailureMessage
        self.saveFailureMessage = saveFailureMessage
    }

    var needsPrompt: Bool { isCurrent && decision == .notDetermined }

    /// Permission is separate from the last displayed value: a failed withdrawal must not reveal
    /// an address merely because the last successful read had said allowed.
    var mayShowAddress: Bool {
        isCurrent && addressConfirmed && decision == .allowed && !isLoading && !isSaving
    }

    private var isCurrent: Bool {
        !retired && stamp.map { session.isCurrent($0) } == true
    }

    var isActiveSession: Bool { isCurrent }

    /// Only an explicit, confirmed save creates this receipt; refreshes never do.
    func takeConfirmedGrantReceipt() -> AIReadingConsentSaveReceipt? {
        defer { pendingGrant = nil }
        guard isCurrent, decision == .allowed, !isSaving else { return nil }
        return pendingGrant
    }

    func mayReadAfterConsent(_ receipt: AIReadingConsentSaveReceipt) -> Bool {
        mayShowAddress && isCurrentGrant(receipt)
    }

    func isCurrentGrant(_ receipt: AIReadingConsentSaveReceipt) -> Bool {
        isCurrent && savedGrant == receipt && receipt.decision == .allowed && decision == .allowed && !isSaving
    }

    /// A pending explicit save may cross an ordinary foreground refresh. Wait for its answer
    /// instead of turning the temporary address lock into a permanently lost automatic start.
    func authorizeReadAfterConsent(_ receipt: AIReadingConsentSaveReceipt) async -> Bool {
        while isCurrent, savedGrant == receipt, decision == .allowed, !isSaving, isLoading {
            await withCheckedContinuation { authorizationWaiters.append($0) }
        }
        return !Task.isCancelled && mayReadAfterConsent(receipt)
    }

    private func wakeAuthorizationWaiters() {
        let waiting = authorizationWaiters
        authorizationWaiters.removeAll()
        waiting.forEach { $0.resume() }
    }

    func load() async {
        guard isCurrent, let stamp else { retire(); return }
        // A read begun during a save could observe the value before that save and resurrect it.
        guard !isSaving else { return }
        revision &+= 1
        let ticket = revision
        loadTicket = ticket
        isLoading = true
        message = nil
        addressConfirmed = false
        publishAddressPermission()

        let result = await store.load(for: stamp)
        guard isCurrent else { retire(); return }
        guard loadTicket == ticket, revision == ticket, !isSaving else { return }
        loadTicket = nil
        isLoading = false
        defer { wakeAuthorizationWaiters() }
        guard !Task.isCancelled else { publishAddressPermission(); return }
        switch result {
        case let .loaded(value):
            if decision != value { choiceGeneration &+= 1 }
            decision = value
            if value != .allowed { pendingGrant = nil; savedGrant = nil }
            addressConfirmed = value == .allowed
            message = nil
        case .failed:
            // Keep a prior value as history, but never grant address access from a failed refresh.
            message = loadFailureMessage
        }
        publishAddressPermission()
    }

    @discardableResult
    func choose(_ allowed: Bool) async -> Bool {
        guard isCurrent, let stamp else { retire(); return false }
        guard !isSaving else { return false }
        choiceGeneration &+= 1
        revision &+= 1
        let ticket = revision
        loadTicket = nil
        isLoading = false
        saveTicket = ticket
        pendingGrant = nil
        savedGrant = nil
        wakeAuthorizationWaiters()
        isSaving = true
        message = nil
        addressConfirmed = false
        publishAddressPermission()

        let result = await store.save(allowed, for: stamp)
        guard isCurrent else { retire(); return false }
        guard saveTicket == ticket, revision == ticket else { return false }
        saveTicket = nil
        isSaving = false
        guard !Task.isCancelled else { publishAddressPermission(); return false }
        let expected = allowed ? AIReadingDecision.allowed : .denied
        guard case let .loaded(receipt) = result, receipt.decision == expected, receipt.stamp == stamp else {
            message = saveFailureMessage
            publishAddressPermission()
            return false
        }
        decision = receipt.decision
        addressConfirmed = receipt.decision == .allowed
        if allowed { pendingGrant = receipt; savedGrant = receipt }
        message = nil
        publishAddressPermission()
        return true
    }

    /// Called before the old signed-in screens are released. Late requests can no longer publish.
    func retire() {
        retired = true
        choiceGeneration &+= 1
        revision &+= 1
        loadTicket = nil
        saveTicket = nil
        pendingGrant = nil
        savedGrant = nil
        wakeAuthorizationWaiters()
        isLoading = false
        isSaving = false
        decision = nil
        message = nil
        addressConfirmed = false
        publishAddressPermission()
    }

    private func publishAddressPermission() {
        let permission = mayShowAddress
        guard permission != publishedAddressPermission else { return }
        publishedAddressPermission = permission
        onAddressPermissionChange?(permission)
    }
}
