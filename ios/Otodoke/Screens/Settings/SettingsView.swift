// The 設定 tab: a list of items, each opening its own page (メールの転送 / パスワードとメールの鍵 / 読まなかった
// メール / あなたのメールの扱い / うまく届かないとき / サンプルで試す), then 「Web で開く」, who is signed in and
// signing out. What needs an answer now (the mail waiting to be read, the Gmail approval, a key that could
// not be read) is drawn at the top; the key row carries a small badge while there is no key or mail is
// still unencrypted. The pages hold what the long screen used to (SettingsPages, SettingsKeyPage).
// Making or changing the passphrase, 「暗号化する」, 「読み取る」, 「これは荷物」, the samples and clearing
// everything open the Web (SettingsModel.webLink). Only https pages are opened.

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
        case .sample: SettingsSamplePage()
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
                    group([.forward, .key, .dropped, .handling, .delivery])
                    VStack(alignment: .leading, spacing: 0) {
                        row(.sample)
                        Divider().padding(.leading, 58)
                        webRow
                    }
                    .modifier(SettingsCard())
                    footer
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)
            }
            .refreshableToTheEnd { await model.load() }
        }
    }

    // MARK: the rows

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

    private var webRow: some View {
        Button { SettingsWeb.open(.openWeb, openURL) } label: {
            SettingsRow(symbol: "safari", title: SettingsMenuText.webTitle, subtitle: nil, badge: nil, trailing: "arrow.up.right")
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

    /// The key row's badge: no key yet, or mail from before the encryption is still readable by the operator.
    private func badge(_ page: SettingsPage) -> SettingsRow.Badge? {
        guard page == .key else { return nil }
        switch model.keyPanel {
        case .none?:
            return .init(text: SettingsMenuText.keyNoneBadge, kind: .sky)
        case let .present(plainCount, _)?:
            if case let .loaded(n) = plainCount, n > 0 {
                return .init(text: SettingsMenuText.plainBadge(n), kind: .amber)
            }
            return nil
        case .failed?, nil:
            return nil
        }
    }

    // MARK: who is signed in, signing out

    private var footer: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let email = model.signedInEmail {
                Text("ログイン中: \(Text(verbatim: email).fontWeight(.medium).foregroundStyle(.primary))（自分のアドレスでなければ、何も設定せずにログアウトしてください）")
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
    struct Badge {
        enum Kind { case sky, amber }
        let text: String
        let kind: Kind
    }

    let symbol: String
    let title: String
    let subtitle: String?
    let badge: Badge?
    let trailing: String

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
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let badge {
                Text(badge.text)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(badge.kind == .sky ? OtodokeColor.link : Palette.amberText)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 8)
                    .padding(.vertical, 2)
                    .background(badge.kind == .sky ? SettingsPalette.skyBackground : Palette.amberBackground, in: Capsule())
                    .overlay(Capsule().stroke(badge.kind == .sky ? SettingsPalette.skyBorder : Palette.amberBorder))
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
    }
}
