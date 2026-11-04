// TDD-STUB(task 4): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Port of src/lib/format.ts. "Today" is always a parameter ("YYYY-MM-DD" in JST). Use Asia/Tokyo and
// the Gregorian calendar explicitly; never the device's calendar, time zone or locale.

import Foundation

enum Format {
    /// todayJst(now): the JST calendar date of `now` as "YYYY-MM-DD".
    static func todayJst(now: Date) -> String { "" }

    /// formatDateJa(ymd, {withYear}): "11/3(火)", with "2025/" in front when the year differs from today's
    /// (or when withYear). Nil gives "", text that is not a date is returned as is.
    static func formatDateJa(_ ymd: String?, withYear: Bool = false, today: String) -> String { "" }

    /// relativeDateJa(ymd, today): 今日 / 明日 / 昨日 / formatDateJa.
    static func relativeDateJa(_ ymd: String?, today: String) -> String { "" }

    /// formatWindow(start, end): "午前中" / "14:00〜16:00" / "14:00〜" / "〜16:00" / "".
    static func formatWindow(start: String?, end: String?) -> String { "" }

    /// yen(n): "¥1,234", nil gives "—".
    static func yen(_ n: Int?) -> String { "" }

    /// formatDateTimeJa(iso): "11/2(月) 18:00" in JST (year from `today`); unparsable text is returned as is.
    static func formatDateTimeJa(_ iso: String?, today: String) -> String { "" }

    /// STATUS_LABEL.
    static let statusLabel: [String: String] = [:]

    /// RELEVANCE_LABEL.
    static let relevanceLabel: [String: String] = [:]
}
