// Port of src/lib/calendar.ts (2541793).

import Foundation

enum CalendarRules {
    /// upcomingByDay: the calendar's parcels from today on, by the day they are listed under
    /// ("YYYY-MM-DD"), input order kept within a day. A parcel is listed while its last expected day is
    /// today or later, and never once delivered or cancelled. A window is listed on max(its first day,
    /// today, the month's first day), so nothing is listed on a past day. Days outside [first, last] are
    /// not listed. Dates are compared as text (code units), as the Web does.
    static func upcomingByDay(_ parcels: [ParcelRow], today: String, first: String, last: String) -> [String: [ParcelRow]] {
        var byDay: [String: [ParcelRow]] = [:]
        for p in parcels {
            guard let start = p.expectedDate, !start.isEmpty, p.status != "delivered", p.status != "cancelled" else { continue }
            let end = ParcelRules.lastExpectedDay(p) ?? start
            if JSText.less(end, today) { continue }
            let day = [start, today, first].reduce(start) { JSText.less($0, $1) ? $1 : $0 }
            if JSText.less(last, day) || JSText.less(end, first) { continue }
            byDay[day, default: []].append(p)
        }
        return byDay
    }
}
