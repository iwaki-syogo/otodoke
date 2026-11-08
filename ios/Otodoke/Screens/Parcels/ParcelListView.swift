// The 荷物 tab (src/app/app/page.tsx): 「＋ 登録」, the unread-mail notice, 要確認 (with
// 「すべて受取済にする」), 配達中, もうすぐ届く, 注文中, the page links and the swipe hint, in the Web's order.
// A left swipe says a parcel has arrived; the toast offers 「元に戻す」 for 6 seconds.

import SwiftUI

/// Where the 荷物 tab navigates.
enum ParcelRoute: Hashable {
    case parcel(id: String)
    case delivered
    case cancelled

    var isParcel: Bool {
        if case .parcel = self { return true }
        return false
    }
}

struct ParcelListView<Detail: View>: View {
    @Bindable var model: ParcelListModel
    /// Opens the 設定 tab (the unread-mail notice, and the empty list's buttons when the pages below are not given).
    let openSettings: () -> Void
    /// The empty list's first button for "none" and "approval": opens the 「メールの転送」 page (the settings list when nil).
    var openForwarding: (() -> Void)?
    /// The empty list's first button for "received": opens 「うまく届かないとき」 (the settings list when nil).
    var openTrouble: (() -> Void)?
    /// The detail screen of a parcel.
    @ViewBuilder let detail: (String) -> Detail

