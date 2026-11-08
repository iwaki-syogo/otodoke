// The two buttons that work inside the app: 「読み取る」 (the black button of the unread card) and
// 「これは荷物」 (the small outlined button of a dropped mail). While one works it shows a spinner and the
// Web's busy words from the press on. Never `disabled` (the Web's PressButton): it looks pressed, and the
// model ignores a second press.

import SwiftUI

/// 「読み取る」 of the unread card.
struct ReadWaitingButton: View {
    let model: MailActionsModel

    var body: some View {
        Button {
            Task { await model.readWaiting() }
        } label: {
            HStack(spacing: 8) {
                if model.isReading {
                    ProgressView().controlSize(.small).tint(Color(.systemBackground))
                }
                Text(model.isReading ? SettingsMailText.readBusy : SettingsMailText.readLabel)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color(.systemBackground))
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color.primary, in: RoundedRectangle(cornerRadius: 10))
            .opacity(model.isReading ? 0.6 : 1)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(model.isReading ? .updatesFrequently : [])
    }
}

/// 「これは荷物」 of one dropped mail.
struct MarkParcelButton: View {
    let model: MailActionsModel
    let id: String

    private var isWorking: Bool { model.markingID == id }

    var body: some View {
        Button {
            Task { await model.markAsParcel(id: id) }
        } label: {
            HStack(spacing: 6) {
                if isWorking {
                    ProgressView().controlSize(.mini)
                }
                Text(isWorking ? SettingsMailText.markBusy : SettingsMailText.markLabel)
            }
            .font(.caption.weight(.medium))
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .opacity(isWorking ? 0.6 : 1)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .accessibilityAddTraits(isWorking ? .updatesFrequently : [])
    }
}
