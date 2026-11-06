// The 支出 tab (src/app/app/spend/page.tsx, 2541793): 月 / 全期間, the month (「‹ 前月」 / the wheel /
// 「翌月 ›」) or 「全期間」, the total with its notes, the bars over the whole period, 分類ごと and 店ごと
// (tap to narrow, again to take it off), and the orders with the chips of the conditions. One move at
// a time: the pressed control shows a spinner and the results are faded until the new ones arrive.

import SwiftUI

/// Where the 支出 tab navigates.
enum SpendRoute: Hashable {
    case parcel(id: String)
}

struct SpendView<Detail: View>: View {
    @Bindable var model: SpendModel
    /// The detail screen of a parcel.
    @ViewBuilder let detail: (String) -> Detail

    @State private var path: [SpendRoute] = []
    /// What was pressed for the move on the way (its spinner).
    @State private var pressed: String?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    periodSwitch
                    header
                    content
                }
                .padding(16)
            }
            .refreshableToTheEnd { await model.load() }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("支出")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: SpendRoute.self) { route in
                switch route {
                case let .parcel(id): detail(id)
                }
            }
        }
        .task { await model.onAppear() }
        .onChange(of: model.pendingMove == nil) { _, idle in
            if idle { pressed = nil }
        }
    }

    private var isMoving: Bool { model.pendingMove != nil }

    private func press(_ key: String, _ move: @escaping @MainActor () async -> Void) {
        guard !isMoving else { return }
        pressed = key
        Task { await move() }
    }

    @ViewBuilder
    private func spinner(_ key: String) -> some View {
        if SpendSpinner.shows(pressed: pressed, key: key, isMoving: isMoving) {
            ProgressView().controlSize(.mini)
        }
    }

    // MARK: the period and the month

    private var periodSwitch: some View {
        let all = model.period == .all
        return HStack(spacing: 0) {
            periodButton("月", key: "period-month", selected: !all) { await model.showThisMonth() }
            periodButton("全期間", key: "period-all", selected: all) { await model.showAll() }
        }
        .padding(4)
        .background(Color(.systemGray6), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("期間")
    }

    private func periodButton(_ title: String, key: String, selected: Bool, _ move: @escaping @MainActor () async -> Void) -> some View {
        Button {
            press(key, move)
        } label: {
            HStack(spacing: 6) {
                spinner(key)
                Text(title)
            }
            .font(.subheadline.weight(selected ? .bold : .regular))
            .foregroundStyle(selected ? .primary : .secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(selected ? Color(.systemBackground) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
            .shadow(color: selected ? .black.opacity(0.06) : .clear, radius: 1, y: 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isMoving)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private var header: some View {
        switch model.period {
        case .all:
            Text("全期間")
                .font(.headline)
                .frame(maxWidth: .infinity)
        case let .month(ym):
            MonthPicker(month: ym, today: model.todayText, bounds: model.bounds, isMoving: isMoving) { target in
                Task { await model.showMonth(target) }
            }
        }
    }

    // MARK: the results

    @ViewBuilder
    private var content: some View {
        switch model.parcels {
        case nil:
            ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
        case .failed?:
            Text(SpendModel.failedText)
                .font(.subheadline)
                .foregroundStyle(OtodokeColor.errorText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Palette.errorBackground, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.errorBorder))
        case .loaded?:
            VStack(alignment: .leading, spacing: 24) {
                totalCard
                if model.period == .all {
                    SpendBarsView(months: model.bars, isMoving: isMoving) { ym in
                        press("bar-\(ym)") { await model.showMonth(ym) }
                    }
                }
                categories
                shops
                ordersSection
            }
            .opacity(model.isDimmed ? 0.5 : 1)
            .accessibilityElement(children: .contain)
        }
    }

    private var totalCard: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(model.totalCaption)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(Format.yen(model.total?.total ?? 0))
                .font(.system(size: 36, weight: .bold).monospacedDigit())
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            Text(model.countCaption)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator).opacity(0.6)))
    }

    @ViewBuilder
    private var categories: some View {
        let rows = model.categoryRows
        if !rows.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                Text("分類ごと").font(.headline)
                VStack(spacing: 4) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                        categoryRow(r)
                    }
                }
            }
        }
    }

    private func categoryRow(_ r: Spend.CategoryAmount) -> some View {
        let filter = r.category.map(CategoryFilter.only) ?? .uncategorized
        let selected = model.category != .any && model.category == filter
        let key = "category-\(r.category?.rawValue ?? "none")"
        let color = SpendColor.of(r.category)
        return Button {
            press(key) { await model.toggleCategory(r.category) }
        } label: {
            VStack(spacing: 6) {
                HStack(spacing: 8) {
                    if SpendSpinner.shows(pressed: pressed, key: key, isMoving: isMoving) {
                        ProgressView().controlSize(.mini).frame(width: 10, height: 10)
                    } else {
                        Circle().fill(color).frame(width: 10, height: 10)
                    }
                    Text(ParcelCategory.label(for: r.category?.rawValue))
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(Format.yen(r.amount))
                        .font(.subheadline.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Text(Spend.sharePercent(r.share))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .frame(width: 40, alignment: .trailing)
                }
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color(.systemGray6))
                        Capsule().fill(color)
                            .frame(width: r.amount > 0 ? g.size.width * max(0.02, r.share) : 0)
                    }
                }
                .frame(height: 8)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(selected ? Color(.systemGray6) : Color.clear, in: RoundedRectangle(cornerRadius: 12))
            .opacity(model.category != .any && !selected ? 0.5 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isMoving)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder
    private var shops: some View {
        let rows = model.shopRows
        if !rows.isEmpty {
            let top = max(rows.first?.amount ?? 1, 1)
            VStack(alignment: .leading, spacing: 8) {
                Text("店ごと").font(.subheadline.bold()).foregroundStyle(.secondary)
                VStack(spacing: 4) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, r in
                        shopRow(r, top: top)
                    }
                }
            }
        }
    }

    private func shopRow(_ r: ShopAmount, top: Int) -> some View {
        let selected = model.shop.map { JSText.equal($0, r.name) } ?? false
        let key = "shop-\(r.name)"
        return Button {
            press(key) { await model.toggleShop(r.name) }
        } label: {
            VStack(spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    Text(r.name)
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 6) {
                        spinner(key)
                        Text(Format.yen(r.amount)).monospacedDigit()
                    }
                    .foregroundStyle(.secondary)
                }
                .font(.caption)
                GeometryReader { g in
                    ZStack(alignment: .leading) {
                        Capsule().fill(Color(.systemGray6))
                        Capsule().fill(Color(.systemGray2))
                            .frame(width: g.size.width * max(0.02, (Double(r.amount) / Double(top) * 100).rounded() / 100))
                    }
                }
                .frame(height: 4)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(selected ? Color(.systemGray6) : Color.clear, in: RoundedRectangle(cornerRadius: 12))
            .opacity(model.shop != nil && !selected ? 0.5 : 1)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isMoving)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var ordersSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            WrappingRow(spacing: 12, lineSpacing: 4) {
                Text("注文").font(.headline)
                if model.category != .any, let label = model.chips.first {
                    chip(label, key: "chip-category") { await model.clearCategory() }
                }
                if model.shop != nil, let label = model.chips.last {
                    chip(label, key: "chip-shop") { await model.clearShop() }
                }
            }
            if model.orders.isEmpty {
                Text(model.ordersEmptyText)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                SpendOrderList(model: model) { id in path.append(.parcel(id: id)) }
            }
        }
    }

    /// 「◯◯だけ ×」: takes its own condition off and keeps the other.
    private func chip(_ label: String, key: String, _ move: @escaping @MainActor () async -> Void) -> some View {
        Button {
            press(key, move)
        } label: {
            HStack(spacing: 4) {
                Text(label).lineLimit(1).underline()
                if SpendSpinner.shows(pressed: pressed, key: key, isMoving: isMoving) {
                    ProgressView().controlSize(.mini)
                } else {
                    Text("×")
                }
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .buttonStyle(.plain)
        .disabled(isMoving)
        .accessibilityLabel("\(label)（外す）")
    }
}

/// [N-new1] The pressed control's spinner: keys compared on UTF-16 units (JSText.equal), as the shop
/// rows are keyed (Codex #4), so two canonically equivalent shop names do not both spin.
enum SpendSpinner {
    static func shows(pressed: String?, key: String, isMoving: Bool) -> Bool {
        guard isMoving, let pressed else { return false }
        return JSText.equal(pressed, key)
    }
}
