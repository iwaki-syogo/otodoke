// Port of src/lib/spend.ts (2541793; tickLabel moved there from month-bars.tsx by task 4) and
// groupByOrderMonth of src/lib/delivered.ts. Only parcels whose amount was read count toward money.

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

    /// MAX_FILLED_MONTHS: the longest run of months the bars fill in.
    static let maxFilledMonths = 240

    /// The fixed order categories stack and list in when amounts tie: the seven, then 未分類 (nil).
    private static let order: [ParcelCategory?] = ParcelCategory.allCases.map { $0 } + [nil]

    /// The month a `?m=` names: "YYYY-MM" with a month of 01 to 12, else this month.
    static func spendMonthParam(_ m: String?, today: String) -> String {
        Format.monthParam(m, today: today)
    }

    /// The total card: the sum of the amounts read, how many had one, and how many did not.
    static func total(_ parcels: [ParcelRow]) -> Total {
        let priced = parcels.filter { $0.totalAmount != nil }
        return Total(total: priced.reduce(0) { $0 + ($1.totalAmount ?? 0) }, priced: priced.count, unpriced: parcels.count - priced.count)
    }

    /// categoryOf: one of the seven, else nil (未分類).
    static func categoryOf(_ raw: String?) -> ParcelCategory? {
        guard let raw else { return nil }
        return ParcelCategory.allCases.first { JSText.equal($0.rawValue, raw) }
    }

    private static func sumByCategory(_ parcels: [ParcelRow]) -> [ParcelCategory?: Int] {
        var sums: [ParcelCategory?: Int] = [:]
        for p in parcels {
            guard let amount = p.totalAmount else { continue }
            sums[categoryOf(p.category), default: 0] += amount
        }
        return sums
    }

    /// Each category's amount and share of the total, largest first (ties in the fixed order).
    static func byCategory(_ parcels: [ParcelRow]) -> [CategoryAmount] {
        let sums = sumByCategory(parcels)
        let total = sums.values.reduce(0, +)
        let rows = order.filter { sums[$0] != nil }.map { category -> CategoryAmount in
            let amount = sums[category] ?? 0
            return CategoryAmount(category: category, amount: amount, share: total > 0 ? Double(amount) / Double(total) : 0)
        }
        // Array.prototype.sort is stable: equal amounts keep the fixed order.
        return rows.enumerated()
            .sorted { l, r in l.element.amount != r.element.amount ? l.element.amount > r.element.amount : l.offset < r.offset }
            .map(\.element)
    }

    /// A share (0..1) as a whole percent; a share above 0 that would round to 0 reads "<1%".
    static func sharePercent(_ share: Double) -> String {
        if !(share > 0) { return "0%" }
        // Math.round: the nearest integer, a half going up (the share is positive here).
        let percent = (share * 100).rounded(.toNearestOrAwayFromZero)
        return percent == 0 ? "<1%" : "\(Int(percent))%"
    }

    /// `/^\d{4}-\d{2}/` on the text (ASCII digits).
    private static func startsWithYearMonth(_ s: String?) -> Bool {
        guard let s else { return false }
        let u = Array(s.utf16.prefix(7))
        guard u.count == 7, u[4] == 0x2D else { return false }
        return [0, 1, 2, 3, 5, 6].allSatisfy { (0x30...0x39).contains(u[$0]) }
    }

    /// One bar per order month, oldest first, stacked by category in the fixed order. Parcels with no
    /// order date or no amount are not on the bars.
    static func byMonth(_ parcels: [ParcelRow]) -> [MonthBar] {
        var months: [String] = []
        var byMonth: [String: [ParcelRow]] = [:]
        for p in parcels {
            guard p.totalAmount != nil, startsWithYearMonth(p.orderedAt), let at = p.orderedAt else { continue }
            let month = JSText.slice(at, 0, 7)
            if byMonth[month] == nil { months.append(month) }
            byMonth[month, default: []].append(p)
        }
        return months.sorted(by: JSText.less).map { month in
            let sums = sumByCategory(byMonth[month] ?? [])
            let segments = order.filter { (sums[$0] ?? 0) > 0 }.map { Segment(category: $0, amount: sums[$0] ?? 0) }
            return MonthBar(month: month, total: segments.reduce(0) { $0 + $1.amount }, segments: segments)
        }
    }

    /// Every month from the first bar's to the last's, a month without spending as 0. Left as given when
    /// the run is longer than maxFilledMonths.
    static func withEmptyMonths(_ months: [MonthBar]) -> [MonthBar] {
        guard months.count >= 2, let first = months.first?.month, let last = months.last?.month else { return months }
        var byMonth: [String: MonthBar] = [:]
        for m in months { byMonth[m.month] = m } // new Map(...): a later entry wins
        var out: [MonthBar] = []
        var month = first
        while !JSText.less(last, month) {
            if out.count >= maxFilledMonths { return months }
            out.append(byMonth[month] ?? MonthBar(month: month, total: 0, segments: []))
            let next = Format.shiftMonth(month, 1)
            // A month that does not move (text that is not a month) would never end.
            if next.isEmpty || !JSText.less(month, next) { return months }
            month = next
        }
        return out
    }

    /// Round numbers for the y axis: 0 up to a clean top that covers `max`, at most 4 steps.
    static func axisTicks(_ max: Double) -> [Double] {
        if max <= 0 { return [0] }
        let raw = max / 4
        let p = Foundation.pow(10, Foundation.floor(Foundation.log10(raw)))
        let step = Swift.max(1, [1.0, 2, 5, 10].map { $0 * p }.first { $0 >= raw } ?? 10 * p)
        var ticks: [Double] = []
        var v = 0.0
        while v < max + step {
            ticks.append(v)
            if v >= max { break }
            v += step
        }
        return ticks
    }

    /// tickLabel: 「5万」「1.2万」「8,000」, as toLocaleString("ja-JP") writes them.
    static func tickLabel(_ v: Double) -> String {
        if v >= 10_000 { return "\(JSLocale.number(v / 10_000, maximumFractionDigits: 1))万" }
        return JSLocale.number(v, maximumFractionDigits: 3)
    }

    /// What the category filter and the shop filter (through normalizeShop, compared in full) narrow on
    /// the spend screen, for a month and for the whole period alike (see spend.ts spendSlices).
    static func slices(_ parcels: [ParcelRow], all: Bool, category: CategoryFilter, shop: String?) -> Slices {
        let byC = { (p: ParcelRow) -> Bool in
            switch category {
            case .any: return true
            case .uncategorized: return categoryOf(p.category) == nil
            case let .only(c): return categoryOf(p.category) == c
            }
        }
        let byS = { (p: ParcelRow) -> Bool in
            guard let shop, !shop.isEmpty else { return true }
            return JSText.equal(Shop.normalizeShop(p), shop)
        }
        let both = { (p: ParcelRow) in byC(p) && byS(p) }
        let dated = { (p: ParcelRow) in !(p.orderedAt ?? "").isEmpty }
        // The whole period is told by order month, so parcels with no order date stay out of the figures.
        let counted = all ? parcels.filter(dated) : parcels
        let picked = counted.filter(both)
        return Slices(
            picked: picked,
            orders: all ? parcels.filter(both) : picked,
            byCategory: counted.filter(byS),
            byShop: counted.filter(byC),
            undated: all ? parcels.filter { !dated($0) && both($0) }.count : 0
        )
    }

    /// NO_ORDER_DATE_LABEL of src/lib/delivered.ts.
    static let noOrderDateLabel = "注文日不明"

    /// groupByOrderMonth of src/lib/delivered.ts (the spend screen's order list over the whole
    /// period): newest order month first as 「2026年5月に注文」, newest order date first inside,
    /// then the parcels with no order date under 「注文日不明」. Its parity cases come with T13.
    static func groupByOrderMonth(_ parcels: [ParcelRow]) -> [(label: String, parcels: [ParcelRow])] {
        let dated = parcels.filter { startsWithYearMonth($0.orderedAt) }
        let undated = parcels.filter { !startsWithYearMonth($0.orderedAt) }
        // Newest first by code units, a stable sort.
        let sorted = dated.enumerated()
            .sorted { l, r in
                let a = l.element.orderedAt ?? "", b = r.element.orderedAt ?? ""
                if JSText.equal(a, b) { return l.offset < r.offset }
                return JSText.less(b, a)
            }
            .map(\.element)
        var groups: [(label: String, parcels: [ParcelRow])] = []
        var month = ""
        for p in sorted {
            let ym = JSText.slice(p.orderedAt ?? "", 0, 7)
            if !JSText.equal(ym, month) {
                month = ym
                let parts = ym.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
                let y = parts.first.flatMap(JSNumber.integer).map(String.init) ?? "NaN"
                let m = parts.count > 1 ? (JSNumber.integer(parts[1]).map(String.init) ?? "NaN") : "NaN"
                groups.append((label: "\(y)年\(m)月に注文", parcels: []))
            }
            groups[groups.count - 1].parcels.append(p)
        }
        if !undated.isEmpty { groups.append((label: noOrderDateLabel, parcels: undated)) }
        return groups
    }
}

