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
        guard !Task.isCancelled else { publishAddressPermission(); return }
        switch result {
        case let .loaded(value):
            decision = value
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
        revision &+= 1
        let ticket = revision
        loadTicket = nil
        isLoading = false
        saveTicket = ticket
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
        guard case let .loaded(value) = result, value == expected else {
            message = saveFailureMessage
            publishAddressPermission()
            return false
        }
        decision = value
        addressConfirmed = value == .allowed
        message = nil
        publishAddressPermission()
        return true
    }

    /// Called before the old signed-in screens are released. Late requests can no longer publish.
    func retire() {
        retired = true
        revision &+= 1
        loadTicket = nil
        saveTicket = nil
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
