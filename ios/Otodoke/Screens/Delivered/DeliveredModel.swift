// The view model of DeliveredView (src/app/app/delivered/page.tsx + filter-form.tsx, 2541793).
// Both reads (the parcels and the item names) at once; either failing is 「読み込めませんでした」. The search
// word, the shop, the category and the month ("" = all, as the page's values) narrow through
// Delivered.filterDelivered; the results are grouped by Delivered.groupByOrderMonth. Old reads are dropped
// through ReadFence; 「古くなった」 (DataChanges) and coming back to the front read again.

import Foundation
import Observation

@MainActor
@Observable
final class DeliveredModel {
    static let title = "届いた荷物"
    static let failedText = "読み込めませんでした"
    static let emptyText = "届いた荷物はありません"
    static let noMatchText = "見つかりません"
    static let searchPlaceholder = "品名・店名"
    static let clearText = "クリア"
    static let allShops = "すべての店"
    static let allCategories = "すべての分類"
    static let allMonths = "すべての月"

    let reader: StatusListReader

    private(set) var parcels: LoadResult<[ParcelRow]>?
    private(set) var items: LoadResult<[ParcelItemName]>?
    /// A read is on the way (the first one, or one again with the old results on screen).
    private(set) var isLoading = false

    /// The search box as typed; the filter takes Delivered.searchWord of it.
    var query = ""
    var shop = ""
    var category = ""
    var month = ""

    @ObservationIgnored let changes: DataChanges?
    @ObservationIgnored private var fence = ReadFence()
    @ObservationIgnored private let mark: ChangeMark
    /// Moves on each time a read's results are taken.
    @ObservationIgnored private var resultNumber = 0
    /// filterDelivered of the last values asked for (the view reads `shown` several times a frame).
    @ObservationIgnored private var memo: (result: Int, values: DeliveredFilterValues, rows: [ParcelRow])?

    init(reader: StatusListReader, changes: DataChanges?) {
        self.reader = reader
        self.changes = changes
        mark = ChangeMark(changes)
    }

    /// The values the filter is called with (query, shop, category, month; "" as given).
    var values: DeliveredFilterValues {
        DeliveredFilterValues(q: query, s: shop, c: category, m: month)
    }

    /// filterDelivered of what was read; nil before a read or when a read failed.
    var shown: [ParcelRow]? {
        guard case let .loaded(rows)? = parcels, case let .loaded(names)? = items else { return nil }
        let values = self.values
        if let memo, memo.result == resultNumber, memo.values == values { return memo.rows }
        let result = Delivered.filterDelivered(rows, itemNames: Delivered.itemNamesByParcel(names), values: values)
        memo = (resultNumber, values, result)
        return result
    }

    var groups: [(label: String, parcels: [ParcelRow])] {
        shown.map(Delivered.groupByOrderMonth) ?? []
    }

    /// deliveredFilterOptions of every delivered parcel read.
    var options: DeliveredFilterOptions? {
        guard case let .loaded(rows)? = parcels else { return nil }
        return Delivered.deliveredFilterOptions(rows)
    }

    /// monthChoices(options.months, month).
    var monthOptions: [String] {
        guard let options else { return [] }
        return Delivered.monthChoices(options.months, m: month)
    }

    /// Some value is set (「クリア」 shows). The word counts as the Web counts it: trimmed.
    var isNarrowed: Bool {
        !Delivered.searchWord(query).isEmpty || !shop.isEmpty || !category.isEmpty || !month.isEmpty
    }

    /// The number by the heading (shown.count); nil when not read or failed.
    var count: Int? {
        shown?.count
    }

    /// 読み込めませんでした / 届いた荷物はありません / 見つかりません, or nil when there are results.
    var message: String? {
        if parcels == .failed || items == .failed { return Self.failedText }
        guard case let .loaded(rows)? = parcels, let shown else { return nil }
        if rows.isEmpty { return Self.emptyText }
        return shown.isEmpty ? Self.noMatchText : nil
    }

    func clear() {
        query = ""
        shop = ""
        category = ""
        month = ""
    }

    func load() async {
        let ticket = fence.beginRead()
        mark.markRead()
        isLoading = true
        async let readParcels = reader.parcels(.delivered)
        async let readItems = reader.itemNames()
        let (p, i) = await (readParcels, readItems)
        // A newer read was started meanwhile: this one is older than what it would replace.
        guard fence.verdict(ticket) == .current else { return }
        resultNumber &+= 1
        parcels = p
        items = i
        isLoading = false
    }

    /// Shown: reads the first time, and again when DataChanges moved since the last read.
    func onAppear() async {
        guard parcels == nil || mark.isStale else { return }
        await load()
    }

    /// iOS-12: back in front.
    func sceneBecameActive() async {
        await load()
    }
}
