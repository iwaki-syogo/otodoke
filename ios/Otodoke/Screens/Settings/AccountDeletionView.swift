import Observation
import SwiftUI

/// Words copied from the Web's account-deletion.tsx and account-deletion.ts.
enum AccountDeletionText {
    static let open = "アカウントを削除"
    static let confirm = "アカウントを削除しますか？"
    static let consequence = "Otodoke の荷物、Otodoke に保存したメール、転送先アドレスを、アカウントごと消します。お使いのメールの受信箱は、そのままです。元に戻せません。"
    static let forwarding = "Gmail などで設定した自動転送も外してください。"
    static let deleting = "削除しています…"
    static let delete = "削除する"
    static let cancel = "やめる"
    static let failed = "削除できませんでした。少し時間をおいて、もう一度お試しください。"
}

@MainActor
@Observable
final class AccountDeletionModel {
    private(set) var confirming = false
    private(set) var isDeleting = false
    private(set) var message: String?
    @ObservationIgnored private let api: any AccountDeleting
    @ObservationIgnored private let accessToken: @MainActor () async -> String?
    @ObservationIgnored private let isCurrent: @MainActor () -> Bool
    @ObservationIgnored private let completed: @MainActor () async -> Void

    init(api: any AccountDeleting, accessToken: @escaping @MainActor () async -> String?, isCurrent: @escaping @MainActor () -> Bool = { true }, completed: @escaping @MainActor () async -> Void) {
        self.api = api
        self.accessToken = accessToken
        self.isCurrent = isCurrent
        self.completed = completed
    }

    func showConfirmation() { guard !isDeleting else { return }; message = nil; confirming = true }
    func cancel() { guard !isDeleting else { return }; message = nil; confirming = false }

    func deleteAccount() async {
        guard confirming, !isDeleting, isCurrent() else { return }
        isDeleting = true
        message = nil
        defer { isDeleting = false }
        guard let token = await accessToken(), isCurrent() else { message = LoginText.signedOut; return }
        do {
            try await api.deleteAccount(accessToken: token)
            // A different account signed in meanwhile must not be signed out by this result.
            guard isCurrent() else { return }
            await completed()
        } catch {
            guard isCurrent() else { return }
            message = error == .unauthorized ? LoginText.signedOut : AccountDeletionText.failed
        }
    }
}

struct AccountDeletionView: View {
    let model: AccountDeletionModel
    let email: String?

    var body: some View {
        SettingsParts.page {
            if let email { SettingsParts.secondaryText(email) }
            if model.confirming {
                VStack(alignment: .leading, spacing: 12) {
                    SettingsParts.heading(AccountDeletionText.confirm)
                    SettingsParts.secondaryText(AccountDeletionText.consequence)
                    SettingsParts.secondaryText(AccountDeletionText.forwarding)
                    Button(role: .destructive) { Task { await model.deleteAccount() } } label: {
                        HStack {
                            if model.isDeleting { ProgressView() }
                            Text(model.isDeleting ? AccountDeletionText.deleting : AccountDeletionText.delete)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .disabled(model.isDeleting)
                    .accessibilityIdentifier("account-delete-confirm")
                    Button(AccountDeletionText.cancel) { model.cancel() }
                        .disabled(model.isDeleting)
                    if let message = model.message { SettingsParts.errorBox(message) }
                }
                .padding(16)
                .background(Palette.errorBackground, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.errorBorder))
            } else {
                Button(AccountDeletionText.open, role: .destructive) { model.showConfirmation() }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("account-delete-open")
            }
        }
        .navigationTitle(SettingsWebText.deleteTitle)
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(model.isDeleting)
    }
}