    @State private var path: [ParcelRoute] = []
    @State private var showsRest = false
    @State private var confirmingDeliverAll = false
    /// 「＋ 登録」: the form of a parcel typed in by hand, as a sheet (made when it opens).
    @State private var manualForm: ManualParcelModel?
    @Environment(\.openURL) private var openURL
    /// The delivered and cancelled pages (MainTabView hands them down).
    @Environment(\.statusPages) private var pages

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("荷物")
                .navigationBarTitleDisplayMode(.inline)
                .onChange(of: path) { before, after in
                    // Back from a detail: read the list again (it stays on screen meanwhile).
                    if before.contains(where: \.isParcel) && !after.contains(where: \.isParcel) {
                        Task { await model.returnedFromDetail() }
                    }
                }
                .navigationDestination(for: ParcelRoute.self) { route in
                    switch route {
                    case let .parcel(id): detail(id)
                    case .delivered:
                        if let pages {
                            StatusPage(pages.delivered, .delivered, pages.refresher, in: .parcels, refresh: { await $0.sceneBecameActive() }) { model in
                                DeliveredView(model: model, detail: detail)
                            }
                        }
                    case .cancelled:
                        if let pages {
                            StatusPage(pages.cancelled, .cancelled, pages.refresher, in: .parcels, refresh: { await $0.sceneBecameActive() }) { model in
                                CancelledView(model: model, detail: detail)
                            }
                        }
                    }
                }
        }
        .task { await model.onAppear() }
        .sheet(item: $manualForm) { form in
            ManualParcelView(model: form) { manualForm = nil }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch model.loadState {
        case .idle, .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded, .failed:
            list
        }
    }

    private var list: some View {
        List {
            addLink
            if let notice = model.waitingNotice {
                waitingNotice(notice)
            }
            if model.loadState == .failed || model.refreshFailed {
                Text("読み込めませんでした")
                    .font(.subheadline)
                    .foregroundStyle(OtodokeColor.errorText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                    .background(Palette.errorBackground, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.errorBorder))
                    .listRowStyle()
            }
            if model.loadState == .failed {
                pageLinks
            } else if model.isEmpty {
                EmptyParcels(guide: ParcelEmptyText.guide(model.mailSoFar), open: openEmptyGuide, openDemo: { openURL(WebLink.settingsDemo) })
                    .listRowStyle()
                pageLinks
            } else {
                checkSection
                section("配達中", model.sections.delivering)
                section("もうすぐ届く", model.sections.soon)
                section("注文中", model.sections.ordered, empty: "注文中の荷物はありません")
                pageLinks
                if model.showsSwipeHint {
                    Text("届いた荷物は、左にスワイプして「届いた」にできます")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                        .listRowStyle(top: 16)
                }
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .refreshableToTheEnd { await model.load() }
        .overlay(alignment: .bottom) { toast }
        .animation(.default, value: model.rows)
    }

    private func openEmptyGuide(_ destination: EmptyDestination) {
        switch destination {
        case .forwarding: (openForwarding ?? openSettings)()
        case .trouble: (openTrouble ?? openSettings)()
        }
    }

    // MARK: rows

    private var addLink: some View {
        HStack {
            Spacer()
            Button {
                manualForm = ManualParcelModel.live(list: model)
            } label: {
                Text("＋ 登録")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color(.systemBackground), in: Capsule())
                    .overlay(Capsule().stroke(Color(.separator)))
            }
            .buttonStyle(.plain)
        }
        .listRowStyle(top: 16)
    }

    private func waitingNotice(_ text: String) -> some View {
        Button(action: openSettings) {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Palette.amberBackground, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.amberBorder))
                .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain)
        .listRowStyle()
    }

    /// 要確認: in an amber box, the first five, then 「ほか N 件を見る」.
    @ViewBuilder
    private var checkSection: some View {
        let items = model.sections.toCheck
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("要確認").font(.headline)
                    Text("\(items.count)").font(.subheadline).foregroundStyle(Palette.amberText)
                }
                Text("お届け予定から 2 週間以上たっても、届いた連絡がない荷物です。届いていますか？")
                    .font(.subheadline)
                deliverAll(count: items.count)
                    .padding(.top, 8)
            }
            .listRowStyle(top: 22, horizontal: 32, background: AmberBox(top: true, bottom: false))

            // The box's last row rounds its bottom: the last card shown, or 「ほか N 件を見る」 when closed.
            let rest = model.toCheckRest
            let lastCard = rest.isEmpty ? model.toCheckHead.last?.id : (showsRest ? rest.last?.id : nil)
            ForEach(model.toCheckHead) { parcel in
                card(parcel, inBox: true, lastInBox: parcel.id == lastCard)
            }
            if !rest.isEmpty {
                Button {
                    withAnimation { showsRest.toggle() }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .rotationEffect(.degrees(showsRest ? 90 : 0))
                        Text("ほか \(rest.count) 件を見る")
                    }
                    .font(.subheadline)
                    .foregroundStyle(Palette.amberText)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .listRowStyle(bottom: showsRest ? 6 : 22, horizontal: 32, background: AmberBox(top: false, bottom: !showsRest))
                if showsRest {
                    ForEach(rest) { parcel in
                        card(parcel, inBox: true, lastInBox: parcel.id == lastCard)
                    }
                }
            }
        }
    }

    /// 「すべて受取済にする」, then a second press to confirm (or 「やめる」).
    @ViewBuilder
    private func deliverAll(count: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if confirmingDeliverAll || model.isDeliveringAll {
                HStack(spacing: 8) {
                    Button {
                        Task {
                            await model.deliverAll()
                            confirmingDeliverAll = false
                        }
                    } label: {
                        HStack(spacing: 6) {
                            if model.isDeliveringAll { ProgressView().tint(.white) }
                            Text(model.isDeliveringAll ? model.deliverAllProgressText : "\(count) 件を受取済にする")
                                .monospacedDigit()
                        }
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Palette.emerald, in: RoundedRectangle(cornerRadius: 12))
                        .opacity(model.isDeliveringAll ? 0.7 : 1)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isDeliveringAll || !model.deliverAllEnabled)
                    Button {
                        confirmingDeliverAll = false
                    } label: {
                        Text("やめる")
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.separator)))
                    }
                    .buttonStyle(.plain)
                    .disabled(model.isDeliveringAll)
                }
            } else {
                Button {
                    confirmingDeliverAll = true
                } label: {
                    Text("すべて受取済にする")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(model.deliverAllEnabled ? Palette.emeraldText : .secondary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(model.deliverAllEnabled ? Palette.emerald : Color(.separator)))
                }
                .buttonStyle(.plain)
                .disabled(!model.deliverAllEnabled)
            }
            if let message = model.deliverAllMessage {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(OtodokeColor.errorText)
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ items: [ParcelRow], empty: String? = nil) -> some View {
        if !items.isEmpty || empty != nil {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(title).font(.headline)
                Text("\(items.count)").font(.subheadline).foregroundStyle(.secondary)
            }
            .listRowStyle(top: 20, bottom: 2)
            if items.isEmpty, let empty {
                Text(empty)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .listRowStyle()
            } else {
                ForEach(items) { parcel in
                    card(parcel)
                }
            }
        }
    }

    /// A card: tap opens the detail, a left swipe says it has arrived.
    @ViewBuilder
    private func card(_ parcel: ParcelRow, inBox: Bool = false, lastInBox: Bool = false) -> some View {
        if inBox {
            cardRow(parcel).listRowStyle(bottom: lastInBox ? 22 : 6, horizontal: 32, background: AmberBox(top: false, bottom: lastInBox))
        } else {
            cardRow(parcel).listRowStyle()
        }
    }

    private func cardRow(_ parcel: ParcelRow) -> some View {
        let isSaving = model.saving.contains(parcel.id)
        let isChecking = model.checking.contains(parcel.id)
        return VStack(alignment: .leading, spacing: 4) {
            Button {
                path.append(.parcel(id: parcel.id))
            } label: {
                ParcelCardView(parcel: parcel, today: model.todayJst)
                    .overlay(alignment: .trailing) {
                        if isSaving { SavingBadge(text: isChecking ? "確認中…" : "保存中…") }
                    }
            }
            .buttonStyle(.plain)
            .disabled(isSaving)
            if let message = model.rowMessages[parcel.id] {
                Text(message)
                    .font(.caption)
                    .foregroundStyle(OtodokeColor.errorText)
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if !isSaving {
                // A parcel whose last 「届いた」 is not known yet is only read again, never sent again.
                Button(model.unconfirmed.contains(parcel.id) ? "確かめる" : "届いた") {
                    Task { await model.markDelivered(id: parcel.id) }
                }
                .tint(Palette.emerald)
            }
        }
    }

    private var pageLinks: some View {
        Group {
            PageLinkRow(label: "届いた荷物") { path.append(.delivered) }
                .listRowStyle(top: 20)
            PageLinkRow(label: "キャンセルした荷物") { path.append(.cancelled) }
                .listRowStyle()
        }
    }

    // MARK: toast

    @ViewBuilder
    private var toast: some View {
        if let toast = model.toast {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(toast.text)
                    if let note = model.toastNote {
                        Text(note).font(.caption)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if toast.canUndo {
                    Button {
                        Task { await model.undo() }
                    } label: {
                        HStack(spacing: 6) {
                            if model.isUndoing { ProgressView().tint(Palette.toastAction) }
                            Text(model.isUndoing ? "戻しています…" : "元に戻す")
                        }
                        .fontWeight(.bold)
                        .foregroundStyle(Palette.toastAction)
                        .opacity(model.isUndoing ? 0.6 : 1)
                    }
                    .disabled(model.isUndoing)
                }
            }
            .font(.subheadline)
            .foregroundStyle(.white)
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
}

// MARK: - parts

/// 「保存中…」 over a card whose 「届いた」 is being saved (「確認中…」 while it is only read again).
private struct SavingBadge: View {
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            ProgressView().tint(.white)
            Text(text)
        }
        .font(.subheadline.weight(.bold))
        .foregroundStyle(.white)
        .padding(.horizontal, 16)
        .frame(maxHeight: .infinity)
        .background(Palette.emerald, in: UnevenRoundedRectangle(bottomTrailingRadius: 16, topTrailingRadius: 16))
    }
}

