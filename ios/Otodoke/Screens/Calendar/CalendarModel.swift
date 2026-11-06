// The view model of CalendarView (src/app/app/calendar/page.tsx, 2541793). Reads every parcel of the
// signed-in user (all of them, keyset by id, with user_id = me); the days come from
// CalendarRules.upcomingByDay; within a day the Web's database order (expected_date ↑,
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
    static let failedText = "読み込めませんでした"
    static let emptyText = "この月の予定はありません"

    let reader: ParcelReader

    /// "YYYY-MM": starts at today's month.
    private(set) var month: String = ""
    /// nil until the first read ends.
    private(set) var byDay: LoadResult<[String: [ParcelRow]]>?
    /// A move to another month is being read (one at a time).
    private(set) var isMoving = false
    /// The day the shown month was read on ("YYYY-MM-DD").
    private(set) var shownToday: String

    @ObservationIgnored private let today: @Sendable () -> String
    @ObservationIgnored private let mark: ChangeMark
    @ObservationIgnored private var fence = ReadFence()
    /// [N2] The month a move is reading: a load() meanwhile reads it too, so the move is not undone.
    @ObservationIgnored private var movingTo: String?
    /// [S1] The last read was cut off (its .task cancelled): the next appearance reads again.
    @ObservationIgnored private var wasCutOff = false
    /// [CX-f2] The newest read's: raised as soon as its task is cancelled, before the read ends.
    @ObservationIgnored private var cutOff: CutOffSignal?

    init(reader: ParcelReader, changes: DataChanges?, today: @escaping @Sendable () -> String) {
        self.reader = reader
        self.today = today
        mark = ChangeMark(changes)
        let now = today()
        shownToday = now
        month = Format.monthOf(now)
    }

    var bounds: MonthBounds { MonthBounds(today: today()) }
    var canGoBack: Bool { bounds.canShift(month, by: -1) }
    var canGoForward: Bool { bounds.canShift(month, by: 1) }

    /// The month's first and last day.
    private static func range(_ ym: String) -> (first: String, last: String) {
        let parts = ym.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        let y = parts.first.flatMap(JSNumber.integer) ?? 0
        let m = parts.count > 1 ? (JSNumber.integer(parts[1]) ?? 0) : 0
        return ("\(ym)-01", "\(ym)-\(JSText.pad(Format.daysInMonth(y, m), 2))")
    }

    /// The grid: nil before the 1st (Sunday first) and after the last day up to a full week.
    var cells: [CalendarCell?] {
        let (first, _) = Self.range(month)
        guard let parts = Format.splitDate(first) else { return [] }
        let days = Format.daysInMonth(parts.y, parts.m)
        let listed = byDay?.value ?? [:]
        var cells: [CalendarCell?] = Array(repeating: nil, count: Format.weekdayOf(first))
        for d in 1...max(1, days) {
            let day = "\(month)-\(JSText.pad(d, 2))"
            let column = cells.count % 7
            let list = listed[day] ?? []
            let face = list.contains { ParcelRules.faceToFace($0) == true }
            let style: CalendarDayStyle = JSText.equal(day, shownToday) ? .today : column == 0 ? .sunday : column == 6 ? .saturday : .plain
            cells.append(CalendarCell(
                day: day,
                number: d,
                style: style,
                count: list.count,
                badge: list.isEmpty ? nil : "\(face ? "🤝" : "")\(list.count)件",
                isFaceToFace: face
            ))
        }
        while cells.count % 7 != 0 { cells.append(nil) }
        return cells
    }

    /// The listed days, ascending.
    var listedDays: [String] {
        (byDay?.value ?? [:]).keys.sorted(by: JSText.less)
    }

    func entries(on day: String) -> [ParcelRow] {
        byDay?.value?[day] ?? []
    }

    /// The day heading's word: 「対面受け取り」, 「念のため対面」 when every face-to-face parcel of the day
    /// is so only by the default, nil when none is face-to-face.
    func presenceLabel(on day: String) -> String? {
        let inPerson = entries(on: day).filter { ParcelRules.faceToFace($0) == true }
        if inPerson.isEmpty { return nil }
        return inPerson.allSatisfy(ParcelRules.faceToFaceAssumed) ? BadgeText.assumedFaceToFace : "対面受け取り"
    }

    /// The left column of a row: 「11/5(木)〜11/7(土)のどこか」 / formatWindow / 「時間未定」.
    static func timeText(_ p: ParcelRow, today: String) -> String {
        if let end = p.expectedDateEnd, !end.isEmpty {
            return "\(Format.formatDateJa(p.expectedDate, today: today))〜\(Format.formatDateJa(end, today: today))のどこか"
        }
        let window = Format.formatWindow(start: p.expectedWindowStart, end: p.expectedWindowEnd)
        return window.isEmpty ? Self.noTime : window
    }

    static let noTime = "時間未定"

    func load() async {
        await read(movingTo ?? month)
    }

    func previousMonth() async {
        await move(to: Format.shiftMonth(month, -1))
    }

    func nextMonth() async {
        await move(to: Format.shiftMonth(month, 1))
    }

    /// From the wheel; a month outside `bounds` is not moved to.
    func show(month ym: String) async {
        await move(to: ym)
    }

    /// Shown (the tab opened): reads when never read, or when DataChanges moved since the last read.
    func onAppear() async {
        if byDay == nil || byDay == .failed || mark.isStale || wasCutOff || cutOff?.isRaised == true { await load() }
    }

    /// iOS-12: the app came back to the front while this screen is shown.
    func sceneBecameActive() async {
        await load()
    }

    // MARK: reading

    private func move(to ym: String) async {
        guard !isMoving, bounds.contains(ym), !JSText.equal(ym, month) else { return }
        isMoving = true
        movingTo = ym
        // [CX-f1] The move ends when the newest read ends (read() clears it), not when this read does: a
        // load() meanwhile reads movingTo too and may still be on the way when this one ends.
        await read(ym)
    }

    /// Reads `ym`; shown only when no newer read began meanwhile.
    private func read(_ ym: String) async {
        let ticket = fence.beginRead()
        let signal = CutOffSignal()
        cutOff = signal
        mark.markRead()
        let now = today()
        let reader = self.reader
        let result = await withTaskCancellationHandler {
            await reader.allParcels()
        } onCancel: {
            signal.raise()
        }
        // [N-new2] A newer read began: it owns the state (this one being cut off changes nothing).
        // [N-r2-2] The calendar never writes (no fence.beginWrite), so the verdict is .current or
        // .superseded; anything not current is a newer read's.
        guard fence.verdict(ticket) == .current else { return }
        // [S1] Cut off (the .task cancelled when the tab is left): dropped, not shown as a failure.
        // [N-r2-1] A move on the way stays (isMoving, movingTo): the next load() reads movingTo and ends it.
        guard !Task.isCancelled else {
            wasCutOff = true
            return
        }
        // [CX-f1] The newest read ended: a move on the way is over (shown or failed).
        isMoving = false
        movingTo = nil
        wasCutOff = false
        month = ym
        shownToday = now
        switch result {
        case .failed:
            byDay = .failed
        case let .loaded(rows):
            let (first, last) = Self.range(ym)
            let open = Self.databaseOrder(rows.filter { $0.status != "cancelled" })
            byDay = .loaded(CalendarRules.upcomingByDay(open, today: now, first: first, last: last))
        }
    }

    /// The Web's order: expected_date ↑, expected_window_start ↑ (nulls last for both), then id ↑.
    static func databaseOrder(_ rows: [ParcelRow]) -> [ParcelRow] {
        func compare(_ a: String?, _ b: String?) -> Int {
            switch (a, b) {
            case let (x?, y?): return JSText.equal(x, y) ? 0 : (JSText.less(x, y) ? -1 : 1)
            case (nil, _?): return 1
            case (_?, nil): return -1
            case (nil, nil): return 0
            }
        }
        return rows.sorted { a, b in
            let byDate = compare(a.expectedDate, b.expectedDate)
            if byDate != 0 { return byDate < 0 }
            let byStart = compare(a.expectedWindowStart, b.expectedWindowStart)
            if byStart != 0 { return byStart < 0 }
            return JSText.less(a.id.lowercased(), b.id.lowercased())
        }
    }
}
