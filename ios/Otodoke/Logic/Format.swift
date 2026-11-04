// Port of src/lib/format.ts. "Today" is always a parameter ("YYYY-MM-DD" in JST). Asia/Tokyo and
// the Gregorian calendar are named explicitly; the device's calendar, time zone and locale are never read.
// Calendar dates ("YYYY-MM-DD") are worked out with plain day arithmetic, as the Web does with Date.UTC,
// so no time zone ever shifts them.

import Foundation

enum Format {
    /// todayJst(now): the JST calendar date of `now` as "YYYY-MM-DD".
    static func todayJst(now: Date) -> String {
        let c = JST.calendar.dateComponents([.year, .month, .day], from: now)
        return "\(JSText.pad(c.year ?? 0, 4))-\(JSText.pad(c.month ?? 0, 2))-\(JSText.pad(c.day ?? 0, 2))"
    }

    /// formatDateJa(ymd, {withYear}): "11/3(火)", with "2025/" in front when the year differs from today's
    /// (or when withYear). Nil gives "", text that is not a date is returned as is.
    static func formatDateJa(_ ymd: String?, withYear: Bool = false, today: String) -> String {
        guard let ymd, !ymd.isEmpty else { return "" }
        guard let p = CivilDate.split(ymd) else { return ymd }
        let thisYear = Int(String(decoding: Array(today.utf16.prefix(4)), as: UTF16.self))
        let base = "\(p.m)/\(p.d)(\(weekdays[CivilDate.weekday(ymd)]))"
        return withYear || p.y != thisYear ? "\(p.y)/\(base)" : base
    }

    /// relativeDateJa(ymd, today): 今日 / 明日 / 昨日 / formatDateJa.
    static func relativeDateJa(_ ymd: String?, today: String) -> String {
        guard let ymd, !ymd.isEmpty else { return "" }
        if JSText.equal(ymd, today) { return "今日" }
        if JSText.equal(ymd, CivilDate.addDays(today, 1)) { return "明日" }
        if JSText.equal(ymd, CivilDate.addDays(today, -1)) { return "昨日" }
        return formatDateJa(ymd, today: today)
    }

    /// formatWindow(start, end): "午前中" / "14:00〜16:00" / "14:00〜" / "〜16:00" / "".
    static func formatWindow(start: String?, end: String?) -> String {
        let s = start.map { JSText.slice($0, 0, 5) } ?? ""
        let e = end.map { JSText.slice($0, 0, 5) } ?? ""
        if s == "08:00" && e == "12:00" { return "午前中" }
        if !s.isEmpty && !e.isEmpty { return "\(s)〜\(e)" }
        if !s.isEmpty { return "\(s)〜" }
        if !e.isEmpty { return "〜\(e)" }
        return ""
    }

    /// yen(n): "¥1,234", nil gives "—" (grouping as toLocaleString("ja-JP")).
    static func yen(_ n: Int?) -> String {
        guard let n else { return "—" }
        let digits = String(n.magnitude)
        var grouped = ""
        for (i, ch) in digits.enumerated() {
            if i > 0 && (digits.count - i) % 3 == 0 { grouped.append(",") }
            grouped.append(ch)
        }
        return "¥\(n < 0 ? "-" : "")\(grouped)"
    }

    /// formatDateTimeJa(iso): "11/2(月) 18:00" in JST (year from `today`); unparsable text is returned as is.
    static func formatDateTimeJa(_ iso: String?, today: String) -> String {
        guard let iso, !iso.isEmpty else { return "" }
        guard let micros = Instant.micros(iso) else { return iso }
        // Whole seconds: the display shows minutes, and flooring keeps 23:59:59.9 on its own day.
        let seconds = CivilDate.floorDiv(micros, 1_000_000)
        let c = JST.calendar.dateComponents([.year, .month, .day, .hour, .minute], from: Date(timeIntervalSince1970: TimeInterval(seconds)))
        let date = "\(JSText.pad(c.year ?? 0, 4))-\(JSText.pad(c.month ?? 0, 2))-\(JSText.pad(c.day ?? 0, 2))"
        return "\(formatDateJa(date, today: today)) \(JSText.pad(c.hour ?? 0, 2)):\(JSText.pad(c.minute ?? 0, 2))"
    }

    /// STATUS_LABEL.
    static let statusLabel: [String: String] = [
        "ordered": "注文中",
        "shipped": "発送済み",
        "out_for_delivery": "配達中",
        "attempted": "不在・再配達",
        "delivered": "届いた",
        "cancelled": "キャンセル",
        "unknown": "不明",
    ]

