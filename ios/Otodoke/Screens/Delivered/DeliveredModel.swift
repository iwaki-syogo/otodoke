// TDD-STUB(task 21): the view model of DeliveredView (src/app/app/delivered/page.tsx + filter-form.tsx, 2541793).
// Both reads (the parcels and the item names) at once; either failing is 「読み込めませんでした」. The search
// word, the shop, the category and the month ("" = all, as the page's values) narrow through
// Delivered.filterDelivered; the results are grouped by Delivered.groupByOrderMonth. Old reads are dropped
// through ReadFence; 「古くなった」 (DataChanges) and coming back to the front read again.
// Names and signatures are the contract with StatusListsTests.

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

    /// The search box as typed; the filter takes Delivered.searchWord of it.
    var query = ""
    var shop = ""
    var category = ""
    var month = ""

    @ObservationIgnored let changes: DataChanges?

    init(reader: StatusListReader, changes: DataChanges?) {
        self.reader = reader
        self.changes = changes
    }

    /// The values the filter is called with (query, shop, category, month; "" as given).
    var values: DeliveredFilterValues {
        DeliveredFilterValues() // TDD-STUB(task 21)
    }

    /// filterDelivered of what was read; nil before a read or when a read failed.
    var shown: [ParcelRow]? {
        nil // TDD-STUB(task 21)
    }

    var groups: [(label: String, parcels: [ParcelRow])] {
        [] // TDD-STUB(task 21)
    }

    /// deliveredFilterOptions of every delivered parcel read.
    var options: DeliveredFilterOptions? {
        nil // TDD-STUB(task 21)
    }

    /// monthChoices(options.months, month).
    var monthOptions: [String] {
        [] // TDD-STUB(task 21)
    }

    /// Some value is set (「クリア」 shows).
    var isNarrowed: Bool {
        false // TDD-STUB(task 21)
    }

    /// The number by the heading (shown.count); nil when not read or failed.
    var count: Int? {
        nil // TDD-STUB(task 21)
    }

    /// 読み込めませんでした / 届いた荷物はありません / 見つかりません, or nil when there are results.
    var message: String? {
        nil // TDD-STUB(task 21)
    }

    func clear() {
        // TDD-STUB(task 21)
    }

    func load() async {
        // TDD-STUB(task 21)
    }

    /// Shown: reads the first time, and again when DataChanges moved since the last read.
    func onAppear() async {
        // TDD-STUB(task 21)
    }

    /// iOS-12: back in front.
    func sceneBecameActive() async {
        // TDD-STUB(task 21)
    }
}
