import Foundation
import Observation

@MainActor
@Observable
final class SettingsMailRecoveryModel {
    struct Note: Equatable, Sendable {
        let text: String
        let isError: Bool
    }

    private(set) var dismissing = false
    private(set) var forgettingDomain: String?
    private(set) var intakeNote: String?
    private(set) var senderNote: Note?
    var isWorking: Bool { dismissing || forgettingDomain != nil }
    func isForgetting(_ domain: String) -> Bool {
        forgettingDomain.map { JSText.equal($0, domain) } ?? false
    }

    @ObservationIgnored private let api: any SettingsMailActionsAPI
    @ObservationIgnored private let accessToken: @MainActor () async -> String?
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let reload: @MainActor () async -> Void
    @ObservationIgnored private let beginWrite: @MainActor () -> Void
    @ObservationIgnored private let endWrite: @MainActor () -> Void
    @ObservationIgnored private var retired = false
    @ObservationIgnored private var intakeEpoch = 0
    @ObservationIgnored private var senderEpoch = 0

    init(
        api: any SettingsMailActionsAPI,
        accessToken: @escaping @MainActor () async -> String?,
        isCurrent: @escaping @MainActor () -> Bool = { true },
        reload: @escaping @MainActor () async -> Void,
        beginWrite: @escaping @MainActor () -> Void = {},
        endWrite: @escaping @MainActor () -> Void = {}
    ) {
        self.api = api
        self.accessToken = accessToken
        self.isCurrent = isCurrent
        self.reload = reload
        self.beginWrite = beginWrite
        self.endWrite = endWrite
    }

    func dismissIntake(limitedAt: String) async {
        guard !retired, isCurrent(), !isWorking else { return }
        dismissing = true
        intakeNote = nil
        let epoch = intakeEpoch
        defer { dismissing = false }
        let failure = await perform { (token: String) async throws(SettingsMailAPIFailure) -> Void in
            try await self.api.dismissIntake(limitedAt: limitedAt, accessToken: token)
        }
        guard !retired, isCurrent() else { return }
        if epoch == intakeEpoch {
            switch failure {
            case .unknownResult, nil: intakeNote = nil
            case .unauthorized: intakeNote = LoginText.signedOut
            default: intakeNote = StorageIntakeText.failed
            }
        }
        // Success, failure and an uncertain result all read back; never locally clear the seen stamp.
        await reload()
    }

    func forgetSender(domain: String) async {
        guard !retired, isCurrent(), !isWorking else { return }
        forgettingDomain = domain
        senderNote = nil
        let epoch = senderEpoch
        defer { forgettingDomain = nil }
        let failure = await perform { (token: String) async throws(SettingsMailAPIFailure) -> Void in
            try await self.api.forgetSender(domain: domain, accessToken: token)
        }
        guard !retired, isCurrent() else { return }
        if epoch == senderEpoch {
            switch failure {
            case nil: senderNote = Note(text: RememberedSenderText.removed, isError: false)
            case .unknownResult: senderNote = nil
            case .unauthorized: senderNote = Note(text: LoginText.signedOut, isError: true)
            default: senderNote = Note(text: RememberedSenderText.failed, isError: true)
            }
        }
        await reload()
    }

    /// The read fence closes before reloading, so that read may publish its fresh answer.
    private func perform(_ operation: @MainActor (String) async throws(SettingsMailAPIFailure) -> Void) async -> SettingsMailAPIFailure? {
        beginWrite()
        defer { endWrite() }
        guard let token = await accessToken() else { return .unauthorized }
        guard !retired, isCurrent() else { return .unauthorized }
        do {
            try await operation(token)
            return nil
        } catch {
            return error
        }
    }

    func clearIntakeNote() { intakeEpoch &+= 1; intakeNote = nil }
    func clearSenderNote() { senderEpoch &+= 1; senderNote = nil }

    func retire() {
        retired = true
        clearIntakeNote()
        clearSenderNote()
    }
}
