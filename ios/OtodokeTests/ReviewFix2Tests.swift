import Foundation
import Testing
@testable import Otodoke

/// [Fix 2: R1・NtH-1・NtH-2] What the list and the detail say after an unknown write: the toast counts
/// rows that 「元に戻す」 cannot put back and says so (and says so again after 「元に戻す」), 「確かめる」
/// shows 確認中… rather than 保存中…, and a tap after 「確かめられませんでした」 says when nothing had been saved.
@Suite("Review fix 2")
@MainActor
struct ReviewFix2Tests {
    nonisolated private static let now = ISO.date("2026-11-04T03:00:00Z")!

    nonisolated private static let isListRead: @Sendable (StubRequest) -> Bool = { r in
        r.method == "GET" && r.path == "/rest/v1/parcels" && r.query("status").isEmpty
    }

    private func makeList(_ fake: FakeSupabase) async throws -> ParcelListModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelListModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider),
            today: { "2026-11-04" },
            now: { Self.now },
            sleep: ControlledSleeper().sleep
        )
    }

    /// 1: もうすぐ届く. 4, 7, 8: 要確認.
    private func seed(_ fake: FakeSupabase) async {
        await fake.insert("parcels", [
            Rows.parcel(1, ["expected_date": "2026-11-05"]),
            Rows.parcel(4, ["expected_date": "2026-10-01"]),
            Rows.parcel(7, ["expected_date": "2026-10-02", "status": "ordered"]),
            Rows.parcel(8, ["expected_date": "2026-10-03"]),
        ])
    }

    private func status(_ fake: FakeSupabase, _ n: Int) async -> String? {
        await fake.row("parcels", id: Rows.id(n))?["status"]?.string
    }

    // MARK: R1

    @Test func deliverAllSaysHowManyCannotBeUndone() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await makeList(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", nth: 2, with: .applyThenDrop(.networkConnectionLost))
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        #expect(model.toastNote == "1 件は元に戻せません")

        await model.undo()
        #expect(await status(fake, 4) == "shipped")
        #expect(await status(fake, 7) == "delivered")
        #expect(await status(fake, 8) == "shipped")
        // Not hidden as if all went back: says which stay delivered.
        #expect(model.toast == ListToast(text: "2 件を元に戻しました。1 件は受取済のままです", canUndo: false))
        #expect(model.toastNote == nil)
    }

    @Test func deliverAllWithEveryAnswerHasNoNoteAndUndoHidesTheToast() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await makeList(fake)
        await model.load()
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        #expect(model.toastNote == nil)
        await model.undo()
        #expect(model.toast == nil)
        #expect(model.toastNote == nil)
        #expect(await status(fake, 7) == "ordered")
    }

    @Test func aNewerToastDropsTheOldNote() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await makeList(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", nth: 2, with: .applyThenDrop(.networkConnectionLost))
        await model.deliverAll()
        #expect(model.toastNote == "1 件は元に戻せません")
        await model.markDelivered(id: Rows.id(1))
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        #expect(model.toastNote == nil)
        // 「元に戻す」 of the newer toast has nothing left delivered to speak of.
        await model.undo()
        #expect(model.toast == nil)
        #expect(await status(fake, 1) == "shipped")
    }

    // MARK: NtH-1

    @Test func checkingAnUnknownSwipeShowsCheckingNotSaving() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await makeList(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.markDelivered(id: Rows.id(1))
        #expect(model.unconfirmed == [Rows.id(1)])
        #expect(model.checking.isEmpty)

        let gate = Gate()
        await fake.fail(where: Self.isListRead, nth: 3, with: .hold(gate))
        let task = Task { await model.markDelivered(id: Rows.id(1)) }
        #expect(await waitFor { await model.checking == [Rows.id(1)] })
        #expect(model.saving == [Rows.id(1)])
        gate.open()
        await task.value
        #expect(model.checking.isEmpty)
        #expect(model.saving.isEmpty)
        #expect(await fake.count("PATCH", "parcels") == 1)
    }

    @Test func aSwipeThatSendsIsNotChecking() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await makeList(fake)
        await model.load()
        let gate = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(gate))
        let task = Task { await model.markDelivered(id: Rows.id(1)) }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })
        #expect(model.saving == [Rows.id(1)])
        #expect(model.checking.isEmpty)
        gate.open()
        await task.value
    }

    // MARK: NtH-2

    private func seededDetail() async throws -> (FakeSupabase, ParcelDetailModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "category": "food"])])
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
        await model.load()
        return (fake, model)
    }

    private func stored(_ fake: FakeSupabase, _ column: String) async -> String? {
        await fake.row("parcels", id: Rows.id(1))?[column]?.string
    }

    @Test func notDeliveredThatHadNotGoneThroughSaysSoOnTheNextTap() async throws {
        let (fake, model) = try await seededDetail()
        // Timed out without reaching the database; the read after it fails too.
        await fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await fake.fail("GET", "parcels", nth: 3, with: .http(500))
        await model.markNotDelivered()
        #expect(model.notDeliveredError == "確かめられませんでした")

        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.isUnconfirmed == false)
        #expect(model.notDeliveredError == "保存されていませんでした。もう一度押してください。")
        #expect(model.showsNotDelivered == true)

        // The next tap sends.
        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 2)
        #expect(model.notDeliveredError == nil)
        #expect(model.showsNotDelivered == false)
    }

    @Test func notDeliveredThatHadGoneThroughJustShowsTheNewState() async throws {
        let (fake, model) = try await seededDetail()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.timedOut))
        await fake.fail("GET", "parcels", nth: 3, with: .http(500))
        await model.markNotDelivered()
        #expect(model.notDeliveredError == "確かめられませんでした")

        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.notDeliveredError == nil)
        #expect(model.showsNotDelivered == false)
    }

    @Test func aCategoryThatHadNotGoneThroughSaysSoOnTheNextChoice() async throws {
        let (fake, model) = try await seededDetail()
        await fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await fake.fail("GET", "parcels", nth: 2, with: .http(500))
        #expect(await model.setCategory(.hobby) == false)
        #expect(model.categoryError == "確かめられませんでした")

        #expect(await model.setCategory(.daily) == false)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.shownCategory == .food)
        #expect(model.categoryError == "保存されていませんでした。もう一度選んでください。")

        #expect(await model.setCategory(.daily) == true)
        #expect(await stored(fake, "category") == "daily")
        #expect(model.categoryError == nil)
    }

    @Test func choosingTheStoredCategoryAfterAnUnknownSaysNothingMore() async throws {
        let (fake, model) = try await seededDetail()
        await fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await fake.fail("GET", "parcels", nth: 2, with: .http(500))
        #expect(await model.setCategory(.hobby) == false)

        #expect(await model.setCategory(.food) == false)
        #expect(model.shownCategory == .food)
        #expect(model.categoryError == nil)
    }
}
