// The 設定 tab: a list of items, each opening its own page (メールの転送 / パスワードとメールの鍵 / 読まなかった
// メール / あなたのメールの扱い / うまく届かないとき / サンプルで試す), then 「Web で開く」, who is signed in and
// signing out. What needs an answer now (the mail waiting to be read, the Gmail approval, a key that could
// not be read) is drawn at the top; the key row carries a small badge while there is no key or mail is
// still unencrypted. The pages hold what the long screen used to (SettingsPages, SettingsKeyPage).
// Making or changing the passphrase, 「暗号化する」, 「読み取る」 and 「これは荷物」 open the Web (SettingsModel.webLink); the
// samples load and clear everything in the app (DemoModel). Only https pages are opened.

import SwiftUI

/// The pages the list opens.
enum SettingsPage: Hashable, CaseIterable {
    case forward, key, dropped, handling, delivery, sample
}

struct SettingsView: View {
    let model: SettingsModel
    @Environment(\.openURL) private var openURL
    @State private var ownPath: [SettingsPage]
    /// The stack held by the caller (the tabs open 「メールの転送」 from the empty list); nil: this view's own.
    private let outerPath: Binding<[SettingsPage]>?
    private let expands: Bool

    private var path: Binding<[SettingsPage]> { outerPath ?? $ownPath }

    /// `expanded`: the closed cards (the guide, the mail that was not read) start open.
    /// `page`: opens that page at once (the screen check).
    init(model: SettingsModel, expanded: Bool = false, page: SettingsPage? = nil) {
        self.model = model
        expands = expanded
        outerPath = nil
        _ownPath = State(initialValue: page.map { [$0] } ?? [])
    }

    /// With the stack held by the caller.
    init(model: SettingsModel, path: Binding<[SettingsPage]>) {
        self.model = model
        expands = false
        outerPath = path
        _ownPath = State(initialValue: [])
    }

    var body: some View {
        NavigationStack(path: path) {
            content
                .navigationTitle("設定")
                .navigationBarTitleDisplayMode(.inline)
                .navigationDestination(for: SettingsPage.self) { destination($0) }
        }
        .task { await model.onAppear() }
    }

    @ViewBuilder
    private func destination(_ page: SettingsPage) -> some View {
        switch page {
        case .forward: SettingsForwardPage(model: model, expandsGuide: expands)
        case .key: SettingsKeyPage(model: model)
        case .dropped: SettingsDroppedPage(model: model, expanded: expands)
        case .handling: SettingsHandlingPage()
        case .delivery: SettingsDeliveryHelpPage()
        case .sample: SettingsSamplePage(model: model)
        }
    }

