import Foundation
import Testing
@testable import Otodoke

/// [Task 9] The parcel list's model: sections and order from the harness-checked rules, the counts and
/// notices, the swipe with its 6-second undo, the bulk 「すべて受取済にする」 (Codex-P1), the version
/// check (Codex-P2) and the three kinds of write result (Codex-P3), against FakeSupabase.
@Suite("ParcelListModel (task 9)")
@MainActor
struct ParcelListModelTests {
    nonisolated private static let today = "2026-11-04" // Wednesday
    nonisolated private static let now = ISO.date("2026-11-04T03:00:00Z")!

    private static let saveFailed = "保存できませんでした。もう一度スワイプしてください。"
    private static let undoFailed = "元に戻せませんでした"
    private static let unconfirmed = "確かめられませんでした"

    /// The list read: GET parcels without a status filter (the counts filter on status).
    nonisolated private static let isListRead: @Sendable (StubRequest) -> Bool = { r in
        r.method == "GET" && r.path == "/rest/v1/parcels" && r.query("status").isEmpty
    }

    private func make(_ fake: FakeSupabase) async throws -> (ParcelListModel, ControlledSleeper) {
        let (provider, _) = try await TestSession.signedIn(fake)
        let sleeper = ControlledSleeper()
        let model = ParcelListModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider),
            today: { Self.today },
            now: { Self.now },
            sleep: sleeper.sleep
        )
        return (model, sleeper)
    }

    /// 1: もうすぐ届く, 2: 配達中, 3: 注文中, 4: 要確認, 5: delivered, 6: cancelled — inserted shuffled.
    private func seed(_ fake: FakeSupabase) async {
        var rng = SplitMix64(seed: 3)
        await fake.insert("parcels", [
            Rows.parcel(1, ["status": "shipped", "expected_date": "2026-11-05"]),
            Rows.parcel(2, ["status": "out_for_delivery", "expected_date": "2026-11-04"]),
            Rows.parcel(3, ["status": "ordered", "expected_date": "2026-11-10"]),
            Rows.parcel(4, ["status": "shipped", "expected_date": "2026-10-01"]),
            Rows.parcel(5, ["status": "delivered"]),
            Rows.parcel(6, ["status": "cancelled"]),
        ].shuffled(using: &rng))
    }

    private func ids(_ rows: [ParcelRow]) -> [String] { rows.map(\.id) }

    private func status(_ fake: FakeSupabase, _ n: Int) async -> String? {
        await fake.row("parcels", id: Rows.id(n))?["status"]?.string
    }

    private func listReads(_ fake: FakeSupabase) async -> Int {
        await fake.requests().filter(Self.isListRead).count
    }

    // MARK: load

    @Test func groupsAndOrdersLikeTheWeb() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.loadState == .loaded)
        #expect(ids(model.rows) == [4, 2, 1, 3, 5, 6].map(Rows.id))
        #expect(ids(model.sections.toCheck) == [Rows.id(4)])
        #expect(ids(model.sections.delivering) == [Rows.id(2)])
        #expect(ids(model.sections.soon) == [Rows.id(1)])
        #expect(ids(model.sections.ordered) == [Rows.id(3)])
        #expect(model.sections == ParcelRules.sections(ParcelRules.baseOrder(model.rows), today: Self.today))
        #expect(model.isEmpty == false)
        #expect(model.showsSwipeHint == true)
        #expect(model.deliveredCount == 1)
        #expect(model.cancelledCount == 1)
        #expect(model.waitingNotice == nil)
    }

    @Test func requiresCheckShowsFiveAndKeepsTheRest() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", (11...17).map { Rows.parcel($0, ["expected_date": .string("2026-09-\(String(format: "%02d", $0 - 10))")]) })
        let (model, _) = try await make(fake)
        await model.load()
        #expect(ids(model.toCheckHead) == (11...15).map(Rows.id))
        #expect(ids(model.toCheckRest) == (16...17).map(Rows.id))
        #expect(ParcelListModel.toCheckHeadCount == 5)
    }

    @Test func noticesUnreadMail() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        await fake.setUnreadEmails(3)
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.waitingNotice == "まだ読んでいないメールが 3 通あります。この一覧は最新ではないかもしれません。")
    }

    @Test func aFailedUnreadCountShowsNoNotice() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        await fake.setUnreadEmails(3)
        await fake.fail(where: { $0.path == "/rest/v1/emails" }, with: .http(500))
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.waitingNotice == nil)
        #expect(model.loadState == .loaded)
    }

    @Test func aFailedCountShowsTheLinkWithoutANumber() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        await fake.fail(where: { $0.path == "/rest/v1/parcels" && $0.query("status") == ["eq.delivered"] }, with: .http(500))
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.deliveredCount == nil)
        #expect(model.cancelledCount == 1)
        #expect(model.loadState == .loaded)
    }

    @Test func aFailedListSaysSoAndStillCounts() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        await fake.fail(where: Self.isListRead, with: .http(500))
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.loadState == .failed)
        #expect(model.isEmpty == false)
        #expect(model.deliveredCount == 1)
        #expect(model.cancelledCount == 1)
    }

    @Test func noParcelsIsTheEmptyScreenWithItsLinks() async throws {
        let fake = FakeSupabase.make()
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.loadState == .loaded)
        #expect(model.isEmpty == true)
        #expect(model.showsSwipeHint == false)
        #expect(model.deliveredCount == 0)
        #expect(model.cancelledCount == 0)
    }

    @Test func onlyClosedParcelsIsNotEmptyButHasNoHint() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(5, ["status": "delivered"])])
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.isEmpty == false)
        #expect(model.showsSwipeHint == false)
        #expect(model.sections.open.isEmpty)
    }

    // MARK: swipe → 届いた

    @Test func swipeSavesThenOffersUndoForSixSeconds() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, sleeper) = try await make(fake)
        await model.load()
        let gate = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(gate))
        let task = Task { await model.markDelivered(id: Rows.id(1)) }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })
        #expect(model.saving.contains(Rows.id(1)))
        gate.open()
        await task.value
        #expect(model.saving.isEmpty)
        #expect(model.toast == ListToast(text: "届いたにしました", canUndo: true))
        #expect(!ids(model.sections.soon).contains(Rows.id(1)))
        #expect(model.rowMessages[Rows.id(1)] == nil)
        #expect(await waitFor { sleeper.pendingCount == 1 })
        #expect(sleeper.requested.contains(.seconds(6)))
        #expect(ParcelListModel.toastDuration == .seconds(6))
        sleeper.fireOldest()
        #expect(await waitFor { await model.toast == nil })
    }

    @Test func aNewToastIsNotClearedByTheOldTimer() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, sleeper) = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        #expect(await waitFor { sleeper.requested.count == 1 })
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "1 件を受取済にしました", canUndo: true))
        #expect(await waitFor { sleeper.requested.count == 2 })
        if sleeper.pendingCount == 2 { sleeper.fireOldest() }
        try? await Task.sleep(for: .milliseconds(50))
        #expect(model.toast == ListToast(text: "1 件を受取済にしました", canUndo: true))
        sleeper.fireAll()
        #expect(await waitFor { await model.toast == nil })
    }

    @Test func undoPutsTheParcelBack() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        let gate = Gate()
        await fake.fail("PATCH", "parcels", nth: 2, with: .hold(gate))
        let task = Task { await model.undo() }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 2 })
        #expect(model.isUndoing == true)
        gate.open()
        await task.value
        #expect(model.isUndoing == false)
        #expect(model.toast == nil)
        #expect(await status(fake, 1) == "shipped")
        #expect(ids(model.sections.soon).contains(Rows.id(1)))
    }

    @Test func undoAfterADeliveryMailReloadsAndSaysItCouldNot() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        await fake.touch("parcels", id: Rows.id(1), ["status": "delivered"])
        let readsBefore = await listReads(fake)
        await model.undo()
        #expect(model.toast?.text == Self.undoFailed)
        #expect(model.toast?.canUndo == false)
        #expect(await listReads(fake) > readsBefore)
        #expect(await status(fake, 1) == "delivered")
    }

    @Test func aFailedUndoSaysItCouldNot() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        await fake.fail("PATCH", "parcels", nth: 2, with: .http(500))
        await model.undo()
        #expect(model.toast?.text == Self.undoFailed)
        #expect(model.toast?.canUndo == false)
    }

    @Test(arguments: [FakeSupabase.FaultKind.transport(.notConnectedToInternet), .http(500)])
    func aSwipeThatSurelyFailedPutsTheCardBack(fault: FakeSupabase.FaultKind) async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: fault)
        await model.markDelivered(id: Rows.id(1))
        #expect(ids(model.sections.soon) == [Rows.id(1)])
        #expect(model.rowMessages[Rows.id(1)] == Self.saveFailed)
        #expect(model.saving.isEmpty)
        #expect(model.toast == nil)
        #expect(await status(fake, 1) == "shipped")
    }

    @Test func aDeliveryMailBeforeTheSwipeReloadsAndOffersNoUndo() async throws {
        // Codex-P2: list read → delivery mail → swipe → undo must not undo the mail.
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.touch("parcels", id: Rows.id(1), ["status": "delivered"])
        await model.markDelivered(id: Rows.id(1))
        #expect(model.toast?.canUndo != true)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(await listReads(fake) == 2)
        #expect(!ids(model.sections.open).contains(Rows.id(1)))
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(await status(fake, 1) == "delivered")
    }

    @Test func aLostAnswerReloadsInsteadOfSendingAgain() async throws {
        // Codex-P3: the write happened, its answer was lost.
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await model.markDelivered(id: Rows.id(1))
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(await listReads(fake) == 2)
        #expect(!ids(model.sections.open).contains(Rows.id(1)))
        #expect(model.toast?.canUndo != true)
        #expect(model.rowMessages[Rows.id(1)] == nil)
    }

    @Test func aLostAnswerAndAFailedReloadIsNotDecided() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.markDelivered(id: Rows.id(1))
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.rowMessages[Rows.id(1)] == Self.unconfirmed)
        #expect(model.toast?.canUndo != true)
        #expect(model.saving.isEmpty)
    }

    // MARK: すべて受取済にする (Codex-P1)

    private func seedCheck(_ fake: FakeSupabase) async {
        await fake.insert("parcels", [
            Rows.parcel(4, ["expected_date": "2026-10-01"]),
            Rows.parcel(7, ["expected_date": "2026-10-02", "status": "ordered"]),
            Rows.parcel(8, ["expected_date": "2026-10-03"]),
        ])
    }

    @Test func deliverAllThenUndoAll() async throws {
        let fake = FakeSupabase.make()
        await seedCheck(fake)
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.deliverAllEnabled == true)
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "3 件を受取済にしました", canUndo: true))
        #expect(model.sections.toCheck.isEmpty)
        await model.undo()
        #expect(model.toast == nil)
        #expect(await status(fake, 4) == "shipped")
        #expect(await status(fake, 7) == "ordered")
        #expect(await status(fake, 8) == "shipped")
    }

    @Test func deliverAllCountsOnlyWhatWasWrittenAndUndoesOnlyThat() async throws {
        let fake = FakeSupabase.make()
        await seedCheck(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.touch("parcels", id: Rows.id(7), ["status": "cancelled"])
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "2 件を受取済にしました", canUndo: true))
        let before = await fake.count("PATCH", "parcels")
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") - before == 2)
        #expect(await status(fake, 7) == "cancelled")
        #expect(await status(fake, 4) == "shipped")
        #expect(await status(fake, 8) == "shipped")
    }

    @Test func deliverAllWithOneFailureKeepsThatOneToCheck() async throws {
        let fake = FakeSupabase.make()
        await seedCheck(fake)
        let (model, _) = try await make(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", nth: 2, with: .http(500))
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "2 件を受取済にしました", canUndo: true))
        #expect(ids(model.sections.toCheck) == [Rows.id(7)])
        #expect(await status(fake, 7) == "ordered")
    }

    @Test func deliverAllShowsTheSpinnerFromThePress() async throws {
        let fake = FakeSupabase.make()
        await seedCheck(fake)
        let (model, _) = try await make(fake)
        await model.load()
        let gate = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(gate))
        let task = Task { await model.deliverAll() }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })
        #expect(model.isDeliveringAll == true)
        gate.open()
        await task.value
        #expect(model.isDeliveringAll == false)
    }

    @Test func moreThanFiveHundredToCheckCannotBePressed() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", (1...501).map { Rows.parcel($0, ["expected_date": "2026-09-01"]) })
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.sections.toCheck.count == 501)
        #expect(model.deliverAllEnabled == false)
        await model.deliverAll()
        #expect(await fake.count("PATCH", "parcels") == 0)
    }

    @Test func nothingToCheckCannotBePressed() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["expected_date": "2026-11-05"])])
        let (model, _) = try await make(fake)
        await model.load()
        #expect(model.deliverAllEnabled == false)
    }
}