    /// RELEVANCE_LABEL.
    static let relevanceLabel: [String: String] = [
        "order": "注文を受け付け",
        "payment": "決済・手続き",
        "shipped": "発送",
        "out_for_delivery": "配達中",
        "delivered": "配達完了",
        "attempted": "不在・再配達",
        "cancelled": "キャンセル",
        "other_purchase": "その他の連絡",
        "forwarding_confirmation": "転送の確認",
    ]

    private static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]
}

/// Asia/Tokyo on the Gregorian calendar, named explicitly.
enum JST {
    static let calendar: Calendar = {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        c.locale = Locale(identifier: "en_US_POSIX")
        return c
    }()
}

/// String helpers that behave as JavaScript's do: UTF-16 units, code-unit comparison, String.prototype.trim.
enum JSText {
    /// `a === b` (code units; Swift's == would also equate canonically equivalent text).
    static func equal(_ a: String, _ b: String) -> Bool {
        a.utf16.elementsEqual(b.utf16)
    }

    /// `a < b` on code units.
    static func less(_ a: String, _ b: String) -> Bool {
        a.utf16.lexicographicallyPrecedes(b.utf16)
    }

    /// `s.slice(from, to)` for non-negative bounds.
    static func slice(_ s: String, _ from: Int, _ to: Int) -> String {
        let units = Array(s.utf16)
        let lo = min(max(from, 0), units.count)
        let hi = min(max(to, lo), units.count)
        return String(decoding: units[lo..<hi], as: UTF16.self)
    }

    /// The code units String.prototype.trim removes: WhiteSpace and LineTerminator.
    static func isTrimmable(_ u: UInt16) -> Bool {
        switch u {
        case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default:
            return false
        }
    }

    static func trim(_ units: ArraySlice<UInt16>) -> ArraySlice<UInt16> {
        var lo = units.startIndex
        var hi = units.endIndex
        while lo < hi && isTrimmable(units[lo]) { lo += 1 }
        while hi > lo && isTrimmable(units[hi - 1]) { hi -= 1 }
        return units[lo..<hi]
    }

    /// `s.trim()`.
    static func trim(_ s: String) -> String {
        String(decoding: trim(Array(s.utf16)[...]), as: UTF16.self)
    }

    /// Zero-padded decimal, as "%0Nd" with a minus sign in front of the padding.
    static func pad(_ n: Int, _ width: Int) -> String {
        let digits = String(n.magnitude)
        let padded = String(repeating: "0", count: max(0, width - digits.count)) + digits
        return n < 0 ? "-" + padded : padded
    }
}

/// Calendar-date arithmetic on "YYYY-MM-DD", as format.ts does it through Date.UTC (proleptic Gregorian,
/// days counted from 1970-01-01, overflowing months and days roll over).
enum CivilDate {
    struct Parts: Equatable {
        let y: Int
        let m: Int
        let d: Int
    }

    /// splitDate: `^(\d{4})-(\d{2})-(\d{2})` (ASCII digits) at the start of the text.
    static func split(_ ymd: String) -> Parts? {
        let u = Array(ymd.utf16.prefix(10))
        guard u.count == 10, u[4] == 0x2D, u[7] == 0x2D else { return nil }
        func num(_ r: Range<Int>) -> Int? {
            var n = 0
            for i in r {
                guard (0x30...0x39).contains(u[i]) else { return nil }
                n = n * 10 + Int(u[i] - 0x30)
            }
            return n
        }
        guard let y = num(0..<4), let m = num(5..<7), let d = num(8..<10) else { return nil }
        return Parts(y: y, m: m, d: d)
    }

    static func floorDiv<T: BinaryInteger>(_ a: T, _ b: T) -> T {
        let q = a / b
        return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
    }

