// The view model of SpendView (src/app/app/spend/, 2541793). Each move (period, month, category,
// shop) reads again `user_id = me and status != cancelled` (every row, keyset by id) as the Web's
// navigation does, one move at a time; a month is the parcels ordered in it (ordered_at between the
// 1st and the last day, as text), in the Web's order (ordered_at ↓ nulls last, id ↑). The figures
// come from Spend (checked against the Web).
// The category chip writes through ParcelWriter.setCategory(_:category:) on the version shown; the
// writer publishes 「古くなった」 (the model never does).

import Foundation
import Observation

enum SpendPeriod: Equatable, Sendable {
    case month(String)
    case all
}

enum SpendMove: Equatable, Sendable {
    case period(SpendPeriod)
    case category(CategoryFilter)
    case shop(String?)
}

struct ShopAmount: Equatable, Sendable {
    let name: String
    let amount: Int
}

@MainActor
@Observable
final class SpendModel {
    static let failedText = "読み込めませんでした"
    static let categoryFailed = "保存できませんでした"

    let reader: ParcelReader
    let writer: ParcelWriter

    private(set) var period: SpendPeriod
    private(set) var category: CategoryFilter = .any
    private(set) var shop: String?
    /// nil until the first read ends.
    private(set) var parcels: LoadResult<[ParcelRow]>?
    /// The move being read; others are refused meanwhile.
    private(set) var pendingMove: SpendMove?
    /// Ids whose category is being saved.
    private(set) var savingCategory: Set<String> = []
    /// Per-order message after a failed save (「保存できませんでした」).
    private(set) var categoryErrors: [String: String] = [:]

    /// What the screen shows: the period and the two filters (the Web's `?m=&c=&s=`).
    private struct Conditions: Equatable {
        var period: SpendPeriod
        var category: CategoryFilter
        var shop: String?

        /// [Codex #4] Shop names compared on UTF-16 units, as the Web and Spend.slices compare them
        /// (not Swift's canonical equivalence).
        static func == (l: Conditions, r: Conditions) -> Bool {
            guard l.period == r.period, l.category == r.category else { return false }
            switch (l.shop, r.shop) {
            case (nil, nil): return true
            case let (a?, b?): return JSText.equal(a, b)
            default: return false
            }
        }
    }

    @ObservationIgnored private let today: @Sendable () -> String
    @ObservationIgnored private let mark: ChangeMark
    @ObservationIgnored private var fence = ReadFence()
    /// A read that came back while a save was on the way: read again once the saves end.
    @ObservationIgnored private var readAfterWrites: Conditions?
    /// [Codex #3] The move's read came back while a save was on the way: the move stays pending (dimmed,
    /// and load() leaves it alone) until the read after the save shows it.
    @ObservationIgnored private var moveWaitsForSave = false
    /// [S1] The last read was cut off (its .task cancelled): the next appearance reads again.
    @ObservationIgnored private var wasCutOff = false
    /// [CX-f2] The newest read's: raised as soon as its task is cancelled, before the read ends.
    @ObservationIgnored private var cutOff: CutOffSignal?

    init(reader: ParcelReader, writer: ParcelWriter, changes: DataChanges?, today: @escaping @Sendable () -> String) {
        self.reader = reader
        self.writer = writer
        self.today = today
        mark = ChangeMark(changes)
        period = .month(Format.monthOf(today()))
    }

    private var conditions: Conditions {
        Conditions(period: period, category: category, shop: shop)
    }

    private var isAll: Bool { period == .all }

    /// The results are shown faded while a move is on the way.
    var isDimmed: Bool { pendingMove != nil }
    /// [S-new1] The chips are disabled (and setCategory refused) while a move is on the way: a save
    /// that ended in conflict or unknown would read the conditions from before the move.
    var categoryLocked: Bool { pendingMove != nil }
    var bounds: MonthBounds { MonthBounds(today: today()) }
    /// Today's month (the 「月」 of the period switch).
    var thisMonth: String { Format.monthOf(today()) }
    /// The day the figures are shown on (the month's name in 「11月」 / 「2025年11月」).
    var todayText: String { today() }

    var slices: Spend.Slices? {
        parcels?.value.map { Spend.slices($0, all: isAll, category: category, shop: shop) }
    }

    var total: Spend.Total? { slices.map { Spend.total($0.picked) } }
    var categoryRows: [Spend.CategoryAmount] { slices.map { Spend.byCategory($0.byCategory) } ?? [] }