/// The amber box of 要確認 (border-amber-300 bg-amber-50), made of its rows' backgrounds: each row
/// draws its part of the fill and of the border.
private struct AmberBox: View {
    let top: Bool
    let bottom: Bool

    var body: some View {
        ZStack {
            UnevenRoundedRectangle(
                topLeadingRadius: top ? 16 : 0,
                bottomLeadingRadius: bottom ? 16 : 0,
                bottomTrailingRadius: bottom ? 16 : 0,
                topTrailingRadius: top ? 16 : 0,
                style: .circular
            )
            .fill(Palette.amberBackground)
            AmberBoxEdge(top: top, bottom: bottom, radius: 16)
                .stroke(Palette.amberBorder, lineWidth: 1)
        }
        .padding(.horizontal, 16)
        .padding(.top, top ? 6 : 0)
        .padding(.bottom, bottom ? 6 : 0)
    }
}

/// The part of the box's 1-pt border one row draws: both sides always, the top edge on the first row,
/// the bottom edge on the last. The line runs inside the row, so the rows' sides meet end to end.
private struct AmberBoxEdge: Shape {
    let top: Bool
    let bottom: Bool
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        let inset: CGFloat = 0.5
        let minX = rect.minX + inset, maxX = rect.maxX - inset
        let minY = top ? rect.minY + inset : rect.minY
        let maxY = bottom ? rect.maxY - inset : rect.maxY
        let r = max(0, min(radius, (maxX - minX) / 2, (maxY - minY) / ((top && bottom) ? 2 : 1)))
        var p = Path()
        // Left side, upwards; then the top edge and the right side, downwards.
        p.move(to: CGPoint(x: minX, y: bottom ? maxY - r : maxY))
        if top {
            p.addArc(tangent1End: CGPoint(x: minX, y: minY), tangent2End: CGPoint(x: maxX, y: minY), radius: r)
            p.addArc(tangent1End: CGPoint(x: maxX, y: minY), tangent2End: CGPoint(x: maxX, y: maxY), radius: r)
        } else {
            p.addLine(to: CGPoint(x: minX, y: minY))
            p.move(to: CGPoint(x: maxX, y: minY))
        }
        if bottom {
            p.addArc(tangent1End: CGPoint(x: maxX, y: maxY), tangent2End: CGPoint(x: minX, y: maxY), radius: r)
            p.addArc(tangent1End: CGPoint(x: minX, y: maxY), tangent2End: CGPoint(x: minX, y: minY), radius: r)
            if top { p.closeSubpath() }
        } else {
            p.addLine(to: CGPoint(x: maxX, y: maxY))
        }
        return p
    }
}

