// What needs an answer now, drawn as cards inside the page it belongs to (never above the settings list, as on
// the Web, where the list shows badges only): the mail waiting to be read at the top of 「うまく届かないとき」
// (trouble/page.tsx) and the Gmail approval under the address of 「メールの転送」, where the guide's third step
// points to it.

import SwiftUI

struct SettingsStatusRows: View {
    let model: SettingsModel
    /// 「荷物を登録」 (shown while reading is stopped): opens the form of a parcel typed in by hand.
    let register: () -> Void
    @Environment(\.openURL) private var openURL

    /// The view of 「うまく届かないとき」; the approval card is drawn through `approvalSection` by 「メールの転送」.
    var body: some View {
        unreadSection
            // Leaving the page takes the red line of 「読み取る」 with it.
            .onDisappear { model.mailActions.clearReadNote() }
    }

    // MARK: unread, approval

    @ViewBuilder
    var unreadSection: some View {
        switch model.unread {
        case let .loaded(n)? where n > 0:
            VStack(alignment: .leading, spacing: 4) {
                SettingsParts.heading(model.unreadHeading ?? "")
                // Only the reasons that apply (trouble/page.tsx): stopped, then the limit, then a failure. When the
                // counts could not be read no reason is stated.
                if case let .loaded(reasons)? = model.unreadReasons {
                    if reasons.stopped > 0 {
                        reasonText(SettingsMailText.readStoppedReason)
                        registerButton
                    }
                    if reasons.overLimit > 0 { reasonText(SettingsMailText.readOverLimitReason) }
                    if reasons.failed > 0 { reasonText(SettingsMailText.readFailedReason) }
                }
                ReadWaitingButton(model: model.mailActions)
                    .padding(.top, 8)
                if let note = model.mailActions.readNote {
                    Text(note)
                        .font(.subheadline)
                        .foregroundStyle(OtodokeColor.errorText)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
        case .failed?:
            // iOS-9: not the look of 0 mails.
            SettingsParts.errorBox(model.unreadHeading ?? SettingsWebText.unreadCountFailed)
        case .loaded?:
            // trouble/page.tsx: nothing waiting is said, not left blank.
            SettingsParts.secondaryText(SettingsWebText.unreadNone)
        case nil:
            EmptyView()
        }
    }

    private func reasonText(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The Web's link to /app/parcels/new: here it opens the form in the app.
    private var registerButton: some View {
        Button {
            register()
        } label: {
            Text(SettingsMailText.readStoppedButton)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .frame(minHeight: 44)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
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
                // The Web's ApprovalFilterCopy: the sentence, then the filter text with its copy button (the same box as the Gmail card's).
                Text(GmailApprovalText.filterNote)
                    .font(.subheadline)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 16)
                GmailFilterBox()
                    .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
        } else if let note = model.approvalNote {
            // [S2] The forwarding confirmation could not be read (not the look of "none").
            SettingsParts.errorBox(note)
        }
    }
}