    @ViewBuilder
    private var content: some View {
        if model.keyPanel == nil {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if case .failed? = model.keyPanel {
                        SettingsParts.errorBox(SettingsModel.failedText)
                    }
                    SettingsStatusRows(model: model)
                    section(SettingsWebText.mailGroup) {
                        group([.forward, .key, .dropped, .handling, .delivery, .sample])
                    }
                    section(SettingsWebText.accountGroup) {
                        VStack(alignment: .leading, spacing: 0) {
                            webRow(.privacy, symbol: "hand.raised", title: SettingsWebText.privacyTitle)
                            Divider().padding(.leading, 58)
                            webRow(.deleteAccount, symbol: "trash", title: SettingsWebText.deleteTitle)
                            Divider().padding(.leading, 58)
                            webRow(.openWeb, symbol: "safari", title: SettingsMenuText.webTitle)
                        }
                        .modifier(SettingsCard())
                    }
                    footer
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)
            }
            .refreshableToTheEnd { await model.load() }
        }
    }

    // MARK: the rows

    /// A group of the list under its small label, as the Web's two groups (メール, アカウント).
    private func section<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 4)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    private func group(_ pages: [SettingsPage]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(pages.enumerated()), id: \.element) { index, page in
                if index > 0 { Divider().padding(.leading, 58) }
                row(page)
            }
        }
        .modifier(SettingsCard())
    }

    private func row(_ page: SettingsPage) -> some View {
        NavigationLink(value: page) {
            SettingsRow(symbol: Self.symbol(page), title: Self.title(page), subtitle: Self.subtitle(page), badge: badge(page), trailing: "chevron.right")
        }
        .buttonStyle(.plain)
    }

    /// A row that leaves the app for a Web page (Safari).
    private func webRow(_ action: SettingsWebAction, symbol: String, title: String, subtitle: String? = nil) -> some View {
        Button { SettingsWeb.open(action, openURL) } label: {
            SettingsRow(symbol: symbol, title: title, subtitle: subtitle, badge: nil, trailing: "arrow.up.right", hint: SettingsMenuText.webHint)
        }
        .buttonStyle(.plain)
    }

    static func title(_ page: SettingsPage) -> String {
        switch page {
        case .forward: SettingsMenuText.forwardTitle
        case .key: SettingsMenuText.keyTitle
        case .dropped: SettingsMenuText.droppedTitle
        case .handling: SettingsMenuText.handlingTitle
        case .delivery: SettingsMenuText.deliveryTitle
        case .sample: SettingsMenuText.sampleTitle
        }
    }

    static func subtitle(_ page: SettingsPage) -> String? {
        switch page {
        case .forward: SettingsMenuText.forwardSubtitle
        case .key: SettingsMenuText.keySubtitle
        case .delivery: SettingsMenuText.deliverySubtitle
        case .dropped, .handling, .sample: nil
        }
    }

    static func symbol(_ page: SettingsPage) -> String {
        switch page {
        case .forward: "envelope"
        case .key: "key"
        case .dropped: "eye.slash"
        case .handling: "lock.shield"
        case .delivery: "questionmark.circle"
        case .sample: "tray.and.arrow.down"
        }
    }

    private func badge(_ page: SettingsPage) -> SettingsRow.Badge? {
        switch page {
        case .key: Self.keyBadge(for: model)
        case .forward: Self.forwardBadge(for: model)
        default: nil
        }
    }

    /// The 「メールの転送」 row's badge ((list)/page.tsx): 確認できません when the confirmation or what the time rule
    /// needs could not be read, 承認待ち while the newest valid confirmation has nothing after it.
    static func forwardBadge(for model: SettingsModel) -> SettingsRow.Badge? {
        if model.approvalBadgeFailed { return .init(text: SettingsMenuText.keyUnknownBadge, kind: .red) }
        if model.approvalWaiting { return .init(text: SettingsMenuText.approvalBadge, kind: .amber) }
        return nil
    }

    /// The key row's badge. Mail still readable by the operator (未暗号化 n 通) is the most important
    /// warning, so it wins over a count that could not be read; otherwise a count that failed shows as
    /// unknown (never drawn as 0). With no key the badge stays 未設定 even if the unencrypted count failed:
    /// that is true (there is no key yet), and the key page says the rest.
    static func keyBadge(for model: SettingsModel) -> SettingsRow.Badge? {
        switch model.keyPanel {
        case .none?:
            if model.keyStepFailure != nil {
                return .init(text: SettingsMenuText.keyStepFailedBadge, kind: .red)
            }
            return .init(text: SettingsMenuText.keyNoneBadge, kind: .amber)
        case let .present(plainCount, oldKeyCount)?:
            if case let .loaded(n) = plainCount, n > 0 {
                return .init(text: SettingsMenuText.plainBadge(n), kind: .amber)
            }
            if case .failed = plainCount { return .init(text: SettingsMenuText.keyUnknownBadge, kind: .red) }
            if case .failed = oldKeyCount { return .init(text: SettingsMenuText.keyUnknownBadge, kind: .red) }
            return nil
        case .failed?, nil:
            return nil
        }
    }

    // MARK: who is signed in, signing out

    private var footer: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let email = model.signedInEmail {
                Text("ログイン中: \(Text(verbatim: email).fontWeight(.medium).foregroundStyle(.primary))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                Task { await model.signOut() }
            } label: {
                HStack(spacing: 8) {
                    if model.isSigningOut {
                        ProgressView().controlSize(.small)
                    }
                    Text("ログアウト")
                }
                .font(.subheadline)
                .foregroundStyle(.primary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
            }
            .buttonStyle(.plain)
            .disabled(model.isSigningOut)
        }
    }
}

/// White card with the thin line (no shadow), as the parcel cards.
struct SettingsCard: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
            .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

/// One row of the list: a gray rounded square with the symbol, a title, an optional subtitle and badge.
struct SettingsRow: View {
    struct Badge: Equatable {
        enum Kind { case sky, amber, red }
        let text: String
        let kind: Kind
    }

    let symbol: String
    let title: String
    let subtitle: String?
    let badge: Badge?
    let trailing: String
    var hint: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: 30, height: 30)
                .background(Color(.systemGray5), in: RoundedRectangle(cornerRadius: 8))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                if let subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                // At the accessibility sizes the badge goes under the title, so it cannot squeeze it.
                if let badge, typeSize.isAccessibilitySize {
                    badgeView(badge).padding(.top, 4)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let badge, !typeSize.isAccessibilitySize {
                badgeView(badge)
            }
            Image(systemName: trailing)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .accessibilityHint(hint ?? "")
    }

    private func badgeView(_ badge: Badge) -> some View {
        Text(badge.text)
            .font(.caption2.weight(.medium))
            .foregroundStyle(Self.text(badge.kind))
            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            .fixedSize(horizontal: typeSize.isAccessibilitySize ? false : true, vertical: true)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Self.background(badge.kind), in: Capsule())
            .overlay(Capsule().stroke(Self.border(badge.kind)))
    }

    private static func text(_ kind: Badge.Kind) -> Color {
        switch kind {
        case .sky: OtodokeColor.link
        case .amber: Palette.amberText
        case .red: OtodokeColor.errorText
        }
    }

    private static func background(_ kind: Badge.Kind) -> Color {
        switch kind {
        case .sky: SettingsPalette.skyBackground
        case .amber: Palette.amberBackground
        case .red: Palette.errorBackground
        }
    }

    private static func border(_ kind: Badge.Kind) -> Color {
        switch kind {
        case .sky: SettingsPalette.skyBorder
        case .amber: Palette.amberBorder
        case .red: Palette.errorBorder
        }
    }
}
