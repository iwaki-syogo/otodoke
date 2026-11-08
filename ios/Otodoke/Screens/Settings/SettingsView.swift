// The 設定 tab: a list of items, each opening its own page (メールの転送 / パスワードとメールの鍵 / 読まなかった
// メール / あなたのメールの扱い / うまく届かないとき / サンプルで試す), then 「Web で開く」, who is signed in and
// signing out. As on the Web the list draws no cards: what needs an answer shows as a badge on its row
// (承認待ち, 未設定, 未読 N, a count that could not be read) and the card itself is inside the page it belongs to.
// The pages hold what the long screen used to (SettingsPages, SettingsKeyPage).
// 「読み取る」, 「これは荷物」 (and 「荷物を登録する」 under it) and the samples finish in the app (MailActionsModel,
// DemoModel); making the key is signing in again. Only changing the password, deleting the account, the privacy
// policy and 「Web で開く」 open the Web (SettingsModel.webLink). Only https pages are opened.

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
    /// 「荷物を登録する」 (under 「これは荷物」): opens the form of a parcel typed in by hand.
    private let register: () -> Void

    private var path: Binding<[SettingsPage]> { outerPath ?? $ownPath }

    /// `expanded`: the closed cards (the guide, the mail that was not read) start open.
    /// `page`: opens that page at once (the screen check).
    init(model: SettingsModel, expanded: Bool = false, page: SettingsPage? = nil, register: @escaping () -> Void = {}) {
        self.model = model
        self.register = register
        expands = expanded
        outerPath = nil
        _ownPath = State(initialValue: page.map { [$0] } ?? [])
    }

    /// With the stack held by the caller.
    init(model: SettingsModel, path: Binding<[SettingsPage]>, register: @escaping () -> Void) {
        self.model = model
        self.register = register
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
        case .dropped: SettingsDroppedPage(model: model, expanded: expands, register: register)
        case .handling: SettingsHandlingPage()
        case .delivery: SettingsDeliveryHelpPage(model: model)
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
                    section(SettingsWebText.mailGroup) {
                        group([.forward, .key, .dropped, .handling, .delivery, .sample])
                    }
                    section(SettingsWebText.accountGroup) {
                        VStack(alignment: .leading, spacing: 0) {
                            loginRow
                            Divider().padding(.leading, 58)
                            logoutRow
                            Divider().padding(.leading, 58)
                            webRow(.privacy, symbol: "doc.text", title: SettingsWebText.privacyTitle)
                            Divider().padding(.leading, 58)
                            webRow(.deleteAccount, symbol: "trash", title: SettingsWebText.deleteTitle)
                            Divider().padding(.leading, 58)
                            webRow(.openWeb, symbol: "safari", title: SettingsMenuText.webTitle)
                        }
                        .modifier(SettingsCard())
                    }
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
        case .dropped: Self.droppedBadge(for: model)
        case .delivery: Self.deliveryBadge(for: model)
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

    /// The 「読まなかったメール」 row: the count (neutral), 確認できません when it could not be read (never drawn as 0).
    static func droppedBadge(for model: SettingsModel) -> SettingsRow.Badge? {
        switch model.dropped {
        case let .loaded(rows)?: .init(text: rows.count.formatted(.number.locale(Locale(identifier: "ja_JP"))), kind: .neutral)
        case .failed?: .init(text: SettingsMenuText.keyUnknownBadge, kind: .red)
        case nil: nil
        }
    }

    /// The 「うまく届かないとき」 row: 未読 N while mail waits to be read, 確認できません when the count could not be read.
    static func deliveryBadge(for model: SettingsModel) -> SettingsRow.Badge? {
        switch model.unread {
        case let .loaded(n)? where n > 0: .init(text: SettingsMenuText.unreadBadge(n), kind: .amber)
        case .failed?: .init(text: SettingsMenuText.keyUnknownBadge, kind: .red)
        default: nil
        }
    }

    /// The key row's badge: 未設定 while there is no key (鍵を作れませんでした when the key step failed), 確認できません
    /// while the count of mail sealed with an earlier key could not be read (never drawn as 0).
    static func keyBadge(for model: SettingsModel) -> SettingsRow.Badge? {
        switch model.keyPanel {
        case .none?:
            if model.keyStepFailure != nil {
                return .init(text: SettingsMenuText.keyStepFailedBadge, kind: .red)
            }
            return .init(text: SettingsMenuText.keyNoneBadge, kind: .amber)
        case let .present(oldKeyCount)?:
            if case .failed = oldKeyCount { return .init(text: SettingsMenuText.keyUnknownBadge, kind: .red) }
            return nil
        case .failed?, nil:
            return nil
        }
    }

    // MARK: who is signed in, signing out

    /// 「ログイン中」 with the address, as the Web's info row of the account card.
    private var loginRow: some View {
        SettingsInfoRow(symbol: "person", title: SettingsWebText.loginTitle, value: model.signedInEmail ?? "")
    }

    /// 「ログアウト」, a row of the account card (the press, the key forgotten and the wait are the model's, unchanged).
    private var logoutRow: some View {
        Button {
            Task { await model.signOut() }
        } label: {
            SettingsRow(symbol: "rectangle.portrait.and.arrow.right", title: SettingsWebText.logoutTitle, subtitle: nil, badge: nil, trailing: model.isSigningOut ? "ellipsis" : nil)
        }
        .buttonStyle(.plain)
        .disabled(model.isSigningOut)
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

/// The gray rounded square with the symbol, at the start of every row.
struct SettingsRowIcon: View {
    let symbol: String

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(.primary)
            .frame(width: 30, height: 30)
            .background(Color(.systemGray5), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityHidden(true)
    }
}

/// A row that opens nothing (the Web's RowInfo): the title and its value, which wraps under the title when long.
struct SettingsInfoRow: View {
    let symbol: String
    let title: String
    let value: String

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(symbol: symbol)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { titleText; valueText(alignment: .trailing) }
                VStack(alignment: .leading, spacing: 2) { titleText; valueText(alignment: .leading) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(minHeight: 56)
        .accessibilityElement(children: .combine)
    }

    private var titleText: some View {
        Text(title)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.primary)
            .fixedSize()
    }

    private func valueText(alignment: Alignment) -> some View {
        Text(verbatim: value)
            .font(.caption)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(alignment == .trailing ? .trailing : .leading)
            .frame(maxWidth: .infinity, alignment: alignment)
    }
}

/// One row of the list: a gray rounded square with the symbol, a title, an optional subtitle and badge.
struct SettingsRow: View {
    struct Badge: Equatable {
        enum Kind { case sky, amber, red, neutral }
        let text: String
        let kind: Kind
    }

    let symbol: String
    let title: String
    let subtitle: String?
    let badge: Badge?
    let trailing: String?
    var hint: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(spacing: 12) {
            SettingsRowIcon(symbol: symbol)
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
            if let trailing {
                Image(systemName: trailing)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
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
        case .neutral: Color.secondary
        }
    }

    private static func background(_ kind: Badge.Kind) -> Color {
        switch kind {
        case .sky: SettingsPalette.skyBackground
        case .amber: Palette.amberBackground
        case .red: Palette.errorBackground
        case .neutral: Color(.systemGray5)
        }
    }

    private static func border(_ kind: Badge.Kind) -> Color {
        switch kind {
        case .sky: SettingsPalette.skyBorder
        case .amber: Palette.amberBorder
        case .red: Palette.errorBorder
        case .neutral: Color.clear
        }
    }
}
