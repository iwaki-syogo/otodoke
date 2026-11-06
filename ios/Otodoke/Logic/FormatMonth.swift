// TDD-STUB(task 5) — agreed API, placeholder bodies. Remove this marker once written (or move these
// into Format.swift). Ports of src/lib/format.ts (month parts) and src/lib/month-url.ts.

import Foundation

extension Format {
    /// MONTH_MIN
    static let monthMin = ""

    /// monthMax: December of next year.
    static func monthMax(today: String) -> String { "" }

    /// monthOf: "YYYY-MM" of a date string.
    static func monthOf(_ ymd: String) -> String { "" }

    /// monthLabel: 「11月」 in this year (of `today`), 「2025年11月」 otherwise.
    static func monthLabel(_ ym: String, today: String) -> String { "" }

    /// monthParam: "YYYY-MM" with a month of 01 to 12, else today's month.
    static func monthParam(_ m: String?, today: String) -> String { "" }

    /// shiftMonth: `delta` months on (or back).
    static func shiftMonth(_ ym: String, _ delta: Int) -> String { "" }

    /// splitDate: the parts of "YYYY-MM-DD…", nil when it does not start like that.
    static func splitDate(_ ymd: String) -> (y: Int, m: Int, d: Int)? { nil }

    /// weekdayOf: 0 = Sunday; 0 for text that is not a date.
    static func weekdayOf(_ ymd: String) -> Int { -1 }

    /// addDays: the date `days` later; the text as given when it is not a date.
    static func addDays(_ ymd: String, _ days: Int) -> String { "" }

    /// daysInMonth(y, m) as Date.UTC(y, m, 0) gives it.
    static func daysInMonth(_ y: Int, _ m: Int) -> Int { 0 }
}
