// TDD-STUB(task 7) — agreed API, placeholder bodies. Remove this marker once written.
// The view model of CalendarView (src/app/app/calendar/page.tsx, 2541793). Reads every parcel of the
// signed-in user that the month needs (Web's conditions, or all of them), with user_id = me; the days
// come from CalendarRules.upcomingByDay; within a day the Web's database order (expected_date ↑,
// expected_window_start ↑ nulls last, id ↑). Old reads are dropped through ReadFence.

import Foundation
import Observation

enum CalendarDayStyle: Equatable, Sendable {
    /// The black circle (wins over the weekday colours).
    case today
    /// Red.
    case sunday
    /// Sky.
    case saturday
    case plain
}

struct CalendarCell: Equatable, Sendable {
    let day: String
    /// 1...31
    let number: Int
    let style: CalendarDayStyle
    /// How many parcels the day lists.
    let count: Int
    /// 「N件」, 「🤝N件」 when one of them is face-to-face (red), nil when none.
    let badge: String?
    let isFaceToFace: Bool
}

@MainActor
@Observable
final class CalendarModel {
    static let failedText = ""
    static let emptyText = ""

    let reader: ParcelReader

    /// "YYYY-MM": starts at today's month.
    private(set) var month: String = ""
    /// nil until the first read ends.
    private(set) var byDay: LoadResult<[String: [ParcelRow]]>?
    /// A move to another month is being read (one at a time).
    private(set) var isMoving = false

    init(reader: ParcelReader, changes: DataChanges?, today: @escaping @Sendable () -> String) {
        self.reader = reader
    }

    var bounds: MonthBounds { MonthBounds(today: "") }
    var canGoBack: Bool { false }
    var canGoForward: Bool { false }

    /// The grid: nil before the 1st (Sunday first) and after the last day up to a full week.
    var cells: [CalendarCell?] { [] }

    /// The listed days, ascending.
    var listedDays: [String] { [] }

    func entries(on day: String) -> [ParcelRow] { [] }

    /// The day heading's word: 「対面受け取り」, 「念のため対面」 when every face-to-face parcel of the day
    /// is so only by the default, nil when none is face-to-face.
    func presenceLabel(on day: String) -> String? { nil }

    /// The left column of a row: 「11/5(木)〜11/7(土)のどこか」 / formatWindow / 「時間未定」.
    static func timeText(_ p: ParcelRow, today: String) -> String { "" }

    func load() async {}
    func previousMonth() async {}
    func nextMonth() async {}
    /// From the wheel; a month outside `bounds` is not moved to.
    func show(month: String) async {}

    /// Shown (the tab opened): reads when never read, or when DataChanges moved since the last read.
    func onAppear() async {}
    /// iOS-12: the app came back to the front while this screen is shown.
    func sceneBecameActive() async {}
}
