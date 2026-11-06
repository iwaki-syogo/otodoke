import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 12] iOS-12 (back in front, the screen shown is read again, and only that one) and
/// 「古くなった」 reaching the list and the detail. CX1 (11/6 13:20): the writer publishes, the other
/// screens read again when next shown; the two paths of M1 are tested end to end.
@Suite("ScreenRefresher (batch 2, task 12)")
@MainActor
struct ScreenRefresherTests {
    final class Counter {
        var calls: [ScreenID] = []
    }

    private func refresher(_ ids: [ScreenID], _ counter: Counter) -> ScreenRefresher {
        let r = ScreenRefresher()
        for id in ids {
            r.register(id) { counter.calls.append(id) }
        }
        return r
    }

    @Test func onlyTheScreenInFrontReadsAgain() async {
        let counter = Counter()
        let r = refresher([.parcels, .calendar, .spend, .settings], counter)
        r.shown(.calendar)
        await r.sceneBecameActive()
        #expect(counter.calls == [.calendar])
        r.shown(.spend)
        await r.sceneBecameActive()
        #expect(counter.calls == [.calendar, .spend])
    }

    @Test func aDetailOverTheListIsTheOneInFront() async {
        let counter = Counter()
        let id = Rows.id(1)
        let r = refresher([.parcels, .detail(id)], counter)
        r.shown(.parcels)
        r.shown(.detail(id))
        await r.sceneBecameActive()
        #expect(counter.calls == [.detail(id)])
    }

    @Test func nothingInFrontReadsNothing() async {
        let counter = Counter()
        let r = refresher([.calendar], counter)
        r.shown(.calendar)
        r.hidden(.calendar)
        await r.sceneBecameActive()
        #expect(counter.calls.isEmpty)
    }

    @Test func anUnregisteredScreenIsNotCalled() async {
        let counter = Counter()
        let r = refresher([.settings], counter)
        r.shown(.settings)
        r.unregister(.settings)
        await r.sceneBecameActive()
        #expect(counter.calls.isEmpty)
    }

    @Test func eachComingBackReadsOnce() async {
        let counter = Counter()
        let r = refresher([.spend], counter)
        r.shown(.spend)
        r.shown(.spend)
        await r.sceneBecameActive()
        #expect(counter.calls == [.spend])
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
