import Foundation
import Testing
@testable import Otodoke

/// [Task 9, implementer's own] Cases of the list model beyond the test architect's suite: the bulk
/// failure message, an undo whose answer is lost, and the delivered count kept in step.
@Suite("ParcelListModel extra (task 9)")
@MainActor
struct ParcelListModelExtraTests {
    nonisolated private static let today = "2026-11-04"
    nonisolated private static let now = ISO.date("2026-11-04T03:00:00Z")!

    nonisolated private static let isListRead: @Sendable (StubRequest) -> Bool = { r in
        r.method == "GET" && r.path == "/rest/v1/parcels" && r.query("status").isEmpty
    }

    private func make(_ fake: FakeSupabase) async throws -> ParcelListModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        let sleeper = ControlledSleeper()
        return ParcelListModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider),
            today: { Self.today },
            now: { Self.now },
            sleep: sleeper.sleep
        )
    }

    private func seedCheck(_ fake: FakeSupabase) async {
        await fake.insert("parcels", [
            Rows.parcel(4, ["expected_date": "2026-10-01"]),
            Rows.parcel(7, ["expected_date": "2026-10-02", "status": "ordered"]),
        ])
    }

    @Test func aFailedRowInDeliverAllSaysSoUnderTheButton() async throws {
        let fake = FakeSupabase.make()
        await seedCheck(fake)
        let model = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", nth: 2, with: .http(500))
        await model.deliverAll()
        #expect(model.deliverAllMessage == "保存できませんでした。もう一度押してください。")
        #expect(model.toast == ListToast(text: "1 件を受取済にしました", canUndo: true))
        // A fresh load clears the message.
        await model.load()
        #expect(model.deliverAllMessage == nil)
    }

    @Test func deliverAllWithNothingWrittenShowsNoToast() async throws {
        let fake = FakeSupabase.make()
        await seedCheck(fake)
        let model = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: .http(500))
        await fake.fail("PATCH", "parcels", nth: 2, with: .http(500))
        await model.deliverAll()
        #expect(model.toast == nil)
        #expect(model.deliverAllMessage != nil)
        #expect(model.sections.toCheck.count == 2)
    }

    @Test func anUndoWhoseAnswerIsLostAndTheReadFailsIsNotDecided() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped", "expected_date": "2026-11-05"])])
        let model = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        await fake.fail("PATCH", "parcels", nth: 2, with: .applyThenDrop(.networkConnectionLost))
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == 2)
        #expect(model.toast == ListToast(text: "確かめられませんでした", canUndo: false))
    }

    @Test func anUndoWhoseAnswerIsLostButTheReadShowsItBackHidesTheToast() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped", "expected_date": "2026-11-05"])])
        let model = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        await fake.fail("PATCH", "parcels", nth: 2, with: .applyThenDrop(.networkConnectionLost))
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == 2)
        #expect(model.toast == nil)
        #expect(model.sections.soon.map(\.id) == [Rows.id(1)])
    }

    @Test func theDeliveredCountFollowsTheSwipeAndTheUndo() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [
            Rows.parcel(1, ["status": "shipped", "expected_date": "2026-11-05"]),
            Rows.parcel(5, ["status": "delivered"]),
        ])
        let model = try await make(fake)
        await model.load()
        #expect(model.deliveredCount == 1)
        await model.markDelivered(id: Rows.id(1))
        #expect(model.deliveredCount == 2)
        await model.undo()
        #expect(model.deliveredCount == 1)
    }

    @Test func backFromADetailReadsTheListAgain() async throws {
        // 「届いていない」 on the detail page put a delivered parcel back to shipped.
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(5, ["status": "delivered", "expected_date": "2026-11-05"])])
        let model = try await make(fake)
        await model.load()
        #expect(model.sections.open.isEmpty)
        await fake.touch("parcels", id: Rows.id(5), ["status": "shipped"])
        let before = await fake.requests().filter(Self.isListRead).count
        await model.returnedFromDetail()
        #expect(await fake.requests().filter(Self.isListRead).count == before + 1)
        #expect(model.sections.soon.map(\.id) == [Rows.id(5)])
        #expect(model.refreshFailed == false)
    }

    @Test func aFailedReadBackFromADetailKeepsTheListAndSaysSo() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped", "expected_date": "2026-11-05"])])
        let model = try await make(fake)
        await model.load()
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.returnedFromDetail()
        #expect(model.loadState == .loaded)
        #expect(model.refreshFailed == true)
        #expect(model.sections.soon.map(\.id) == [Rows.id(1)])
        // The next read that works takes the message away.
        await model.load()
        #expect(model.refreshFailed == false)
    }

    @Test func aFirstReadThatFailsShowsNoList() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped", "expected_date": "2026-11-05"])])
        await fake.fail(where: Self.isListRead, with: .http(500))
        let model = try await make(fake)
        await model.load()
        #expect(model.loadState == .failed)
        #expect(model.rows.isEmpty)
    }

    @Test func aSwipeOnAParcelNotInTheListSendsNothing() async throws {
        let fake = FakeSupabase.make()
        let model = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(42))
        #expect(await fake.count("PATCH", "parcels") == 0)
        #expect(model.toast == nil)
    }
}
