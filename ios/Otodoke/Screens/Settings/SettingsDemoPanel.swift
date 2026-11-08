// The body of 「サンプルで試す」: the load button, what the last action said, and the box that clears everything.
// The buttons stay pressable while one action runs (they show a spinner at the pressed one); the model sends once.

import SwiftUI

struct SettingsDemoPanel: View {
    let model: DemoModel
    @State private var showsClear: Bool
    @State private var confirmed = false

    init(model: DemoModel, clearOpen: Bool = false) {
        self.model = model
        _showsClear = State(initialValue: clearOpen)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            loadButton
            if let partial = model.notice.partial {
                Text(partial).font(.subheadline)
            }
            if let cleared = model.notice.cleared {
                Text(cleared)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let error = model.notice.error {
                SettingsParts.errorBox(error)
            }
            SettingsDisclosure(title: DemoText.clearSummary, isExpanded: $showsClear) {
                clearBox
            }
        }
        // What the last action said is read out when it appears or changes.
        .onChange(of: model.notice) { _, notice in
            let words = [notice.error, notice.partial, notice.cleared].compactMap { $0 }
            guard !words.isEmpty else { return }
            AccessibilityNotification.Announcement(words.joined(separator: " ")).post()
        }
    }

    private var loadButton: some View {
        Button {
            Task { await model.load() }
        } label: {
            ZStack {
                if model.phase == .loading {
                    HStack(spacing: 8) {
                        ProgressView().tint(Color(.systemBackground))
                        Text(DemoText.loadBusy)
                    }
                } else {
                    Text(DemoText.loadLabel)
                }
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color(.systemBackground))
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(Color.primary, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityValue(model.phase == .loading ? DemoText.loadBusy : "")
        .accessibilityIdentifier("demo-load")
    }

    private var clearBox: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(DemoText.clearWarning)
                .fixedSize(horizontal: false, vertical: true)
            ConfirmCheck(title: DemoText.clearCheck, isOn: $confirmed, identifier: "demo-clear-check")
            Button {
                let sure = confirmed
                // The check is let go once it was sent, whatever came back.
                confirmed = false
                Task { _ = await model.clear(confirmed: sure) }
            } label: {
                HStack(spacing: 8) {
                    if model.phase == .clearing {
                        ProgressView()
                        Text(DemoText.clearBusy)
                    } else {
                        Text(DemoText.clearButton)
                    }
                }
                .font(.subheadline)
                .foregroundStyle(OtodokeColor.errorText)
                .padding(.horizontal, 16)
                .frame(minHeight: 44)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.errorBorder))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(model.phase == .clearing ? DemoText.clearBusy : "")
            .accessibilityIdentifier("demo-clear")
        }
    }
}
