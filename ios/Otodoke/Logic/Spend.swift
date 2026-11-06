// TDD-STUB(task 5) — agreed API, placeholder bodies. Remove this marker once written.
// Port of src/lib/spend.ts (tickLabel moved there from month-bars.tsx by task 4).

import Foundation

enum Spend {
    struct Total: Equatable, Sendable {
        let total: Int
        let priced: Int
        let unpriced: Int
    }

    /// One row of 分類ごと: nil is 未分類.
    struct CategoryAmount: Equatable, Sendable {
        let category: ParcelCategory?
        let amount: Int
        let share: Double
    }

    struct Segment: Equatable, Sendable {
        let category: ParcelCategory?
        let amount: Int
    }

    /// One bar: an order month ("YYYY-MM").
    struct MonthBar: Equatable, Sendable {
        let month: String
        let total: Int
        let segments: [Segment]
    }

    /// spendSlices: what the category and shop filters narrow.
    struct Slices: Equatable, Sendable {
        let picked: [ParcelRow]
        let orders: [ParcelRow]
        let byCategory: [ParcelRow]
        let byShop: [ParcelRow]
        let undated: Int
    }

    /// MAX_FILLED_MONTHS
    static let maxFilledMonths = 0

    static func spendMonthParam(_ m: String?, today: String) -> String { "" }

    static func total(_ parcels: [ParcelRow]) -> Total { Total(total: -1, priced: -1, unpriced: -1) }

    /// categoryOf: one of the seven, else nil (未分類).
    static func categoryOf(_ raw: String?) -> ParcelCategory? { nil }

    static func byCategory(_ parcels: [ParcelRow]) -> [CategoryAmount] { [] }

    static func sharePercent(_ share: Double) -> String { "" }

    static func byMonth(_ parcels: [ParcelRow]) -> [MonthBar] { [] }

    static func withEmptyMonths(_ months: [MonthBar]) -> [MonthBar] { [] }

    static func axisTicks(_ max: Double) -> [Double] { [] }

    /// tickLabel: 「5万」「1.2万」「8,000」.
    static func tickLabel(_ v: Double) -> String { "" }

    static func slices(_ parcels: [ParcelRow], all: Bool, category: CategoryFilter, shop: String?) -> Slices {
        Slices(picked: [], orders: [], byCategory: [], byShop: [], undated: -1)
    }

    /// groupByOrderMonth of src/lib/delivered.ts (the spend screen's order list over the whole
    /// period): newest order month first as 「2026年5月に注文」, newest order date first inside,
    /// then the parcels with no order date under 「注文日不明」. Its parity cases come with T13.
    static func groupByOrderMonth(_ parcels: [ParcelRow]) -> [(label: String, parcels: [ParcelRow])] { [] }
}