/// [Task 9] The card (src/app/app/parcel-card.tsx, branches copied by hand: not in the harness),
/// the tabs and the page-link count.
@Suite("ParcelCardContent, tabs and links (task 9)")
struct ParcelCardContentTests {
    nonisolated private static let today = "2026-11-04" // Wednesday

    private func card(_ over: Row) throws -> ParcelCardContent {
        ParcelCardContent.make(try Rows.parcelRow(Rows.parcel(1, over)), today: Self.today)
    }

    @Test func todayTomorrowAndADate() throws {
        #expect(try card(["expected_date": "2026-11-04"]).when == "今日")
        #expect(try card(["expected_date": "2026-11-05"]).when == "明日")
        #expect(try card(["expected_date": "2026-11-09"]).when == "11/9(月)")
        #expect(try card(["expected_date": "2027-01-05"]).when == "2027/1/5(火)")
    }

    @Test func aWindow() throws {
        #expect(try card(["expected_date": "2026-11-04", "expected_date_end": "2026-11-06"]).when == "今日〜11/6(金)")
        // Started in the past, not over yet: not late.
        #expect(try card(["expected_date": "2026-11-03", "expected_date_end": "2026-11-05"]).when == "昨日〜明日")
    }

    @Test func lateSaysPlanned() throws {
        #expect(try card(["expected_date": "2026-11-03"]).when == "昨日の予定")
        #expect(try card(["expected_date": "2026-10-20", "expected_date_end": "2026-10-25"]).when == "10/20(火)〜10/25(日)の予定")
        // Delivered or cancelled is never late.
        #expect(try card(["expected_date": "2026-11-03", "status": "delivered"]).when == "昨日")
        #expect(try card(["expected_date": "2026-11-03", "status": "cancelled"]).when == "昨日")
    }

