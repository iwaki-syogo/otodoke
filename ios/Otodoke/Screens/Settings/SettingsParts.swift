// The small parts every settings page shares: the headings, the notes, the boxes and buttons the long
// screen used to carry privately. The look is unchanged (the Web's black button, white-and-line cards).

import SwiftUI

enum SettingsParts {
    static func heading(_ text: String) -> some View {
        Text(text)
            .font(.headline)
            .fixedSize(horizontal: false, vertical: true)
    }

    static func secondaryText(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
    }

    static func errorBox(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(OtodokeColor.errorText)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Palette.errorBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.errorBorder))
    }

    /// The Web's black button (white in dark mode).
    static func primaryButton(_ title: String, fullWidth: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color(.systemBackground))
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color.primary, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }

    /// A card row that opens a Web page (the Web's <details> summary row, here a link out).
    static func linkCard(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
    }

    /// The scrolling page every settings page sits in.
    static func page<Content: View>(spacing: CGFloat = 24, @ViewBuilder _ content: () -> Content) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: spacing) {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 20)
        }
    }
}

/// What the settings screens open on the Web. Only https pages are opened.
@MainActor
enum SettingsWeb {
    static func open(_ action: SettingsWebAction, _ openURL: OpenURLAction) {
        openPage(SettingsModel.webLink(action), openURL)
    }

    /// Safari, https only.
    static func openPage(_ url: URL, _ openURL: OpenURLAction) {
        guard url.scheme?.lowercased() == "https" else { return }
        openURL(url)
    }
}

/// The Web's sky card (the key to make), with a dark-mode pair.
enum SettingsPalette {
    /// sky-50 / border sky-300
    static let skyBackground = OtodokeColor.adaptive(light: "#f0f9ff", dark: "#082f49")
    static let skyBorder = OtodokeColor.adaptive(light: "#7dd3fc", dark: "#0369a1")
}