    static func mod<T: BinaryInteger>(_ a: T, _ b: T) -> T {
        a - floorDiv(a, b) * b
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date (month 1...12).
    static func daysFromCivil(_ year: Int, _ month: Int, _ day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = floorDiv(y, 400)
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    static func civilFromDays(_ days: Int) -> Parts {
        let z = days + 719_468
        let era = floorDiv(z, 146_097)
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        let y = yoe + era * 400 + (m <= 2 ? 1 : 0)
        return Parts(y: y, m: m, d: d)
    }

    /// Date.UTC(year, monthIndex, day) in days: a year of 0...99 means 1900 + year, months and days roll over.
    static func utcDays(year: Int, monthIndex: Int, day: Int) -> Int {
        let y = (0...99).contains(year) ? 1900 + year : year
        return daysFromCivil(y + floorDiv(monthIndex, 12), mod(monthIndex, 12) + 1, 1) + day - 1
    }

    /// The first ten characters of Date#toISOString() for a day count.
    static func ymd(days: Int) -> String {
        let p = civilFromDays(days)
        let year = (0...9999).contains(p.y) ? JSText.pad(p.y, 4) : (p.y < 0 ? "-" : "+") + JSText.pad(abs(p.y), 6)
        return JSText.slice("\(year)-\(JSText.pad(p.m, 2))-\(JSText.pad(p.d, 2))", 0, 10)
    }

    /// weekdayOf: 0 = Sunday; text that is not a date gives 0.
    static func weekday(_ ymd: String) -> Int {
        guard let p = split(ymd) else { return 0 }
        return mod(utcDays(year: p.y, monthIndex: p.m - 1, day: p.d) + 4, 7)
    }

    /// addDays: text that is not a date is returned as is.
    static func addDays(_ ymd: String, _ days: Int) -> String {
        guard let p = split(ymd) else { return ymd }
        return self.ymd(days: utcDays(year: p.y, monthIndex: p.m - 1, day: p.d + days))
    }
}

/// Instants written as PostgREST and the Web write them ("2026-11-03T22:10:00.123456+00:00",
/// "...Z", "2026-11-04T08:05:00+09:00", "2026-11-04"), read the way `new Date(text)` reads them,
/// to whole microseconds (the database's precision) instead of milliseconds.
enum Instant {
    /// Microseconds since 1970-01-01T00:00:00Z, or nil when the text is not such an instant.
    /// A date alone is midnight UTC; a date and time without an offset is read as UTC (the Web's
    /// server runs in UTC).
    static func micros(_ text: String) -> Int64? {
        let u = Array(text.utf16)
        var i = 0

        func digits(_ n: Int) -> Int? {
            guard i + n <= u.count else { return nil }
            var v = 0
            for k in i..<(i + n) {
                guard (0x30...0x39).contains(u[k]) else { return nil }
                v = v * 10 + Int(u[k] - 0x30)
            }
            i += n
            return v
        }
        func eat(_ c: UInt16) -> Bool {
            guard i < u.count, u[i] == c else { return false }
            i += 1
            return true
        }

        guard let y = digits(4), eat(0x2D), let mo = digits(2), eat(0x2D), let d = digits(2) else { return nil }
        guard (1...12).contains(mo), (1...31).contains(d) else { return nil }
        var h = 0, mi = 0, s = 0, frac = 0
        var offsetSeconds = 0
        if i < u.count {
            guard u[i] == 0x54 || u[i] == 0x74 || u[i] == 0x20 else { return nil } // T, t, space
            i += 1
            guard let hh = digits(2), eat(0x3A), let mm = digits(2) else { return nil }
            h = hh
            mi = mm
            if eat(0x3A) {
                guard let ss = digits(2) else { return nil }
                s = ss
                if i < u.count && (u[i] == 0x2E || u[i] == 0x2C) { // . or ,
                    i += 1
                    var n = 0
                    var scale = 100_000
                    while i < u.count, (0x30...0x39).contains(u[i]) {
                        if scale > 0 {
                            frac += Int(u[i] - 0x30) * scale
                            scale /= 10
                        }
                        n += 1
                        i += 1
                    }
                    guard n > 0 else { return nil }
                }
            }
            guard (0...24).contains(h), (0...59).contains(mi), (0...59).contains(s) else { return nil }
            if h == 24 && (mi != 0 || s != 0 || frac != 0) { return nil }
            if i < u.count {
                if u[i] == 0x5A || u[i] == 0x7A { // Z, z
                    i += 1
                } else if u[i] == 0x2B || u[i] == 0x2D { // + or -
                    let sign = u[i] == 0x2D ? -1 : 1
                    i += 1
                    guard let oh = digits(2) else { return nil }
                    var om = 0
                    if eat(0x3A) {
                        guard let m2 = digits(2) else { return nil }
                        om = m2
                    } else if i < u.count {
                        guard let m2 = digits(2) else { return nil }
                        om = m2
                    }
                    guard oh <= 23, om <= 59 else { return nil }
                    offsetSeconds = sign * (oh * 3600 + om * 60)
                } else {
                    return nil
                }
            }
        }
        guard i == u.count else { return nil }
        let days = CivilDate.daysFromCivil(y, mo, 1) + d - 1
        let seconds = Int64(days) * 86_400 + Int64(h * 3600 + mi * 60 + s) - Int64(offsetSeconds)
        return seconds * 1_000_000 + Int64(frac)
    }
}
