import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 12] iOS-12 (back in front, the screen shown is read again, and only that one) and
/// 「古くなった」 reaching the list and the detail. CX1 (11/6 13:20): the writer publishes, the other
/// screens read again when next shown; the two paths of M1 are tested end to end.
/// [N-new3] By token (appeared / disappeared, the tab selected), as the app tells the refresher since N3.
@Suite("ScreenRefresher (batch 2, task 12)")
@MainActor
struct ScreenRefresherTests {
    final class Counter {
        var calls: [ScreenID] = []
    }

    final class Box {}

    final class Weak {
        weak var value: Box?
        init(_ value: Box) { self.value = value }
    }

    /// Each tab's root, appeared in its tab.
    private func roots(_ r: ScreenRefresher, _ counter: Counter) -> [MainTab: ScreenToken] {
        let ids: [(MainTab, ScreenID)] = [(.parcels, .parcels), (.calendar, .calendar), (.spend, .spend), (.settings, .settings)]
        var tokens: [MainTab: ScreenToken] = [:]
        for (tab, id) in ids {
            tokens[tab] = r.appeared(id, in: tab) { counter.calls.append(id) }
        }
        return tokens
    }

    @Test func onlyTheScreenInFrontReadsAgain() async {
        let counter = Counter()
        let r = ScreenRefresher()
        // Every tab's root is there (a TabView keeps them); the selected one is in front.
        _ = roots(r, counter)
        r.select(.calendar)
        await r.sceneBecameActive()
        #expect(counter.calls == [.calendar])
        r.select(.spend)
        await r.sceneBecameActive()
        #expect(counter.calls == [.calendar, .spend])
    }

    @Test func aDetailOverTheListIsTheOneInFront() async {
        let counter = Counter()
        let id = Rows.id(1)
        let r = ScreenRefresher()
        r.select(.parcels)
        let root = r.appeared(.parcels, in: .parcels) { counter.calls.append(.parcels) }
        let detail = r.appeared(.detail(id), in: .parcels) { counter.calls.append(.detail(id)) }
        await r.sceneBecameActive()
        #expect(counter.calls == [.detail(id)])
        // The list reports again later (its onAppear again): the detail over it stays in front.
        r.disappeared(root)
        let again = r.appeared(.parcels, in: .parcels) { counter.calls.append(.parcels) }
        await r.sceneBecameActive()
        #expect(counter.calls == [.detail(id), .detail(id)])
        r.disappeared(detail)
        r.disappeared(again)
    }

    @Test func nothingInFrontReadsNothing() async {
        let counter = Counter()
        let r = ScreenRefresher()
        r.select(.calendar)
        let calendar = r.appeared(.calendar, in: .calendar) { counter.calls.append(.calendar) }
        r.disappeared(calendar)
        await r.sceneBecameActive()
        #expect(counter.calls.isEmpty)
        // A screen of another tab is not in front of the selected tab with nothing shown.
        let spend = r.appeared(.spend, in: .spend) { counter.calls.append(.spend) }
        await r.sceneBecameActive()
        #expect(counter.calls.isEmpty)
        r.disappeared(spend)
    }

    @Test func anUnregisteredScreenIsNotCalled() async {
        let counter = Counter()
        let r = ScreenRefresher()
        r.select(.settings)
        var box: Box? = Box()
        let ref = Weak(box!)
        let token = r.appeared(.settings, in: .settings) { [box] in
            _ = box
            counter.calls.append(.settings)
        }
        box = nil
        #expect(ref.value != nil)
        r.disappeared(token)
        // Let go: never called, and its refresh (and what it holds) is gone.
        await r.sceneBecameActive()
        #expect(counter.calls.isEmpty)
        #expect(ref.value == nil)
        // Giving the old token back again lets go of nothing else (ShownScreen may do so on a re-appear).
        let again = r.appeared(.settings, in: .settings) { counter.calls.append(.settings) }
        r.disappeared(token)
        await r.sceneBecameActive()
        #expect(counter.calls == [.settings])
        r.disappeared(again)
    }