    @Test func timeOfDay() throws {
        #expect(try card(["expected_date": "2026-11-05", "expected_window_start": "08:00:00", "expected_window_end": "12:00:00"]).window == "午前中")
        #expect(try card(["expected_date": "2026-11-05", "expected_window_start": "14:00:00", "expected_window_end": "16:00:00"]).window == "14:00〜16:00")
        #expect(try card(["expected_date": "2026-11-05"]).window == "")
    }

    @Test func noDateYet() throws {
        let ordered = try card(["status": "ordered"])
        #expect(ordered.when == nil)
        #expect(ordered.undecided == true)
        let shipped = try card(["status": "shipped"])
        #expect(shipped.when == nil)
        #expect(shipped.undecided == false)
        #expect(try card(["status": "ordered", "expected_date": "2026-11-05"]).undecided == false)
    }

    @Test func titleShopStatusAndMarks() throws {
        let c = try card(["title": nil, "shop": "テスト店", "status": "attempted", "needs_review": true])
        #expect(c.title == "品名の記載なし")
        #expect(c.shop == "テスト店")
        #expect(c.statusLabel == "不在・再配達")
        #expect(c.needsReview == true)
        #expect(c.presenceBadge == "🤝 対面受け取り")
        #expect(try card(["requires_presence": false]).presenceBadge == "置き配・投函OK")
        #expect(try card(["shop_key": "amazon"]).presenceBadge == nil)
    }

    @Test func tabsInTheWebsOrder() {
        #expect(MainTab.allCases.map(\.title) == ["荷物", "カレンダー", "支出", "設定"])
    }

    @Test func pageLinkCounts() {
        #expect(PageLinkText.count(0) == "0 件")
        #expect(PageLinkText.count(1234) == "1,234 件")
    }
}
