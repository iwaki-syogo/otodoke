import Foundation
import Testing
@testable import Otodoke

/// [Fix S1・S3・C1〜C3・N2〜N5] The list when reads, writes and 「元に戻す」 overlap, built from the
/// orders that broke it: a slow read answered before a write, an unknown write whose read fails too,
/// an older 「元に戻す」 finishing under a newer toast.
@Suite("ParcelListModel overlaps (fix 1)")
@MainActor
struct ParcelListConcurrencyTests {
    nonisolated private static let now = ISO.date("2026-11-04T03:00:00Z")!

    nonisolated private static let isListRead: @Sendable (StubRequest) -> Bool = { r in
        r.method == "GET" && r.path == "/rest/v1/parcels" && r.query("status").isEmpty
    }

    /// The day the model sees, changed by the test.
    final class Day: @unchecked Sendable {
        private let lock = NSLock()
        private var value = "2026-11-04"
        var today: String {
            get { lock.withLock { value } }
            set { lock.withLock { value = newValue } }
        }
    }

    private func make(_ fake: FakeSupabase, day: Day = Day()) async throws -> (ParcelListModel, ControlledSleeper) {
        let (provider, _) = try await TestSession.signedIn(fake)
        let sleeper = ControlledSleeper()
        let model = ParcelListModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider),
            today: { day.today },
            now: { Self.now },
            sleep: sleeper.sleep
        )
        return (model, sleeper)
    }

    /// 1, 2: もうすぐ届く. 4, 7, 8: 要確認.
    private func seed(_ fake: FakeSupabase) async {
        await fake.insert("parcels", [
            Rows.parcel(1, ["expected_date": "2026-11-05"]),
            Rows.parcel(2, ["expected_date": "2026-11-06"]),
            Rows.parcel(4, ["expected_date": "2026-10-01"]),
            Rows.parcel(7, ["expected_date": "2026-10-02", "status": "ordered"]),
            Rows.parcel(8, ["expected_date": "2026-10-03"]),
        ])
    }

    private func listReads(_ fake: FakeSupabase) async -> Int {
        await fake.requests().filter(Self.isListRead).count
    }

    private func status(_ fake: FakeSupabase, _ n: Int) async -> String? {
        await fake.row("parcels", id: Rows.id(n))?["status"]?.string
    }

    private func isOpen(_ model: ParcelListModel, _ n: Int) -> Bool {
        model.sections.open.contains { $0.id == Rows.id(n) }
    }

    // MARK: C1: an unknown write is never sent again until a read settles it

    @Test func aLostAnswerThenAFailedReadThenASwipeSendsNothing() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await fake.fail(where: Self.isListRead, nth: 3, with: .transport(.notConnectedToInternet))
        await model.markDelivered(id: Rows.id(1))
        #expect(model.unconfirmed == [Rows.id(1)])
        #expect(model.rowMessages[Rows.id(1)] == "確かめられませんでした")
        // N5: the failed read says so above the list.
        #expect(model.refreshFailed == true)

        // Swiped again while it is not known: only a read, and that read fails too.
        await model.markDelivered(id: Rows.id(1))
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(await listReads(fake) == 3)
        #expect(model.unconfirmed == [Rows.id(1)])
        #expect(model.rowMessages[Rows.id(1)] == "確かめられませんでした")

        // A read that works settles it: the swipe had gone through.
        await model.markDelivered(id: Rows.id(1))
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.unconfirmed.isEmpty)
        #expect(model.rowMessages[Rows.id(1)] == nil)
        #expect(!isOpen(model, 1))
        #expect(await status(fake, 1) == "delivered")
    }

    @Test func aCheckToConfirmThatFindsItUndoneLetsTheNextSwipeWrite() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        // Sent and lost before it reached the database.
        await fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        await fake.fail(where: Self.isListRead, nth: 2, with: .http(500))
        await model.markDelivered(id: Rows.id(1))
        #expect(model.unconfirmed == [Rows.id(1)])
        await model.markDelivered(id: Rows.id(1)) // reads: still open
        #expect(model.unconfirmed.isEmpty)
        #expect(isOpen(model, 1))
        #expect(await fake.count("PATCH", "parcels") == 1)
        await model.markDelivered(id: Rows.id(1)) // now it writes
        #expect(await fake.count("PATCH", "parcels") == 2)
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
    }

    @Test func deliverAllLeavesOutARowNotYetConfirmed() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.markDelivered(id: Rows.id(4))
        #expect(model.unconfirmed == [Rows.id(4)])
        let before = await fake.requests("PATCH", "parcels").count
        await model.deliverAll()
        let sent = await fake.requests("PATCH", "parcels").dropFirst(before)
        #expect(sent.count == 2)
        #expect(!sent.contains { $0.query("id") == ["eq.\(Rows.id(4))"] })
        // The read after it settled row 4 (it had gone through).
        #expect(model.unconfirmed.isEmpty)
        #expect(model.sections.toCheck.isEmpty)
    }

    // MARK: S3 / C2: a slow read never puts back what a write changed

    @Test func aSlowReadAnsweredBeforeASwipeDoesNotUndoTheSwipe() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        let gate = Gate()
        await fake.fail(where: Self.isListRead, nth: 2, with: .delay(gate))
        let refresh = Task { await model.load() }
        #expect(await waitFor { await listReads(fake) == 2 })
        await model.markDelivered(id: Rows.id(1))
        #expect(!isOpen(model, 1))
        gate.open()
        await refresh.value
        #expect(await waitFor { await listReads(fake) == 3 })
        #expect(await waitFor { await model.rows.contains { $0.id == Rows.id(1) && $0.status == "delivered" } })
        #expect(!isOpen(model, 1))
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        #expect(model.refreshFailed == false)
    }

    @Test func aReadAnsweredWhileASwipeIsInFlightIsReadAgainAfterIt() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        let patch = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(patch))
        let swipe = Task { await model.markDelivered(id: Rows.id(1)) }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })
        await model.load() // answered while the swipe is in flight: not shown
        #expect(await listReads(fake) == 2)
        patch.open()
        await swipe.value
        // Read again once the write is done, and that read is shown.
        #expect(await waitFor { await listReads(fake) == 3 })
        #expect(await waitFor { await model.rows.contains { $0.id == Rows.id(1) && $0.status == "delivered" } })
        #expect(!isOpen(model, 1))
    }

    @Test func theNewestReadWinsOverAnOlderOneAnsweredLater() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        let gate = Gate()
        await fake.fail(where: Self.isListRead, nth: 2, with: .delay(gate))
        let older = Task { await model.load() }
        #expect(await waitFor { await listReads(fake) == 2 })
        await fake.touch("parcels", id: Rows.id(2), ["status": "delivered"])
        await model.load()
        #expect(!isOpen(model, 2))
        gate.open()
        await older.value
        #expect(!isOpen(model, 2))
        #expect(await listReads(fake) == 3)
    }

    @Test func anOlderReadThatFailsLateDoesNotSaySo() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        let gate = Gate()
        await fake.fail(where: Self.isListRead, nth: 2, with: .holdThen(gate, .transport(.networkConnectionLost)))
        let older = Task { await model.load() }
        #expect(await waitFor { await listReads(fake) == 2 })
        await model.load()
        gate.open()
        await older.value
        #expect(model.refreshFailed == false)
        #expect(model.loadState == .loaded)
    }

    // MARK: S1 / C3: an older 「元に戻す」 never touches a newer toast

    @Test func anOlderUndoLeavesTheNewerToastAndItsUndo() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        let gate = Gate()
        await fake.fail("PATCH", "parcels", nth: 2, with: .hold(gate))
        let undoA = Task { await model.undo() }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 2 })
        #expect(model.isUndoing == true)
        await model.markDelivered(id: Rows.id(2))
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        // 「戻しています…」 belongs to A's toast, not B's.
        #expect(model.isUndoing == false)
        gate.open()
        await undoA.value
        #expect(await status(fake, 1) == "shipped")
        #expect(isOpen(model, 1))
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        // B's 「元に戻す」 still works.
        await model.undo()
        #expect(await status(fake, 2) == "shipped")
        #expect(model.toast == nil)
    }

    @Test func anOlderUndoThatFailsLeavesTheNewerToast() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        let gate = Gate()
        await fake.fail("PATCH", "parcels", nth: 2, with: .holdThen(gate, .http(500)))
        let undoA = Task { await model.undo() }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 2 })
        await model.markDelivered(id: Rows.id(2))
        gate.open()
        await undoA.value
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        await model.undo()
        #expect(await status(fake, 2) == "shipped")
        #expect(await status(fake, 1) == "delivered")
    }

    @Test func theOldTimerDoesNotClearTheToastWhileItsUndoIsSent() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, sleeper) = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        let gate = Gate()
        await fake.fail("PATCH", "parcels", nth: 2, with: .hold(gate))
        let undo = Task { await model.undo() }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 2 })
        sleeper.fireAll()
        try? await Task.sleep(for: .milliseconds(50))
        #expect(model.toast != nil)
        gate.open()
        await undo.value
        #expect(model.toast == nil)
    }

    // MARK: N2・N3: 「すべて受取済にする」

    @Test func deliverAllCountsAnUnknownRowTheReadShowsDelivered() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", nth: 2, with: .applyThenDrop(.networkConnectionLost))
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        #expect(model.deliverAllMessage == nil)
        #expect(model.sections.toCheck.isEmpty)
        // 「元に戻す」 puts back only the rows whose write was answered.
        await model.undo()
        #expect(await status(fake, 4) == "shipped")
        #expect(await status(fake, 7) == "delivered")
        #expect(await status(fake, 8) == "shipped")
    }

    @Test func deliverAllWithEveryAnswerLostSaysHowManyWithoutUndo() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(4, ["expected_date": "2026-10-01"])])
        let (model, _) = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: false))
        #expect(await fake.count("PATCH", "parcels") == 1)
    }

    @Test func deliverAllShowsHowFarItHasGot() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        let gate = Gate()
        await fake.fail("PATCH", "parcels", nth: 2, with: .hold(gate))
        let task = Task { await model.deliverAll() }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 2 })
        #expect(await waitFor { await model.deliverAllProgress == BulkProgress(done: 1, total: 3) })
        #expect(model.deliverAllProgressText == "保存中… 1/3")
        gate.open()
        await task.value
        #expect(model.deliverAllProgress == nil)
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
    }

    // MARK: N5

    @Test func aConflictWhoseReadFailsSaysTheListCouldNotBeRead() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.touch("parcels", id: Rows.id(1), ["title": "変わった"])
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.markDelivered(id: Rows.id(1))
        #expect(model.refreshFailed == true)
        #expect(model.rowMessages[Rows.id(1)] == "保存できませんでした。もう一度スワイプしてください。")
    }

    // MARK: N4: sections follow the rows and the day

    @Test func theSectionsFollowTheRowsAndTheDay() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let day = Day()
        let (model, _) = try await make(fake, day: day)
        await model.load()
        #expect(model.sections.soon.map(\.id) == [Rows.id(1), Rows.id(2)])
        #expect(model.sections == ParcelRules.sections(model.rows, today: day.today))
        await model.markDelivered(id: Rows.id(1))
        #expect(model.sections.soon.map(\.id) == [Rows.id(2)])
        #expect(model.sections == ParcelRules.sections(model.rows, today: day.today))
        day.today = "2026-11-30" // two weeks after 11/6: 2 is to check now
        #expect(model.sections.toCheck.map(\.id).contains(Rows.id(2)))
        #expect(model.sections == ParcelRules.sections(model.rows, today: day.today))
    }
}
