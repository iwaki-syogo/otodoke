import SwiftUI

/// The hosting viewport already respects the safe area. Apply its inner margin once, including DEBUG sizes.
struct AIReadingConsentCardBounds: Equatable {
    let width: CGFloat
    let maxHeight: CGFloat

    init(size: CGSize) {
        width = min(320, max(0, size.width - 32))
        maxHeight = max(0, size.height - 32)
    }
}

/// No presentation binding or dismissal gesture exists: only a confirmed choice removes this overlay.
struct AIReadingConsentModal<Content: View>: View {
    @ViewBuilder let content: Content
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            let bounds = AIReadingConsentCardBounds(size: geometry.size)
            ZStack {
                Color.black.opacity(0.4)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture {}
                    .accessibilityHidden(true)
                    .accessibilityIdentifier("ai-reading-consent.dimmer")
                ScrollView {
                    content
                        .frame(maxWidth: .infinity)
                        .padding(20)
                        .background {
                            GeometryReader { contentGeometry in
                                Color.clear.preference(key: ConsentCardHeight.self, value: contentGeometry.size.height)
                            }
                        }
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(width: bounds.width, height: min(contentHeight > 0 ? contentHeight : bounds.maxHeight, bounds.maxHeight))
                .background(Color(.secondarySystemGroupedBackground))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .shadow(color: .black.opacity(0.16), radius: 20, y: 8)
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
                .accessibilityAction(.escape) {}
                .accessibilityIdentifier("ai-reading-consent.modal")
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .onPreferenceChange(ConsentCardHeight.self) { contentHeight = $0 }
        }
    }
}

private struct ConsentCardHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

#if DEBUG
/// App-local layout fixtures, using the existing simulator without changing its global settings.
struct ConsentPreviewViewport: ViewModifier {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let small = ProcessInfo.processInfo.arguments.contains("-ConsentSmallViewport")
    private let short = ProcessInfo.processInfo.arguments.contains("-ConsentShortViewport")
    private let largest = ProcessInfo.processInfo.arguments.contains("-ConsentAccessibilitySize")
    private let dark = ProcessInfo.processInfo.arguments.contains("-ConsentDarkAppearance")

    @ViewBuilder func body(content: Content) -> some View {
        if small || short {
            GeometryReader { geometry in
                content
                    .environment(\.dynamicTypeSize, largest ? .accessibility5 : dynamicTypeSize)
                    .frame(width: min(small ? 375 : 667, geometry.size.width),
                           height: min(short ? 375 : 667, geometry.size.height))
                    .clipped()
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("ai-reading-consent.viewport")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .preferredColorScheme(dark ? .dark : nil)
        } else {
            content
                .environment(\.dynamicTypeSize, largest ? .accessibility5 : dynamicTypeSize)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("ai-reading-consent.viewport")
                .preferredColorScheme(dark ? .dark : nil)
        }
    }
}
#endif
