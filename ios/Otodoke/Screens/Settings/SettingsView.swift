// The 設定 tab (src/app/app/settings/page.tsx, 2541793), in the Web's order and words: the passphrase card
// (three states), who is signed in, the forwarding address, unread mail, the Gmail approval, the
// forwarding guide, the mail that was not read, 「あなたのメールの扱い」, the samples, and signing out.
// Making or changing the passphrase, 「暗号化する」, 「読み取る」, 「これは荷物」, the samples and
// clearing everything open the Web (SettingsModel.webLink). Only https pages are opened.

import SwiftUI

struct SettingsView: View {
    @Bindable var model: SettingsModel
    @Environment(\.openURL) private var openURL
    @State private var showsDropped: Bool
    /// The guide's Gmail and other cards open from the start (the screen check).
    private let expandsGuide: Bool

    /// `expanded`: the closed cards (the guide, the mail that was not read) start open.
    init(model: SettingsModel, expanded: Bool = false) {
        _model = Bindable(model)
        _showsDropped = State(initialValue: expanded)
        expandsGuide = expanded
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("設定")
                .navigationBarTitleDisplayMode(.inline)
        }
        .task { await model.onAppear() }
    }

    @ViewBuilder
    private var content: some View {
        if model.keyPanel == nil {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 32) {
                    VStack(alignment: .leading, spacing: 8) {
                        keyPanel
                        signedInNote
                    }
                    addressSection
                    unreadSection
                    approvalSection
                    ForwardingGuideView(expanded: expandsGuide)
                    droppedSection
                    MailHandlingView()
                    sampleSection
                    footer
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 20)
            }
            .refreshable { await model.load() }
        }
    }

    // MARK: the passphrase card

    @ViewBuilder
    private var keyPanel: some View {
        switch model.keyPanel {
        case .failed?, nil:
            VStack(alignment: .leading, spacing: 8) {
                heading("合言葉")
                errorBox(SettingsModel.failedText)
            }
        case let .none(plainCount)?:
            VStack(alignment: .leading, spacing: 8) {
                heading("合言葉を決める")
                Text("読み取った後のメールの件名・差出人・本文は、この合言葉でしか開けない形で保存します。運営者もデータベースからは読めません。")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                if case let .loaded(n) = plainCount, n > 0 {
                    Text(verbatim: "暗号化されていない保存済みのメール \(n) 通も、決めたあとに暗号化できます。それまでは運営者が読める形です。")
                        .font(.subheadline.bold())
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                        .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Palette.amberBorder))
                }
                primaryButton("決める") { open(.createPassphrase) }
                    .padding(.top, 4)
            }
            .padding(16)
            .background(SettingsPalette.skyBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(SettingsPalette.skyBorder))
        case let .present(plainCount, oldKeyCount)?:
            VStack(alignment: .leading, spacing: 12) {
                heading("合言葉")
                switch plainCount {
                case let .loaded(n) where n > 0:
                    VStack(alignment: .leading, spacing: 4) {
                        Text(verbatim: "暗号化されていないメールが \(n) 通あります")
                            .font(.subheadline.bold())
                        Text("暗号化を始める前に読み取ったメールなどです。押すまでは、運営者が読める形で残ります。")
                            .font(.subheadline)
                            .fixedSize(horizontal: false, vertical: true)
                        primaryButton("暗号化する") { openPage(WebLink.settings) }
                            .padding(.top, 8)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
                case .failed:
                    errorBox(SettingsModel.plainCountFailedText)
                default:
                    EmptyView()
                }
                if case let .loaded(n) = oldKeyCount, n > 0 {
                    Text(SettingsModel.oldKeyText(n))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                linkCard("合言葉を変える") { open(.changePassphrase) }
            }
        }
    }

    @ViewBuilder
    private var signedInNote: some View {
        if let email = model.signedInEmail {
            Text("ログイン中: \(Text(verbatim: email).fontWeight(.medium).foregroundStyle(.primary))（自分のアドレスでなければ、何も設定せずにログアウトしてください）")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: the address

    private var addressSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading("転送先アドレス")
            switch model.keyPanel {
            case .failed?, nil:
                errorBox("合言葉を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。")
            case .none?:
                secondaryText("合言葉を決めると、ここに出ます。サンプルは合言葉なしで試せます。")
            case .present?:
                secondaryText("注文・発送のメールをこのアドレスに転送してください。自動転送を 1 回設定すれば、あとは何もしなくて大丈夫です。")
                switch model.address {
                case let .loaded(address)?:
                    HStack(spacing: 8) {
                        Text(address)
                            .font(.subheadline.monospaced())
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if model.addressCanBeCopied {
                            CopyButton(text: address)
                        }
                    }
                    .padding(12)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
                    Text("あなた専用のアドレスです。知らない人に教えないでください。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .failed?, nil:
                    errorBox(SettingsModel.failedText)
                }
            }
        }
    }

    // MARK: unread, approval

    @ViewBuilder
    private var unreadSection: some View {
        switch model.unread {
        case let .loaded(n)? where n > 0:
            VStack(alignment: .leading, spacing: 4) {
                heading(model.unreadHeading ?? "")
                Text("1 日の上限を超えたか、読み取りに失敗したメールです。保存してあるので、もう一度読み取れます。")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                primaryButton("読み取る") { open(.readWaiting) }
                    .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
        case .failed?:
            // iOS-9: not the look of 0 mails.
            errorBox(model.unreadHeading ?? SettingsModel.failedText)
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var approvalSection: some View {
        if let url = model.confirmURL {
            VStack(alignment: .leading, spacing: 4) {
                heading("Gmail の転送を承認してください")
                Text("Gmail から転送の確認が届いています。承認済みなら、この案内は無視して大丈夫です。")
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                primaryButton("承認ページを開く") { openPage(url) }
                    .padding(.top, 8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
        }
    }

    // MARK: the mail that was not read

    private var droppedSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading("読まなかったメール")
            secondaryText("広告など、買い物に関係なさそうなメールです。本文は保存せず、件名だけ 14 日間残します。")
            switch model.dropped {
            case let .loaded(rows)? where !rows.isEmpty:
                SettingsDisclosure(title: "荷物のメールが混ざっていないか見る（\(rows.count) 通）", isExpanded: $showsDropped) {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                            if index > 0 { Divider() }
                            droppedRow(row)
                        }
                    }
                    .padding(.vertical, -12)
                }
            case .loaded?:
                Text("まだありません")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            case .failed?, nil:
                errorBox(SettingsModel.failedText)
            }
        }
    }

    private func droppedRow(_ row: DroppedMailRow) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.subject.flatMap { $0.isEmpty ? nil : $0 } ?? "（件名なし）")
                    .font(.subheadline)
                    .lineLimit(1)
                Text(verbatim: "\(row.fromDomain ?? "") ・ \(Format.formatDateTimeJa(row.createdAt, today: Format.todayJst(now: Date())))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if row.flaggedAt != nil {
                Text("荷物として記録済み")
                    .font(.caption)
                    .foregroundStyle(Palette.emeraldText)
            } else {
                Button { open(.markAsParcel) } label: {
                    Text("これは荷物")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
                }
                .buttonStyle(.plain)
                .fixedSize()
            }
        }
        .padding(.vertical, 12)
    }

    // MARK: samples, the Web, signing out

    private var sampleSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            heading("サンプルで試す")
            secondaryText("匿名化した実際の注文・発送メールを読み込みます。日付は今日に合わせてずらしてあります。")
            primaryButton("サンプルのメールを読み込む", fullWidth: true) { open(.sample) }
                .padding(.top, 4)
            Button { open(.clearAll) } label: {
                Text("すべての荷物を消す")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .padding(16)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator), style: StrokeStyle(lineWidth: 1, dash: [5, 4])))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 12) {
            linkCard("Web で開く") { open(.openWeb) }
            if let email = model.signedInEmail {
                Text(verbatim: "ログイン中: \(email)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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

    // MARK: parts

    private func open(_ action: SettingsWebAction) {
        openPage(SettingsModel.webLink(action))
    }

    /// Safari, https only.
    private func openPage(_ url: URL) {
        guard url.scheme?.lowercased() == "https" else { return }
        openURL(url)
    }

    private func heading(_ text: String) -> some View {
        Text(text)
            .font(.headline)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func secondaryText(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func errorBox(_ text: String) -> some View {
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
    private func primaryButton(_ title: String, fullWidth: Bool = false, action: @escaping () -> Void) -> some View {
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
    private func linkCard(_ title: String, action: @escaping () -> Void) -> some View {
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
}

/// The Web's sky card (合言葉を決める), with a dark-mode pair.
private enum SettingsPalette {
    /// sky-50 / border sky-300
    static let skyBackground = OtodokeColor.adaptive(light: "#f0f9ff", dark: "#082f49")
    static let skyBorder = OtodokeColor.adaptive(light: "#7dd3fc", dark: "#0369a1")
}