    /// S-1: a long load finished (DataChanges moved) while a tab was in front: that screen reads again if it is
    /// stale, the way its onAppear would; a screen that is not in front reads nothing.
    @Test func aPublishReadsOnlyTheStaleScreenInFront() async {
        let changes = DataChanges()
        let r = ScreenRefresher()
        r.select(.parcels)
        var reads: [ScreenID] = []
        let parcelsMark = ChangeMark(changes)
        let calendarMark = ChangeMark(changes)
        parcelsMark.markRead()
        calendarMark.markRead()
        func ifStale(_ id: ScreenID, _ mark: ChangeMark) -> ScreenRefresher.Refresh {
            {
                guard mark.isStale else { return }
                reads.append(id)
                mark.markRead()
            }
        }
        let parcels = r.appeared(.parcels, in: .parcels, refresh: {}, refreshIfStale: ifStale(.parcels, parcelsMark))
        let calendar = r.appeared(.calendar, in: .calendar, refresh: {}, refreshIfStale: ifStale(.calendar, calendarMark))
        // Nothing moved: nothing is read.
        await r.dataChanged()
        #expect(reads.isEmpty)
        changes.publish()
        await r.dataChanged()
        #expect(reads == [.parcels])
        // Read once; a second call finds it fresh (negative control: the calendar behind was never read).
        await r.dataChanged()
        #expect(reads == [.parcels])
        r.disappeared(parcels)
        r.disappeared(calendar)
    }

    @Test func aPublishReadsTheSettingsTabInFrontWhenItIsStale() async {
        let changes = DataChanges()
        let r = ScreenRefresher()
        r.select(.settings)
        var reads = 0
        let mark = ChangeMark(changes)
        mark.markRead()
        let token = r.appeared(.settings, in: .settings, refresh: {}, refreshIfStale: {
            guard mark.isStale else { return }
            reads += 1
            mark.markRead()
        })
        await r.dataChanged()
        #expect(reads == 0)
        changes.publish()
        await r.dataChanged()
        #expect(reads == 1)
        r.disappeared(token)
    }

    @Test func aPublishWithNothingInFrontOrNoStaleCheckReadsNothing() async {
        let changes = DataChanges()
        let r = ScreenRefresher()
        r.select(.spend)
        var reads = 0
        // The spend tab shows nothing yet; the parcels tab (not selected) has a check.
        let behind = r.appeared(.parcels, in: .parcels, refresh: {}, refreshIfStale: { reads += 1 })
        changes.publish()
        await r.dataChanged()
        #expect(reads == 0)
        // The front screen has no stale check: nothing is read either.
        r.select(.settings)
        let settings = r.appeared(.settings, in: .settings, refresh: { reads += 1 })
        await r.dataChanged()
        #expect(reads == 0)
        r.disappeared(behind)
        r.disappeared(settings)
    }

    @Test func eachComingBackReadsOnce() async {
        let counter = Counter()
        let r = ScreenRefresher()
        r.select(.spend)
        // The same screen reported twice (two appearances on the way): one coming back, one read, the
        // later appearance's.
        var labels: [String] = []
        let first = r.appeared(.spend, in: .spend) {
            counter.calls.append(.spend)
            labels.append("first")
        }
        let second = r.appeared(.spend, in: .spend) {
            counter.calls.append(.spend)
            labels.append("second")
        }
        await r.sceneBecameActive()
        #expect(counter.calls == [.spend])
        #expect(labels == ["second"])
        r.disappeared(first)
        r.disappeared(second)
    }
}

@Suite("「古くなった」 on the list and the detail (batch 2, task 12)")
@MainActor
struct StaleListAndDetailTests {
    nonisolated static let today = "2026-11-04"

    private struct World: Sendable {
        let fake: FakeSupabase
        let changes: DataChanges
        let reader: ParcelReader
        let writer: ParcelWriter
    }

