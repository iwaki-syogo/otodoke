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
                SettingsParts.errorBox(SettingsModel.failedText)
            }
        case let .none(plainCount)?:
            VStack(alignment: .leading, spacing: 8) {
                SettingsParts.heading(SettingsWebText.makeKeyHeading)
                Text(SettingsWebText.makeKeyLead)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                if case let .loaded(n) = plainCount, n > 0 {
                    Text(verbatim: SettingsWebText.plainMailNote(n))
                        .font(.subheadline.bold())
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.amberBorder))
                }
                if case .failed = plainCount {
                    SettingsParts.errorBox(SettingsModel.plainCountFailedText)
                }
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
        case let .present(plainCount, _)?:
            VStack(alignment: .leading, spacing: 12) {
                SettingsParts.heading("パスワード")
                switch plainCount {
                case let .loaded(n) where n > 0:
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: "暗号化されていないメールが \(n) 通あります")
                            .font(.subheadline.bold())
                        Text("暗号化を始める前に読み取ったメールなどです。押すまでは、運営者が読める形で残ります。")
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        SettingsParts.primaryButton("暗号化する") { SettingsWeb.openPage(WebLink.settings, openURL) }
                            .padding(.top, 8)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
                case .failed:
                    SettingsParts.errorBox(SettingsModel.plainCountFailedText)
                default:
                    EmptyView()
                }
                if let note = model.oldKeyNote {
                    // [S2] A failed count shows failedText (not the look of 0).
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(note == SettingsModel.failedText ? OtodokeColor.errorText : Color.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                SettingsParts.linkCard("パスワードを変える") { SettingsWeb.open(.changePassphrase, openURL) }
                FaceIDToggleRow(model: model)
            }
        }
    }
}
