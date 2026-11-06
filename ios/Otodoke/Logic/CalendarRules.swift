// TDD-STUB(task 5) — agreed API, placeholder bodies. Remove this marker once written.
// Port of src/lib/calendar.ts (2541793).

import Foundation

enum CalendarRules {
    /// upcomingByDay: the parcels from today on, by the day they are listed under ("YYYY-MM-DD"),
    /// input order kept within a day.
    static func upcomingByDay(_ parcels: [ParcelRow], today: String, first: String, last: String) -> [String: [ParcelRow]] { [:] }
}
