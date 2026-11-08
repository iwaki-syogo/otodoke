// The square check 「本当に消す」: the Web's checkbox, shared by 「すべての荷物を消す」 and a typed-in parcel's delete.

import SwiftUI

struct ConfirmCheck: View {
    let title: String
    @Binding var isOn: Bool
    let identifier: String

    var body: some View {
        Button {
            isOn.toggle()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.body)
                    .foregroundStyle(isOn ? Color.primary : Color.secondary)
                Text(title)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(isOn ? "オン" : "オフ")
        .accessibilityIdentifier(identifier)
    }
}
