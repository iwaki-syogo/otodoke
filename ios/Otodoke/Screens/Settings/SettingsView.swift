// The settings tab groups rows for mail and the account. Each native page holds its own content;
// rows show badges for pending approval, missing setup, unread mail, or a count that could not be read.
// The account group shows the signed-in address, sign-out, the privacy policy and account deletion.
// Registration, mail actions, samples, password changes and account deletion finish in the app.
// Making the first key is part of signing in again. The privacy policy is the only SettingsWebAction;
// it opens the full policy over https. There is no general Web-version entry in the settings list.

import SwiftUI

/// The pages the list opens.
enum SettingsPage: Hashable, CaseIterable {
    case forward, key, dropped, handling, delivery, sample, deleteAccount
}

struct SettingsView: View {
    let model: SettingsModel
    @State private var showsPrivacy = false
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
        .sheet(isPresented: $showsPrivacy) { AIReadingPrivacySheet() }
    }

    @ViewBuilder
    private func destination(_ page: SettingsPage) -> some View {
        switch page {
        case .forward: SettingsForwardPage(model: model, expandsGuide: expands)
        case .key: SettingsKeyPage(model: model)
        case .dropped: SettingsDroppedPage(model: model, expanded: expands, register: register)
        case .handling: SettingsHandlingPage(model: model)
        case .delivery: SettingsDeliveryHelpPage(model: model, register: register)
        case .sample: SettingsSamplePage(model: model)
        case .deleteAccount: AccountDeletionView(model: model.accountDeletion, email: model.signedInEmail)
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
                        group(Self.mailPages(for: model))
                    }
                    section(SettingsWebText.accountGroup) {
                        VStack(alignment: .leading, spacing: 0) {
                            loginRow
                            Divider().padding(.leading, 58)
                            logoutRow
                            Divider().padding(.leading, 58)
                            privacyRow
                            Divider().padding(.leading, 58)
                            row(.deleteAccount)
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

    private var privacyRow: some View {
        Button { showsPrivacy = true } label: {
            SettingsRow(symbol: "doc.text", title: SettingsWebText.privacyTitle, subtitle: nil, badge: nil, trailing: "chevron.right")
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
        case .deleteAccount: SettingsWebText.deleteTitle
        }
    }

    static func subtitle(_ page: SettingsPage) -> String? {
        switch page {
        case .forward: SettingsMenuText.forwardSubtitle
        case .key: SettingsMenuText.keySubtitle
        case .delivery: SettingsMenuText.deliverySubtitle
        case .dropped, .handling, .sample, .deleteAccount: nil
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
        case .deleteAccount: "trash"
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

    /// The mail group as the Web draws it (settings-row.tsx orderRows): the rows in this order when nothing needs doing.
    static let mailOrder: [SettingsPage] = [.forward, .key, .dropped, .handling, .delivery, .sample]

    /// The rows that need something done come first, in this order (the Web's ACTION_ORDER: password, trouble, forwarding).
    private static let actionOrder: [SettingsPage] = [.key, .delivery, .forward]

    /// Action rows first (in `actionOrder`), then the rest in `mailOrder` (the Web's orderRows).
    static func orderedMailPages(actions: Set<SettingsPage>) -> [SettingsPage] {
        let urgent = actionOrder.filter { actions.contains($0) }
        return urgent + mailOrder.filter { !urgent.contains($0) }
    }

    /// The rows that need something done, by the Web's `action` of each row ((list)/page.tsx): a confirmation that waits for
    /// its approval, no key (a key or a count that could not be read is not an action), mail waiting to be read.
    static func actionPages(for model: SettingsModel) -> Set<SettingsPage> {
        var out = Set<SettingsPage>()
        if model.approvalWaiting, !model.approvalBadgeFailed { out.insert(.forward) }
        if case .none? = model.keyPanel { out.insert(.key) }
        if case let .loaded(n)? = model.unread, n > 0 { out.insert(.delivery) }
        return out
    }

    static func mailPages(for model: SettingsModel) -> [SettingsPage] {
        orderedMailPages(actions: actionPages(for: model))
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
