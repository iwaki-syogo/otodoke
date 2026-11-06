import SwiftUI

/// A short message at the bottom of a screen that goes by itself (the model removes it after a few seconds). The
/// look is the 荷物 list's toast (neutral-900, white words, radius 12).
struct ToastBanner: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Palette.toastBackground, in: RoundedRectangle(cornerRadius: 12))
            .shadow(radius: 8, y: 2)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .combine)
    }
}
