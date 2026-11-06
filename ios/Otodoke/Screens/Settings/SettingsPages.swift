// The other pages of the settings list: the forwarding address and guide, the mail that was not read, the
// way the mail is handled, why a parcel may not arrive, and the samples. Each holds what the long screen's
// section held (same cards, buttons and words).

import SwiftUI

// MARK: 「メールの転送」

struct SettingsForwardPage: View {
    let model: SettingsModel
    /// The guide's Gmail and other cards open from the start (the screen check).
    var expandsGuide = false

    var body: some View {
        SettingsParts.page(spacing: 32) {
            SettingsStatusRows(model: model).approvalSection
            addressSection
            ForwardingGuideView(expanded: expandsGuide)
        }
        .refreshableToTheEnd { await model.load() }
        .navigationTitle(SettingsMenuText.forwardTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var addressSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsParts.heading("転送先アドレス")
            switch model.keyPanel {
            case .failed?, nil:
                SettingsParts.errorBox("鍵を読み込めなかったので、アドレスを出せませんでした。ページを読み込み直してください。")
            case .none?:
                SettingsParts.secondaryText("鍵ができると、ここに出ます。サンプルは鍵なしで試せます。")
            case .present?:
                SettingsParts.secondaryText("注文・発送のメールをこのアドレスに転送してください。自動転送を 1 回設定すれば、あとは何もしなくて大丈夫です。")
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
                    SettingsParts.errorBox(SettingsModel.failedText)
                }
            }
        }
    }
}

// MARK: 「読まなかったメール」

struct SettingsDroppedPage: View {
    let model: SettingsModel
    @Environment(\.openURL) private var openURL
    @State private var showsDropped: Bool

    /// `expanded`: the closed list starts open (the screen check).
    init(model: SettingsModel, expanded: Bool = false) {
        self.model = model
        _showsDropped = State(initialValue: expanded)
    }

    var body: some View {
        SettingsParts.page(spacing: 8) {
            SettingsParts.secondaryText("広告など、買い物に関係なさそうなメールです。本文は保存せず、件名だけ 14 日間残します。")
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
                SettingsParts.errorBox(SettingsModel.failedText)
            }
        }
        .refreshableToTheEnd { await model.load() }
        .navigationTitle(SettingsMenuText.droppedTitle)
        .navigationBarTitleDisplayMode(.inline)
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
                Button { SettingsWeb.open(.markAsParcel, openURL) } label: {
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
}

// MARK: 「あなたのメールの扱い」

struct SettingsHandlingPage: View {
    var body: some View {
        SettingsParts.page {
            MailHandlingView(showsHeading: false)
        }
        .navigationTitle(SettingsMenuText.handlingTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: 「うまく届かないとき」

struct SettingsDeliveryHelpPage: View {
    var body: some View {
        SettingsParts.page(spacing: 12) {
            ForEach(Array(DeliveryHelpText.items.enumerated()), id: \.offset) { index, item in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(verbatim: "\(index + 1)")
                        .font(.caption.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                        .background(Color(.systemGray5), in: Circle())
                    Text(item)
                        .font(.subheadline)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(16)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
            }
        }
        .navigationTitle(SettingsMenuText.deliveryTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: 「サンプルで試す」

struct SettingsSamplePage: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        SettingsParts.page(spacing: 8) {
            SettingsParts.secondaryText("匿名化した実際の注文・発送メールを読み込みます。日付は今日に合わせてずらしてあります。")
            SettingsParts.primaryButton("サンプルのメールを読み込む", fullWidth: true) { SettingsWeb.open(.sample, openURL) }
                .padding(.top, 4)
            Button { SettingsWeb.open(.clearAll, openURL) } label: {
                Text("すべての荷物を消す")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .padding(.top, 4)
        }
        .navigationTitle(SettingsMenuText.sampleTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}