/// Number#toLocaleString("ja-JP", { maximumFractionDigits }) for the axis labels: the shortest decimal
/// form of the double (as ICU reads it) rounded half away from zero, grouped by three with ",", no
/// trailing zeros.
enum JSLocale {
    static func number(_ v: Double, maximumFractionDigits: Int) -> String {
        guard v.isFinite else { return v.isNaN ? "NaN" : (v < 0 ? "-∞" : "∞") }
        // Swift's description is the shortest text that reads back as the same double.
        guard var exact = Decimal(string: "\(v)", locale: Locale(identifier: "en_US_POSIX")) else { return "\(v)" }
        var rounded = Decimal()
        NSDecimalRound(&rounded, &exact, maximumFractionDigits, .plain)
        var text = NSDecimalNumber(decimal: rounded).description(withLocale: Locale(identifier: "en_US_POSIX"))
        var negative = false
        if text.hasPrefix("-") {
            negative = true
            text.removeFirst()
        }
        let parts = text.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        let intPart = String(parts[0])
        var frac = parts.count > 1 ? String(parts[1]) : ""
        while frac.hasSuffix("0") { frac.removeLast() }
        var grouped = ""
        for (i, ch) in intPart.enumerated() {
            if i > 0 && (intPart.count - i) % 3 == 0 { grouped.append(",") }
            grouped.append(ch)
        }
        // A value that rounds to zero keeps its sign, as toLocaleString does ("-0").
        let sign = negative || (v < 0 || (v == 0 && v.sign == .minus)) ? "-" : ""
        return sign + grouped + (frac.isEmpty ? "" : ".\(frac)")
    }
}