    private func world(_ rows: [Row]) async throws -> World {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", rows)
        let (provider, _) = try await TestSession.signedIn(fake)
        let changes = DataChanges()
        return World(fake: fake, changes: changes, reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider, changes: changes))
    }

    private func list(_ w: World) -> ParcelListModel {
        let model = ParcelListModel(reader: w.reader, writer: w.writer, today: { Self.today }, now: { ISO.date("2026-11-04T03:00:00Z")! }, sleep: ControlledSleeper().sleep)
        model.changes = w.changes
        return model
    }

    private func detail(_ w: World, _ n: Int) -> ParcelDetailModel {
        let model = ParcelDetailModel(id: Rows.id(n), reader: w.reader, writer: w.writer, today: { Self.today })
        model.changes = w.changes
        return model
    }

    @Test func theListReadsAgainOnlyWhenStale() async throws {
        let w = try await world([Rows.parcel(1, ["expected_date": "2026-11-05"])])
        let model = list(w)
        await model.load()
        let reads = await w.fake.count("GET", "parcels")
        await model.onAppear()
        #expect(await w.fake.count("GET", "parcels") == reads)
        w.changes.publish()
        await model.onAppear()
        #expect(await w.fake.count("GET", "parcels") > reads)
    }

    @Test func theDetailReadsAgainOnlyWhenStale() async throws {
        let w = try await world([Rows.parcel(1)])
        let model = detail(w, 1)
        await model.load()
        let reads = await w.fake.count("GET", "parcels")
        await model.onAppear()
        #expect(await w.fake.count("GET", "parcels") == reads)
        w.changes.publish()
        await model.onAppear()
        #expect(await w.fake.count("GET", "parcels") > reads)
    }

    @Test func aChangeElsewhereIsShownOnTheList() async throws {
        let w = try await world([Rows.parcel(1, ["expected_date": "2026-11-05"])])
        let model = list(w)
        await model.load()
        await w.fake.touch("parcels", id: Rows.id(1), ["title": "変わった品名"])
        w.changes.publish()
        await model.onAppear()
        #expect(model.rows.first?.title == "変わった品名")
    }

    // MARK: CX1, the two paths of M1

    @Test func deliveredOnTheListLeavesTheCalendar() async throws {
        let w = try await world([Rows.parcel(1, ["expected_date": "2026-11-05", "status": "shipped"])])
        let calendar = CalendarModel(reader: w.reader, changes: w.changes, today: { Self.today })
        await calendar.load()
        #expect(calendar.entries(on: "2026-11-05").map(\.id) == [Rows.id(1)])

        let parcels = list(w)
        await parcels.load()
        await parcels.markDelivered(id: Rows.id(1))
        #expect(await w.fake.row("parcels", id: Rows.id(1))?["status"] == "delivered")

        // The calendar tab opened again.
        await calendar.onAppear()
        #expect(calendar.entries(on: "2026-11-05").isEmpty)
    }

    @Test func aCategoryChosenOnTheDetailIsCountedOnSpend() async throws {
        let w = try await world([Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1200, "category": nil])])
        let spend = SpendModel(reader: w.reader, writer: w.writer, changes: w.changes, today: { Self.today })
        await spend.load()
        #expect(spend.categoryRows.map(\.category) == [nil])

        let model = detail(w, 1)
        await model.load()
        #expect(await model.setCategory(.food) == true)

        await spend.onAppear()
        #expect(spend.categoryRows.map(\.category) == [.food])
        #expect(spend.categoryRows.first?.amount == 1200)
    }

    @Test func aScreenThatReadAfterTheWriteDoesNotReadAgain() async throws {
        let w = try await world([Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1200])])
        let model = detail(w, 1)
        await model.load()
        _ = await model.setCategory(.food)
        let spend = SpendModel(reader: w.reader, writer: w.writer, changes: w.changes, today: { Self.today })
        await spend.onAppear()
        let reads = await w.fake.count("GET", "parcels")
        await spend.onAppear()
        #expect(await w.fake.count("GET", "parcels") == reads)
    }
}
