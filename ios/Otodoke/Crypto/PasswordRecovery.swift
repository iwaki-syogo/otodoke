import Foundation
import Observation
import SwiftUI

/// The Web's openWithAnother flow, with a fresh password sign-in before the same rewrap API.
@MainActor
@Observable
final class PasswordRecoveryModel {
    var current = ""
    var other = ""
    private(set) var isWorking = false
    private(set) var message: String?
    private(set) var opened = false
    let turnstile = TurnstileToken()
    @ObservationIgnored private let keys: any MailKeyReading
    @ObservationIgnored private let api: any PasswordAccountAPI
    @ObservationIgnored private let deriver: PasswordV1Deriver
    @ObservationIgnored private let identity: @MainActor () -> (id: String, email: String)?
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let authenticate: @MainActor (String, String?) async throws(LoginFailure) -> String
    @ObservationIgnored private let complete: @MainActor (String) async -> Bool
    @ObservationIgnored private var operation = 0

    init(keys: any MailKeyReading, api: any PasswordAccountAPI, deriver: PasswordV1Deriver, identity: @escaping @MainActor () -> (id: String, email: String)?, isCurrent: @escaping @MainActor () -> Bool, authenticate: @escaping @MainActor (String, String?) async throws(LoginFailure) -> String, complete: @escaping @MainActor (String) async -> Bool) {
        self.keys = keys; self.api = api; self.deriver = deriver; self.identity = identity; self.isCurrent = isCurrent; self.authenticate = authenticate; self.complete = complete
    }

    func clearPasswords() { current = ""; other = "" }

    func cancel() {
        operation += 1
        isWorking = false; opened = false; message = nil
        clearPasswords(); turnstile.reset()
    }

    private func mayContinue(_ attempt: Int) -> Bool {
        operation == attempt && !Task.isCancelled && isCurrent()
    }

    func submit() async {
        guard !Task.isCancelled, !isWorking, !current.isEmpty, !other.isEmpty, isCurrent(), let who = identity() else { return }
        operation += 1
        let attempt = operation
        isWorking = true; message = nil; opened = false
        defer {
            if operation == attempt { isWorking = false; clearPasswords(); turnstile.reset() }
        }
        let typed = current, previous = other
        do {
            var loginMaster = try await deriver.master(password: typed, email: who.email)
            defer { loginMaster.resetBytes(in: 0..<loginMaster.count) }
            var otherMaster = try await deriver.master(password: previous, email: who.email)
            defer { otherMaster.resetBytes(in: 0..<otherMaster.count) }
            guard mayContinue(attempt) else { return }
            _ = await turnstile.waitUntilSettled(timeout: Turnstile.waitForToken)
            guard mayContinue(attempt) else { return }
            let token = try await authenticate(PasswordV1.authSecret(master: loginMaster), turnstile.take())
            guard mayContinue(attempt), identity()?.id == who.id else { return }
            let read = await keys.currentKey()
            guard mayContinue(attempt) else { return }
            guard case let .loaded(stored?) = read else { message = LoginText.keyFailed; return }
            // Another device may have repaired the wrap already: opening is enough then.
            if (try? PasswordV1.openStoredKey(stored, master: loginMaster, userID: who.id)) == nil {
                guard (try? PasswordV1.openStoredKey(stored, master: otherMaster, userID: who.id)) != nil else { message = PasswordChangeText.otherWrong; return }
                let rewrap = try PasswordRewrapping.make(stored: stored, opener: otherMaster, next: loginMaster, userID: who.id)
                guard mayContinue(attempt) else { return }
                if let code = await api.rewrap(rewrap, accessToken: token) {
                    guard mayContinue(attempt) else { return }
                    message = PasswordChangeText.message(code); return
                }
            }
            guard mayContinue(attempt) else { return }
            let completed = await complete(typed)
            guard mayContinue(attempt) else { return }
            opened = completed
            if !opened { message = LoginText.keyFailed }
        } catch let failure as LoginFailure {
            if mayContinue(attempt) { message = failure.message }
        } catch { if mayContinue(attempt) { message = LoginText.keyFailed } }
    }
}

struct PasswordRecoveryView: View {
    @Bindable var model: PasswordRecoveryModel
    var onOpened: () -> Void = {}
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var submission: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            SettingsParts.page(spacing: 12) {
                SecureField(PasswordChangeText.current, text: $model.current).textContentType(.password)
                SecureField(PasswordChangeText.otherPassword, text: $model.other).textContentType(.password)
                TurnstileView(token: model.turnstile)
                Button(PasswordChangeText.openAnother) {
                    guard submission == nil else { return }
                    submission = Task {
                        await model.submit()
                        guard !Task.isCancelled else { return }
                        submission = nil
                        if model.opened { dismiss(); onOpened() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isWorking || model.current.isEmpty || model.other.isEmpty)
                if model.isWorking { ProgressView() }
                if let message = model.message { SettingsParts.errorBox(message) }
            }
            .autocorrectionDisabled()
            .textInputAutocapitalization(.never)
            .navigationTitle(PasswordChangeText.openAnother)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(AccountDeletionText.cancel) { cancelSubmission(); dismiss() } } }
        }
        .onChange(of: scenePhase) { _, phase in if phase == .background { cancelSubmission() } }
        .onDisappear { cancelSubmission() }
    }

    private func cancelSubmission() {
        submission?.cancel(); submission = nil
        model.cancel()
    }
}
