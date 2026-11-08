// The other pages of the settings list: the forwarding address and guide, the mail that was not read, the
// way the mail is handled, why a parcel may not arrive, and the samples. Each holds what the long screen's
// section held (same cards, buttons and words).

import SwiftUI

// MARK: 「メールの転送」

struct SettingsForwardPage: View {
    let model: SettingsModel
    /// The guide's Gmail and other cards open from the start (the screen check).
    var expandsGuide = false
    @Environment(\.scenePhase) private var scenePhase
    @State private var refresher: ApprovalRefresher?

    var body: some View {
        SettingsParts.page(spacing: 32) {
            addressSection
            // The Web's order: the address, the approval card (and its failure), then the guides.
            SettingsStatusRows(model: model).approvalSection
            ForwardingGuideView(expanded: expandsGuide)
        }
        .refreshableToTheEnd { await model.load() }
        .task {
            await model.pageShown()
            guard !Task.isCancelled else { return }
            // The approval card appears by itself (the Web's RefreshUntilApproval): see ApprovalRefresher.
            let refresher = ApprovalRefresher(
                isWaiting: { model.pollsForApproval },
                lastRead: { model.lastApprovalRead },
                read: { await model.refreshApproval() }
            )
            self.refresher = refresher
            refresher.pageShown()
        }
        .onDisappear { refresher?.pageHidden() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await refresher?.cameBack() }
            } else {
                refresher?.wentAway()
            }
        }
        // The link went away on a full read (an old mail fell out of the window): wait for it again.
        .onChange(of: model.pollsForApproval) { _, waiting in
            if waiting { refresher?.waitingAgain() }
        }
        .navigationTitle(SettingsMenuText.forwardTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    private var addressSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            SettingsParts.heading("転送先アドレス")
            switch model.keyPanel {
            case .failed?, nil:
                SettingsParts.errorBox(SettingsWebText.keyReadFailed)
            case .none?:
                SettingsParts.secondaryText(SettingsWebText.keyNotMade)
            case .present?:
                SettingsParts.secondaryText("注文・発送のメールをこのアドレスに転送してください。自動転送を 1 回設定すれば、あとは何もしなくて大丈夫です。")
                switch model.address {
                case let .loaded(address)?:
                    HStack(spacing: 8) {
                        Text(address)
                            .font(model.addressCanBeCopied ? .subheadline.monospaced() : .subheadline)
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
    /// 「荷物を登録する」 under a note that says the parcel can be registered by hand: opens the form in the app.
    let register: () -> Void
    @State private var showsDropped: Bool

    /// `expanded`: the closed list starts open (the screen check).
    init(model: SettingsModel, expanded: Bool = false, register: @escaping () -> Void) {
        self.model = model
        self.register = register
        _showsDropped = State(initialValue: expanded)
    }

    var body: some View {
        SettingsParts.page(spacing: 8) {
            SettingsParts.secondaryText(SettingsWebText.droppedLead)
            if let note = model.mailActions.markNote {
                markNote(note)
            }
            switch model.dropped {
            case let .loaded(rows)? where !rows.isEmpty:
                SettingsDisclosure(title: SettingsWebText.droppedSummary(rows.count), isExpanded: $showsDropped) {
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
        .task { await model.pageShown() }
        .onDisappear { model.mailActions.clearNotes() }
        .navigationTitle(SettingsMenuText.droppedTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    /// What 「これは荷物」 came to (the Web's SENDER_NOTES): green or red, with 「荷物を登録する」 when the parcel can be registered by hand.
    private func markNote(_ note: MailActionsModel.Note) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(note.text)
                .font(.subheadline)
                .lineSpacing(3)
                .foregroundStyle(note.isError ? OtodokeColor.errorText : Palette.emeraldText)
                .fixedSize(horizontal: false, vertical: true)
            if note.offersRegister {
                Button {
                    register()
                } label: {
                    Text(SettingsMailText.register)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 44)
                        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func droppedRow(_ row: DroppedMailRow) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.subject.flatMap { $0.isEmpty ? nil : $0 } ?? SettingsWebText.noSubject)
                    .font(.subheadline)
                    .foregroundStyle(row.subject?.isEmpty ?? true ? Color.secondary : Color.primary)
                    .lineLimit(1)
                Text(verbatim: "\(row.fromDomain ?? "") ・ \(Format.formatDateTimeJa(row.createdAt, today: Format.todayJst(now: Date())))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if row.flaggedAt != nil {
                Text(SettingsMailText.marked)
                    .font(.caption)
                    .foregroundStyle(Palette.emeraldText)
            } else {
                MarkParcelButton(model: model.mailActions, id: row.id)
            }
        }
        .padding(.vertical, 12)
    }
}

// MARK: 「あなたのメールの扱い」

struct SettingsHandlingPage: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        SettingsParts.page(spacing: 12) {
            // One child, so the gap between the summary and the link is this stack's own and does not
            // depend on the page's spacing.
            VStack(alignment: .leading, spacing: 0) {
                MailHandlingView(showsHeading: false)
                // As the Web's page: the whole policy, right under the summary of how mail is handled.
                Button { SettingsWeb.open(.privacy, openURL) } label: {
                    Text(SettingsWebText.privacyTitle)
                        .font(.caption)
                        .underline()
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 4)
                        .frame(minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint(SettingsMenuText.webHint)
            }
        }
        .navigationTitle(SettingsMenuText.handlingTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: 「うまく届かないとき」

struct SettingsDeliveryHelpPage: View {
    @Environment(\.openURL) private var openURL

    var body: some View {
        SettingsParts.page(spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                SettingsParts.heading(DeliveryHelpText.heading)
                SettingsParts.secondaryText(DeliveryHelpText.lead)
            }
            ForEach(Array(DeliveryHelpText.pitfalls.enumerated()), id: \.element.id) { index, pitfall in
                card(number: index + 1, pitfall)
            }
        }
        .navigationTitle(SettingsMenuText.deliveryTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func card(number: Int, _ pitfall: ForwardingGuideText.Pitfall) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                StepBadge(number: number)
                Text(pitfall.title)
                    .font(.subheadline.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            ForEach(Array(pitfall.blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .font(.subheadline)
        .lineSpacing(3)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator)))
    }

    @ViewBuilder
    private func blockView(_ block: ForwardingGuideText.Block) -> some View {
        switch block {
        case let .text(text):
            Text(text)
                .fontWeight(text == "確かめ方:" ? .semibold : .regular)
                .fixedSize(horizontal: false, vertical: true)
        case let .steps(steps):
            StepList(steps: steps)
        case let .domains(domains):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(domains, id: \.self) { domain in
                    Text(verbatim: domain)
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
        case let .links(links):
            VStack(spacing: 8) {
                ForEach(links, id: \.url) { link in
                    SettingsParts.linkCard(link.title) {
                        if let url = URL(string: link.url) { SettingsWeb.openPage(url, openURL) }
                    }
                }
            }
        }
    }
}

// MARK: 「サンプルで試す」

struct SettingsSamplePage: View {
    let model: SettingsModel
    /// The clear-everything box starts open (the screen check).
    var clearOpen = false

    var body: some View {
        SettingsParts.page(spacing: 12) {
            SettingsParts.secondaryText(DemoText.lead)
            if let demo = model.demo {
                SettingsDemoPanel(model: demo, clearOpen: clearOpen)
            }
        }
        .navigationTitle(SettingsMenuText.sampleTitle)
        .navigationBarTitleDisplayMode(.inline)
    }
}
