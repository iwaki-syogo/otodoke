// What needs an answer now, drawn as cards at the top of the settings list: the mail waiting to be read and
// the Gmail approval (the same cards, buttons and words as before). The approval card is also drawn at the
// top of 「メールの転送」, where the guide's third step points to it.

import SwiftUI

struct SettingsStatusRows: View {
    let model: SettingsModel
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            unreadSection
            approvalSection
        }
    }

    // MARK: unread, approval

    @ViewBuilder
    var unreadSection: some View {
        switch model.unread {
        case let .loaded(n)? where n > 0:
            VStack(alignment: .leading, spacing: 4) {
                SettingsParts.heading(model.unreadHeading ?? "")
                Text("1 日の上限を超えたか、読み取りに失敗したメールです。保存してあるので、もう一度読み取れます。")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                SettingsParts.primaryButton("読み取る") { SettingsWeb.open(.readWaiting, openURL) }
                    .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
        case .failed?:
            // iOS-9: not the look of 0 mails.
            SettingsParts.errorBox(model.unreadHeading ?? SettingsModel.failedText)
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    var approvalSection: some View {
        if let url = model.confirmURL, SettingsModel.isApprovalPage(url) {
            VStack(alignment: .leading, spacing: 4) {
                SettingsParts.heading("Gmail の転送を承認してください")
                Text("Gmail から転送の確認が届いています。承認済みなら、この案内は無視して大丈夫です。")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                SettingsParts.primaryButton("承認ページを開く") {
                    // [M1] Checked again right before it opens: only Google's page, by Foundation's reading.
                    guard SettingsModel.isApprovalPage(url) else { return }
                    SettingsWeb.openPage(url, openURL)
                }
                .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
        } else if let note = model.approvalNote {
            // [S2] The forwarding confirmation could not be read (not the look of "none").
            Text(note)
                .font(.subheadline)
                .foregroundStyle(OtodokeColor.errorText)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}