/// The screen with no parcel yet (EmptyState).
private struct EmptyParcels: View {
    let guide: EmptyGuide
    let open: (EmptyDestination) -> Void
    let openDemo: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Text("📬").font(.system(size: 48))
            Text("まだ荷物がありません")
                .font(.title3.bold())
                .padding(.top, 16)
            Text(verbatim: "\(guide.first)\n\(guide.second)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(4)
                .padding(.top, 8)
            Button { open(guide.destination) } label: {
                Text(guide.button)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color(.systemBackground))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.primary, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain)
            .padding(.top, 24)
            Button(action: openDemo) {
                Text("サンプルで試す")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.separator)))
            }
            .buttonStyle(.plain)
            .padding(.top, 12)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 64)
    }
}

/// The screens of the second batch: a title and nothing else yet.
struct PlaceholderScreen: View {
    let title: String

    var body: some View {
        Color.clear
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
    }
}

/// The Web's Tailwind colours this screen uses, with a dark-mode pair.
enum Palette {
    /// emerald-600
    static let emerald = OtodokeColor.hex("#059669")
    /// emerald-700 (text-emerald-700)
    static let emeraldText = OtodokeColor.adaptive(light: "#047857", dark: "#34d399")
    /// amber-50 / border amber-300 / text amber-900
    static let amberBackground = OtodokeColor.adaptive(light: "#fffbeb", dark: "#3a2a0a")
    static let amberBorder = OtodokeColor.adaptive(light: "#fcd34d", dark: "#92400e")
    static let amberText = OtodokeColor.adaptive(light: "#78350f", dark: "#fcd34d")
    /// red-50 / red-200
    static let errorBackground = OtodokeColor.adaptive(light: "#fef2f2", dark: "#3b0d0d")
    static let errorBorder = OtodokeColor.adaptive(light: "#fecaca", dark: "#7f1d1d")
    /// neutral-900 / emerald-300 (the toast)
    static let toastBackground = OtodokeColor.hex("#171717")
    static let toastAction = OtodokeColor.hex("#6ee7b7")
}

private extension View {
    /// A list row with no separator and no background of its own, inset like the Web's page.
    func listRowStyle(top: CGFloat = 6, bottom: CGFloat = 6, horizontal: CGFloat = 16) -> some View {
        listRowStyle(top: top, bottom: bottom, horizontal: horizontal, background: Color.clear)
    }

    func listRowStyle<B: View>(top: CGFloat = 6, bottom: CGFloat = 6, horizontal: CGFloat = 16, background: B) -> some View {
        listRowInsets(EdgeInsets(top: top, leading: horizontal, bottom: bottom, trailing: horizontal))
            .listRowSeparator(.hidden)
            .listRowBackground(background)
    }
}
