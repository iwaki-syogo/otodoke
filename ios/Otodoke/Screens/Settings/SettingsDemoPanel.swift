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
        .accessibilityIdentifier("demo-load")
    }

    private var clearBox: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(DemoText.clearWarning)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                confirmed.toggle()
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: confirmed ? "checkmark.square.fill" : "square")
                        .font(.body)
                        .foregroundStyle(confirmed ? Color.primary : Color.secondary)
                    Text(DemoText.clearCheck)
                        .foregroundStyle(.primary)
                    Spacer(minLength: 0)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(confirmed ? .isSelected : [])
            .accessibilityIdentifier("demo-clear-check")
            Button {
                let sure = confirmed
                Task {
                    if await model.clear(confirmed: sure) { confirmed = false }
                }
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
            .accessibilityIdentifier("demo-clear")
        }
    }
}