    /// 店ごと: the amounts read, by normalizeShop, largest first (ties in the order first met).
    var shopRows: [ShopAmount] {
        guard let slices else { return [] }
        // [Codex #4] Keyed by UTF-16 units, as the Web's Map: canonically equivalent names stay two shops.
        var names: [String] = []
        var sums: [[UInt16]: Int] = [:]
        for p in slices.byShop {
            guard let amount = p.totalAmount else { continue }
            let name = Shop.normalizeShop(p)
            let key = Array(name.utf16)
            if sums[key] == nil { names.append(name) }
            sums[key, default: 0] += amount
        }
        return names.enumerated()
            .map { (offset: $0.offset, row: ShopAmount(name: $0.element, amount: sums[Array($0.element.utf16)] ?? 0)) }
            .sorted { l, r in l.row.amount != r.row.amount ? l.row.amount > r.row.amount : l.offset < r.offset }
            .map(\.row)
    }

    /// The whole period only: withEmptyMonths(byMonth(picked)).
    var bars: [Spend.MonthBar] {
        guard isAll, let slices else { return [] }
        return Spend.withEmptyMonths(Spend.byMonth(slices.picked))
    }

    var orders: [ParcelRow] { slices?.orders ?? [] }

    /// The whole period: groupByOrderMonth(orders); a month: one group with an empty label.
    var orderGroups: [(label: String, parcels: [ParcelRow])] {
        let orders = orders
        if orders.isEmpty { return [] }
        return isAll ? Spend.groupByOrderMonth(orders) : [(label: "", parcels: orders)]
    }

    private var isNarrowed: Bool { category != .any || shop != nil }

    /// The conditions' names, category first: 「食費」「テスト店」 (the shop cut for showing only).
    private var conditionLabels: [String] {
        var labels: [String] = []
        switch category {
        case .any: break
        case .uncategorized: labels.append(ParcelCategory.uncategorizedLabel)
        case let .only(c): labels.append(c.label)
        }
        if let shop { labels.append(Shop.shopLabel(shop)) }
        return labels
    }

    /// 「ネット注文の合計」 or 「食費・テスト店の合計」.
    var totalCaption: String {
        isNarrowed ? "\(conditionLabels.joined(separator: "・"))の合計" : "ネット注文の合計"
    }

    /// 「3 件（ほかに金額を読み取れなかった注文が 1 件）（注文日の無い 2 件は除く）」
    var countCaption: String {
        guard let total, let slices else { return "" }
        var text = "\(total.priced) 件"
        if total.unpriced > 0 { text += "（ほかに金額を読み取れなかった注文が \(total.unpriced) 件）" }
        if slices.undated > 0 { text += "（注文日の無い \(slices.undated) 件は除く）" }
        return text
    }

    /// 「この条件の注文はありません」 / 「注文はありません」 / 「この月の注文はありません」
    var ordersEmptyText: String {
        isNarrowed ? "この条件の注文はありません" : isAll ? "注文はありません" : "この月の注文はありません"
    }

    /// The chips beside 注文, category first: 「食費だけ」「テスト店だけ」 (shop through shopLabel).
    var chips: [String] { conditionLabels.map { "\($0)だけ" } }

    // MARK: moves

    func load() async {
        // A move on the way reads the newer conditions anyway.
        guard pendingMove == nil else { return }
        await read(conditions)
    }

    /// 全期間 (the category filter is left behind, as the Web's link does; the shop stays).
    func showAll() async {
        await go(.period(.all), Conditions(period: .all, category: .any, shop: shop))
    }

    /// 月 of the period switch: this month (the category filter is left behind; the shop stays).
    func showThisMonth() async {
        let ym = thisMonth
        await go(.period(.month(ym)), Conditions(period: .month(ym), category: .any, shop: shop))
    }

    /// A month (also a tap on a bar): both filters stay.
    func showMonth(_ ym: String) async {
        guard bounds.contains(ym) else { return }
        await go(.period(.month(ym)), Conditions(period: .month(ym), category: category, shop: shop))
    }

    func shiftMonth(_ delta: Int) async {
        guard case let .month(ym) = period else { return }
        await showMonth(Format.shiftMonth(ym, delta))
    }

    /// A row of 分類ごと: narrows to it, or takes it off when it is the one selected. nil is 未分類.
    func toggleCategory(_ c: ParcelCategory?) async {
        let filter = c.map(CategoryFilter.only) ?? .uncategorized
        let next: CategoryFilter = category == filter ? .any : filter
        await go(.category(next), Conditions(period: period, category: next, shop: shop))
    }

    func toggleShop(_ name: String) async {
        let same = shop.map { JSText.equal($0, name) } ?? false
        let next: String? = name.isEmpty || same ? nil : name
        await go(.shop(next), Conditions(period: period, category: category, shop: next))
    }

    /// The chips' 「×」.
    func clearCategory() async {
        await go(.category(.any), Conditions(period: period, category: .any, shop: shop))
    }

    func clearShop() async {
        await go(.shop(nil), Conditions(period: period, category: category, shop: nil))
    }

