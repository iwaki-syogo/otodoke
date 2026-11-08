// 「パスワードとメールの鍵」: the passphrase card in its three states (no read / no key / a key in use) and
// the Face ID row under it. The same cards, buttons and words as the long screen had.

import SwiftUI

struct SettingsKeyPage: View {
    let model: SettingsModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        SettingsParts.page {
            keyPanel
        }
        .refreshableToTheEnd { await model.load() }
        .task { await model.pageShown() }
        .navigationTitle(SettingsMenuText.keyTitle)
        .navigationBarTitleDisplayMode(.inline)
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
                Text(SettingsWebText.makeKeyLead)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                if let failure = model.keyStepFailure {
                    // S3: the key step after the sign-in did not make the key.
                    SettingsParts.errorBox(failure.message)
                    if failure.signInAgain {
                        Button {
                            Task { await model.signOut() }
                        } label: {
                            Text(LoginText.signInAgain).font(.subheadline.weight(.medium))
                        }
                    }
                }
                SettingsParts.primaryButton("鍵を作る") { SettingsWeb.open(.createPassphrase, openURL) }
                    .padding(.top, 4)
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
                SettingsParts.linkCard("パスワードを変える") { SettingsWeb.open(.changePassphrase, openURL) }
                FaceIDToggleRow(model: model)
            }
        }
    }
}
