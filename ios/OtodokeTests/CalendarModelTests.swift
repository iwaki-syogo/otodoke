import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 7] The calendar (src/app/app/calendar/page.tsx and month-picker.tsx, 2541793).
/// 2026-11-04 is a Wednesday; November 2026 starts on a Sunday.
@Suite("MonthBounds (batch 2, task 7)")
struct MonthBoundsTests {
    let bounds = MonthBounds(today: "2026-11-04")

    @Test func fromMonthMinToDecemberOfNextYear() {
        #expect(bounds.min == "2020-01")
        #expect(bounds.max == "2027-12")
        #expect(MonthBounds(today: "2026-12-31").max == "2027-12")
        #expect(MonthBounds(today: "2027-01-01").max == "2028-12")
    }

    @Test func containsOnlyTheRange() {
        #expect(bounds.contains("2020-01"))
        #expect(bounds.contains("2027-12"))
        #expect(bounds.contains("2026-11"))
        #expect(!bounds.contains("2019-12"))
        #expect(!bounds.contains("2028-01"))
        #expect(!bounds.contains("2026-13"))
        #expect(!bounds.contains("garbage"))
    }

    @Test func doesNotStepOutsideTheRange() {
        #expect(!bounds.canShift("2020-01", by: -1))
        #expect(!bounds.canShift("2027-12", by: 1))
        #expect(bounds.canShift("2020-01", by: 1))
        #expect(bounds.canShift("2027-12", by: -1))
        #expect(bounds.canShift("2026-12", by: 1))
    }

    @Test func theWheelHasEveryMonthOldestFirst() {
        let months = bounds.months
        #expect(months.count == 96)
        #expect(months.first == "2020-01")
        #expect(months.last == "2027-12")
        #expect(months.contains("2024-02"))
        #expect(months == months.sorted())
    }
}

@Suite("CalendarModel (batch 2, task 7)")
@MainActor
struct CalendarModelTests {
    nonisolated static let today = "2026-11-04"

    /// The month of 11/2026 as the Web shows it, with parcels that must not appear.
    static let rows: [Row] = [
        Rows.parcel(1, ["expected_date": "2026-11-05", "requires_presence": nil]), // face-to-face by the default
        Rows.parcel(2, ["expected_date": "2026-11-05", "requires_presence": false, "expected_window_start": "09:00:00", "expected_window_end": "12:00:00"]),
        Rows.parcel(3, ["expected_date": "2026-11-07", "requires_presence": true]),
        Rows.parcel(4, ["expected_date": "2026-11-03"]), // past
        Rows.parcel(5, ["expected_date": "2026-11-06", "status": "delivered"]),
        Rows.parcel(6, ["expected_date": "2026-11-06", "status": "cancelled"]),
        Rows.parcel(7, ["expected_date": "2026-10-30", "expected_date_end": "2026-11-06", "requires_presence": false]), // listed today
        Rows.parcel(8, ["expected_date": "2026-12-01"]),
        Rows.parcel(9, ["expected_date": "2026-11-05", "user_id": .string(FakeSupabase.other)]),
        Rows.parcel(10, ["expected_date": "2026-11-08", "shop_key": "amazon"]),
        Rows.parcel(11, ["expected_date": "2026-11-09", "requires_presence": nil]),
        Rows.parcel(12, ["expected_date": "2026-11-09", "requires_presence": true]),
        Rows.parcel(13, ["expected_date": nil]),
    ]

