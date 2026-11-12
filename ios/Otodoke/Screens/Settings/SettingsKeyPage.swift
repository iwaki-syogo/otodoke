// 「パスワードとメールの鍵」: the passphrase card in its three states (no read / no key / a key in use) and
// the Face ID row under it. The same cards, buttons and words as the long screen had.

import SwiftUI

struct SettingsKeyPage: View {
    let model: SettingsModel

    var body: some View {
        SettingsParts.page {
            keyPanel
        }
        .refreshableToTheEnd { await model.load() }
        .task { await model.pageShown() }
        .navigationTitle(SettingsMenuText.keyTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    /// The key step's failure says signing in again would not help (invalid_input, the address mismatch): no button.
    static func offersSignInAgain(_ model: SettingsModel) -> Bool {
        model.keyStepFailure?.signInAgain ?? true
    }

    @ViewBuilder
    private var keyPanel: some View {
        switch model.keyPanel {
        case .failed?, nil:
            VStack(alignment: .leading, spacing: 8) {
                SettingsParts.heading("パスワード")
                SettingsParts.errorBox(SettingsWebText.passwordKeyReadFailed)
            }
        case .none?:
            VStack(alignment: .leading, spacing: 8) {
                SettingsParts.heading(SettingsWebText.makeKeyHeading)
                Text(LoginText.noKeyYet)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                if let failure = model.keyStepFailure {
                    // S3: the key step after the sign-in did not make the key.
                    SettingsParts.errorBox(failure.message)
                }
                // 「ログインし直す」 as the unlock's: signs out, the login screen follows, and the next password
                // sign-in makes the key. Not offered when signing in again would not help (N-6, N4).
                if Self.offersSignInAgain(model) {
                    SettingsParts.primaryButton(LoginText.signInAgain) { Task { await model.signOut() } }
                        .accessibilityIdentifier("key-sign-in-again")
                        .padding(.top, 4)
                }
            }
            .padding(16)
            .background(SettingsPalette.skyBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(SettingsPalette.skyBorder))
        case .present?:
            VStack(alignment: .leading, spacing: 12) {
                SettingsParts.heading("パスワード")
                if let note = model.oldKeyNote {
                    // [S2] A failed count shows oldKeyCountFailed (not the look of 0).
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(note == SettingsWebText.oldKeyCountFailed ? OtodokeColor.errorText : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                NavigationLink {
                    PasswordChangeView(model: model.passwordChange)
                } label: {
                    SettingsRow(symbol: "key", title: "パスワードを変える", subtitle: nil, badge: nil, trailing: "chevron.right")
                }
                .buttonStyle(.plain)
                FaceIDToggleRow(model: model)
            }
        }
    }
}
