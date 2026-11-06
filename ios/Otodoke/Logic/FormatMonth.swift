// Ports of src/lib/format.ts (the month parts) and src/lib/month-url.ts (2541793). "Today" is always a
// parameter; months and dates are worked out with the same day arithmetic as Format.swift (Date.UTC).

import Foundation

extension Format {
    /// MONTH_MIN: the earliest month the picker offers.
    static let monthMin = "2020-01"

    /// monthMax: December of next year (`${Number(today.slice(0, 4)) + 1}-12`).
    static func monthMax(today: String) -> String {
        guard let y = JSNumber.integer(JSText.slice(today, 0, 4)) else { return "NaN-12" }
        return "\(y + 1)-12"
    }

    /// monthOf: "YYYY-MM" of a date string (`ymd.slice(0, 7)`).
    static func monthOf(_ ymd: String) -> String {
        JSText.slice(ymd, 0, 7)
    }

    /// monthLabel: 「11月」 in this year (of `today`), 「2025年11月」 otherwise.
    static func monthLabel(_ ym: String, today: String) -> String {
        let (y, m) = yearAndMonth(ym)
        let thisYear = JSNumber.integer(JSText.slice(today, 0, 4))
        let mText = m.map(String.init) ?? "NaN"
        if let y, y == thisYear { return "\(mText)月" }
        return "\(y.map(String.init) ?? "NaN")年\(mText)月"
    }

    /// monthParam: "YYYY-MM" with a month of 01 to 12 (`^\d{4}-(0[1-9]|1[0-2])$`), else today's month.
    static func monthParam(_ m: String?, today: String) -> String {
        if let m, isMonth(m) { return m }
        return JSText.slice(today, 0, 7)
    }

    /// shiftMonth: `delta` months on (or back), as Date.UTC(y, m - 1 + delta, 1).toISOString().slice(0, 7).
    /// Text that is not a month gives "" (the Web would throw there).
    static func shiftMonth(_ ym: String, _ delta: Int) -> String {
        let (y, m) = yearAndMonth(ym)
        guard let y, let m else { return "" }
        let days = CivilDate.utcDays(year: y, monthIndex: m - 1 + delta, day: 1)
        return JSText.slice(CivilDate.ymd(days: days), 0, 7)
    }

    /// splitDate: the parts of "YYYY-MM-DD…", nil when it does not start like that.
    static func splitDate(_ ymd: String) -> (y: Int, m: Int, d: Int)? {
        guard let p = CivilDate.split(ymd) else { return nil }
        return (p.y, p.m, p.d)
    }

    /// weekdayOf: 0 = Sunday; 0 for text that is not a date.
    static func weekdayOf(_ ymd: String) -> Int {
        CivilDate.weekday(ymd)
    }

    /// addDays: the date `days` later; the text as given when it is not a date.
    static func addDays(_ ymd: String, _ days: Int) -> String {
        CivilDate.addDays(ymd, days)
    }

    /// daysInMonth(y, m) as Date.UTC(y, m, 0).getUTCDate() gives it (m may roll over).
    static func daysInMonth(_ y: Int, _ m: Int) -> Int {
        CivilDate.civilFromDays(CivilDate.utcDays(year: y, monthIndex: m, day: 0)).d
    }

    /// `ym.split("-").map(Number)`: the first two parts as numbers (nil for NaN or a missing part).
    private static func yearAndMonth(_ ym: String) -> (Int?, Int?) {
        let parts = ym.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        let y = parts.first.flatMap(JSNumber.integer)
        let m = parts.count > 1 ? JSNumber.integer(parts[1]) : nil
        return (y, m)
    }

    private static func isMonth(_ m: String) -> Bool {
        let u = Array(m.utf16)
        guard u.count == 7, u[4] == 0x2D else { return false }
        let digit = { (c: UInt16) in (0x30...0x39).contains(c) }
        guard u[0..<4].allSatisfy(digit), digit(u[5]), digit(u[6]) else { return false }
        switch (u[5], u[6]) {
        case (0x30, 0x31...0x39): return true // 01-09
        case (0x31, 0x30...0x32): return true // 10-12
        default: return false
        }
    }
}

/// `Number(text)` for the integer text the month helpers read: surrounding white space (as trim) is
/// ignored, "" is 0, an optional sign and ASCII digits are the number, anything else is NaN (nil).
enum JSNumber {
    static func integer(_ text: String) -> Int? {
        let u = Array(JSText.trim(text).utf16)
        if u.isEmpty { return 0 }
        var i = 0
        var sign = 1
        if u[0] == 0x2B || u[0] == 0x2D {
            sign = u[0] == 0x2D ? -1 : 1
            i = 1
        }
        guard i < u.count, u.count - i <= 15 else { return nil }
        var n = 0
        for k in i..<u.count {
            guard (0x30...0x39).contains(u[k]) else { return nil }
            n = n * 10 + Int(u[k] - 0x30)
        }
        return sign * n
    }
}