    private func make(_ fake: FakeSupabase, today: String = Self.today, changes: DataChanges? = nil) async throws -> CalendarModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return CalendarModel(reader: ParcelReader(provider: provider), changes: changes, today: { today })
    }

    private func loaded(_ rows: [Row] = Self.rows) async throws -> (FakeSupabase, CalendarModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", rows)
        let model = try await make(fake)
        await model.load()
        return (fake, model)
    }

    private func ids(_ rows: [ParcelRow]) -> [String] { rows.map(\.id) }

    @Test func theWords() {
        #expect(CalendarModel.failedText == "読み込めませんでした")
        #expect(CalendarModel.emptyText == "この月の予定はありません")
    }

    @Test func startsAtThisMonth() async throws {
        let model = try await make(FakeSupabase.make())
        #expect(model.month == "2026-11")
        #expect(model.bounds == MonthBounds(today: Self.today))
    }

    // MARK: the days

    @Test func listsOnlyWhatIsStillAheadThisMonth() async throws {
        let (_, model) = try await loaded()
        #expect(model.listedDays == ["2026-11-04", "2026-11-05", "2026-11-07", "2026-11-08", "2026-11-09"])
        #expect(ids(model.entries(on: "2026-11-04")) == [Rows.id(7)])
        // Within a day the Web's order: expected_window_start ↑ nulls last, then id.
        #expect(ids(model.entries(on: "2026-11-05")) == [Rows.id(2), Rows.id(1)])
        #expect(ids(model.entries(on: "2026-11-09")) == [Rows.id(11), Rows.id(12)])
        #expect(model.entries(on: "2026-11-03").isEmpty)
        #expect(model.entries(on: "2026-11-06").isEmpty)
    }

    @Test func readsOnlyTheSignedInUsersParcels() async throws {
        let (fake, model) = try await loaded()
        #expect(!model.entries(on: "2026-11-05").contains { $0.id == Rows.id(9) })
        let reads = await fake.requests("GET", "parcels")
        #expect(!reads.isEmpty)
        for r in reads {
            #expect(r.query("user_id") == ["eq.\(FakeSupabase.me)"])
        }
    }

    @Test func readsPastAThousandRows() async throws {
        let many = (100..<1_201).map { Rows.parcel($0, ["expected_date": "2026-11-20"]) }
        let (_, model) = try await loaded(many)
        #expect(model.entries(on: "2026-11-20").count == 1_101)
    }

    // MARK: the grid

    @Test func theGrid() async throws {
        let (_, model) = try await loaded()
        let cells = model.cells
        try #require(cells.count == 35)
        #expect(cells.count % 7 == 0)
        #expect(cells.compactMap { $0 }.count == 30)
        #expect(cells[0]?.day == "2026-11-01")
        #expect(cells[0]?.number == 1)
        #expect(cells[30] == nil)
        #expect(cells[34] == nil)
    }

    @Test func weekdayColoursAndToday() async throws {
        let (_, model) = try await loaded()
        let cells = model.cells
        try #require(cells.count == 35)
        #expect(cells[0]?.style == .sunday) // 11/1
        #expect(cells[3]?.style == .today) // 11/4
        #expect(cells[2]?.style == .plain) // 11/3
        #expect(cells[6]?.style == .saturday) // 11/7
        #expect(cells[7]?.style == .sunday) // 11/8
    }

    @Test func todayWinsOverTheWeekdayColour() async throws {
        let fake = FakeSupabase.make()
        let model = try await make(fake, today: "2026-11-07") // a Saturday
        await model.load()
        let cells = model.cells
        try #require(cells.count == 35)
        #expect(cells[6]?.style == .today)
    }

    @Test func countsAndFaceToFaceBadges() async throws {
        let (_, model) = try await loaded()
        let byDay = Dictionary(uniqueKeysWithValues: model.cells.compactMap { $0 }.map { ($0.day, $0) })
        #expect(byDay["2026-11-04"]?.badge == "1件")
        #expect(byDay["2026-11-04"]?.isFaceToFace == false)
        #expect(byDay["2026-11-05"]?.badge == "🤝2件")
        #expect(byDay["2026-11-05"]?.isFaceToFace == true)
        #expect(byDay["2026-11-05"]?.count == 2)
        #expect(byDay["2026-11-07"]?.badge == "🤝1件")
        #expect(byDay["2026-11-08"]?.badge == "1件") // Amazon, nothing stored: not face-to-face
        #expect(byDay["2026-11-03"]?.badge == nil)
        #expect(byDay["2026-11-03"]?.count == 0)
    }

    @Test func theDayHeadingWordsFaceToFaceAsTheCards() async throws {
        let (_, model) = try await loaded()
        // Only a default: 念のため対面.
        #expect(model.presenceLabel(on: "2026-11-05") == "念のため対面")
        #expect(model.presenceLabel(on: "2026-11-07") == "対面受け取り")
        // One stated among assumed ones: 対面受け取り.
        #expect(model.presenceLabel(on: "2026-11-09") == "対面受け取り")
        #expect(model.presenceLabel(on: "2026-11-08") == nil)
        #expect(model.presenceLabel(on: "2026-11-04") == nil)
    }

    @Test func theTimeColumn() throws {
        let window = try Rows.parcelRow(Rows.parcel(1, ["expected_date": "2026-11-05", "expected_date_end": "2026-11-07"]))
        #expect(CalendarModel.timeText(window, today: Self.today) == "11/5(木)〜11/7(土)のどこか")
        let hours = try Rows.parcelRow(Rows.parcel(2, ["expected_date": "2026-11-05", "expected_window_start": "14:00:00", "expected_window_end": "16:00:00"]))
        #expect(CalendarModel.timeText(hours, today: Self.today) == "14:00〜16:00")
        let morning = try Rows.parcelRow(Rows.parcel(3, ["expected_date": "2026-11-05", "expected_window_start": "08:00:00", "expected_window_end": "12:00:00"]))
        #expect(CalendarModel.timeText(morning, today: Self.today) == "午前中")
        let none = try Rows.parcelRow(Rows.parcel(4, ["expected_date": "2026-11-05"]))
        #expect(CalendarModel.timeText(none, today: Self.today) == "時間未定")
    }

    // MARK: failure and empty

    @Test func aFailedReadIsNotAnEmptyMonth() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.rows)
        await fake.fail("GET", "parcels", with: .http(500))
        let model = try await make(fake)
        await model.load()
        #expect(model.byDay == .failed)
        #expect(model.listedDays.isEmpty)
    }

    @Test func aFailedSecondPageFailsTheWholeRead() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", (100..<1_201).map { Rows.parcel($0, ["expected_date": "2026-11-20"]) })
        await fake.fail("GET", "parcels", nth: 2, with: .transport(.networkConnectionLost))
        let model = try await make(fake)
        await model.load()
        #expect(model.byDay == .failed)
    }

    @Test func anEmptyMonthIsLoadedAndEmpty() async throws {
        let (_, model) = try await loaded([])
        #expect(model.byDay == .loaded([:]))
        #expect(model.listedDays.isEmpty)
    }

    // MARK: moving

    @Test func movesAMonthAndReadsAgain() async throws {
        let (fake, model) = try await loaded()
        let before = await fake.count("GET", "parcels")
        await model.nextMonth()
        #expect(model.month == "2026-12")
        #expect(await fake.count("GET", "parcels") > before)
        #expect(ids(model.entries(on: "2026-12-01")) == [Rows.id(8)])
        await model.previousMonth()
        #expect(model.month == "2026-11")
    }

    @Test func doesNotMoveOutsideTheRange() async throws {
        let fake = FakeSupabase.make()
        let early = try await make(fake, today: "2020-01-15")
        await early.load()
        #expect(!early.canGoBack)
        await early.previousMonth()
        #expect(early.month == "2020-01")

        let model = try await make(fake)
        await model.load()
        await model.show(month: "2027-12")
        #expect(model.month == "2027-12")
        #expect(!model.canGoForward)
        await model.nextMonth()
        #expect(model.month == "2027-12")
        await model.show(month: "2028-01")
        #expect(model.month == "2027-12")
        await model.show(month: "2019-12")
        #expect(model.month == "2027-12")
    }

    @Test func oneMoveAtATime() async throws {
        let (fake, model) = try await loaded()
        let gate = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let first = Task { await model.nextMonth() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        #expect(model.isMoving)
        await model.nextMonth()
        gate.open()
        await first.value
        #expect(model.month == "2026-12")
        #expect(model.isMoving == false)
    }

    @Test func anOldAnswerNeverReplacesANewerOne() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.rows)
        let late = Gate()
        await fake.fail("GET", "parcels", nth: 1, with: .delay(late))
        let model = try await make(fake)
        let first = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "parcels") == 1 })
        await fake.insert("parcels", [Rows.parcel(50, ["expected_date": "2026-11-10"])])
        await model.load()
        #expect(ids(model.entries(on: "2026-11-10")) == [Rows.id(50)])
        late.open()
        await first.value
        #expect(ids(model.entries(on: "2026-11-10")) == [Rows.id(50)])
    }

    // MARK: 「古くなった」 and the front (the wiring is task 12)

    @Test func readsWhenShownFirstThenOnlyWhenStale() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.rows)
        let changes = DataChanges()
        let model = try await make(fake, changes: changes)
        await model.onAppear()
        let first = await fake.count("GET", "parcels")
        #expect(first >= 1)
        await model.onAppear()
        #expect(await fake.count("GET", "parcels") == first)
        changes.publish()
        await model.onAppear()
        #expect(await fake.count("GET", "parcels") > first)
    }

    @Test func comingBackToTheFrontReadsOnce() async throws {
        let (fake, model) = try await loaded()
        let before = await fake.count("GET", "parcels")
        await model.sceneBecameActive()
        #expect(await fake.count("GET", "parcels") == before + 1)
    }
}