    /// The chip of an order: written on the version shown. Success: that version is kept and the
    /// figures worked out again. Conflict or unknown: read again (never sent again). Failed: the old
    /// category stays, with categoryFailed.
    func setCategory(parcelID id: String, to chosen: ParcelCategory) async {
        guard !categoryLocked, !savingCategory.contains(id), let row = parcels?.value?.first(where: { $0.id == id }) else { return }
        savingCategory.insert(id)
        categoryErrors[id] = nil
        fence.beginWrite()
        let result = await writer.setCategory(ParcelVersion(row), category: chosen)
        savingCategory.remove(id)
        var readAgain = false
        switch result {
        case let .success(after):
            if case var .loaded(rows)? = parcels, let i = rows.firstIndex(where: { $0.id == id }) {
                rows[i].category = chosen.rawValue
                rows[i].categorySource = "user"
                rows[i].status = after.status
                rows[i].updatedAt = after.updatedAt
                parcels = .loaded(rows)
            }
        case .unknown, .notUpdated(.conflict):
            readAgain = true
        case .notUpdated:
            categoryErrors[id] = Self.categoryFailed
        }
        fence.endWrite()
        guard fence.writesInFlight == 0 else {
            if readAgain, readAfterWrites == nil { readAfterWrites = conditions }
            return
        }
        // A move on the way read before this save ended: its read is stale and reads again itself.
        guard pendingMove == nil || moveWaitsForSave else { return }
        // A move waiting for the save: readAfterWrites is its target (newer than what is shown).
        if let target = readAfterWrites ?? (readAgain ? conditions : nil) {
            await read(target)
        }
        // [Codex #3] The move is shown (or dropped): it is over, unless a newer save holds it again.
        if moveWaitsForSave, readAfterWrites == nil {
            moveWaitsForSave = false
            pendingMove = nil
        }
    }

    func onAppear() async {
        if parcels == nil || parcels == .failed || mark.isStale || wasCutOff || cutOff?.isRaised == true { await load() }
    }

    func sceneBecameActive() async {
        await load()
    }

    // MARK: reading

    /// One move at a time; a move to what is already shown reads nothing.
    private func go(_ move: SpendMove, _ target: Conditions) async {
        guard pendingMove == nil, target != conditions else { return }
        pendingMove = move
        await read(target)
        // [Codex #3] Its read came back while a save was on the way: the move stays pending (dimmed)
        // until the read after the save (setCategory) shows it; a load() meanwhile does not undo it.
        if readAfterWrites != nil {
            moveWaitsForSave = true
        } else {
            pendingMove = nil
        }
    }

    /// Reads for `target` and shows it with the result, unless a newer read began meanwhile. A read
    /// that a save overlapped is read again (once the saves end).
    private func read(_ target: Conditions) async {
        readAfterWrites = nil
        while true {
            let ticket = fence.beginRead()
            let signal = CutOffSignal()
            cutOff = signal
            mark.markRead()
            let reader = self.reader
            let result = await withTaskCancellationHandler {
                await reader.allParcels(excludingCancelled: true)
            } onCancel: {
                signal.raise()
            }
            let verdict = fence.verdict(ticket)
            // [N-new2] A newer read began: it owns the state (this one being cut off changes nothing).
            if verdict == .superseded { return }
            // [S1] Cut off (the .task cancelled when the tab is left): dropped, not shown as a failure.
            if Task.isCancelled {
                wasCutOff = true
                return
            }
            switch verdict {
            case .superseded:
                return
            case .current:
                wasCutOff = false
                period = target.period
                category = target.category
                shop = target.shop
                switch result {
                case .failed: parcels = .failed
                case let .loaded(rows): parcels = .loaded(Self.rows(rows, for: target.period))
                }
                return
            case .stale:
                if fence.writesInFlight > 0 {
                    readAfterWrites = target
                    return
                }
                // A save came and went while reading: read again.
            }
        }
    }

    /// What the Web reads for the period: a month is ordered_at from the 1st to the last day (as
    /// text); ordered_at ↓ nulls last, then id ↑.
    private static func rows(_ rows: [ParcelRow], for period: SpendPeriod) -> [ParcelRow] {
        var picked = rows
        if case let .month(ym) = period {
            let parts = ym.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
            let y = parts.first.flatMap(JSNumber.integer) ?? 0
            let m = parts.count > 1 ? (JSNumber.integer(parts[1]) ?? 0) : 0
            let first = "\(ym)-01", last = "\(ym)-\(JSText.pad(Format.daysInMonth(y, m), 2))"
            picked = rows.filter { p in
                guard let at = p.orderedAt else { return false }
                return !JSText.less(at, first) && !JSText.less(last, at)
            }
        }
        return picked.sorted { a, b in
            switch (a.orderedAt, b.orderedAt) {
            case let (x?, y?) where !JSText.equal(x, y): return JSText.less(y, x)
            case (nil, _?): return false
            case (_?, nil): return true
            default: return JSText.less(a.id.lowercased(), b.id.lowercased())
            }
        }
    }
}
