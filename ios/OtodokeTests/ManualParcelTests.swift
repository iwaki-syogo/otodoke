import Foundation
import Testing
@testable import Otodoke

/// 「＋ 登録」 (a parcel typed in by hand): the checks at their edges, the columns written, the one insert
/// against FakeSupabase (its content, user_id, the result kinds), and that a result that is unknown is
/// never sent again.
@Suite("Manual parcel (new)")
@MainActor
struct ManualParcelTests {
    /// 2026-11-07 16:00 UTC = 2026-11-08 01:00 JST.
    private let now = Date(timeIntervalSince1970: 1_794_067_200)
    private let me = FakeSupabase.me

    private func input(_ change: (inout ManualParcelInput) -> Void = { _ in }) -> ManualParcelInput {
        var value = ManualParcelInput.defaults(today: "2026-11-08")
        value.title = "本"
        value.shop = "店"
        change(&value)
        return value
    }

    private func check(_ change: (inout ManualParcelInput) -> Void = { _ in }) -> ManualParcel.Result {
        ManualParcel.check(input(change), userId: me, now: now)
    }

    private func row(_ change: (inout ManualParcelInput) -> Void = { _ in }) throws -> ManualParcelRow {
        guard case let .valid(row) = check(change) else {
            Issue.record("expected a valid form")
            throw CancellationError()
        }
        return row
    }

    // MARK: the checks at their edges

    @Test func titleAndShopNeedAtLeastOneCharacterAfterTrimming() {
        #expect(check { $0.title = "" } == .invalid(ManualParcelText.titleEmpty))
        #expect(check { $0.title = " \u{3000}\n" } == .invalid(ManualParcelText.titleEmpty))
        #expect(check { $0.shop = "" } == .invalid(ManualParcelText.shopEmpty))
        #expect(check { $0.shop = "   " } == .invalid(ManualParcelText.shopEmpty))
    }

    @Test func titleShopAndTrackingStopAtTheirLimits() {
        #expect(check { $0.title = String(repeating: "あ", count: 300) } != .invalid(ManualParcelText.titleTooLong))
        #expect(check { $0.title = String(repeating: "あ", count: 301) } == .invalid(ManualParcelText.titleTooLong))
        #expect(check { $0.shop = String(repeating: "a", count: 100) } != .invalid(ManualParcelText.shopTooLong))
        #expect(check { $0.shop = String(repeating: "a", count: 101) } == .invalid(ManualParcelText.shopTooLong))
        #expect(check { $0.trackingNumber = String(repeating: "1", count: 40) } != .invalid(ManualParcelText.trackingTooLong))
        #expect(check { $0.trackingNumber = String(repeating: "1", count: 41) } == .invalid(ManualParcelText.trackingTooLong))
        // Counted in UTF-16 code units, as the Web's length is: an emoji is two.
        #expect(check { $0.shop = String(repeating: "😀", count: 50) } != .invalid(ManualParcelText.shopTooLong))
        #expect(check { $0.shop = String(repeating: "😀", count: 51) } == .invalid(ManualParcelText.shopTooLong))
    }

    @Test func theAmountIsAWholeNumberOfYenUpToTenMillion() throws {
        #expect(try row { $0.totalAmount = "" }.totalAmount == nil)
        #expect(try row { $0.totalAmount = "0" }.totalAmount == 0)
        #expect(try row { $0.totalAmount = "10000000" }.totalAmount == 10_000_000)
        #expect(check { $0.totalAmount = "10000001" } == .invalid(ManualParcelText.amountInvalid))
        #expect(try row { $0.totalAmount = "1,980" }.totalAmount == 1980)
        #expect(try row { $0.totalAmount = "¥1,980" }.totalAmount == 1980)
        #expect(try row { $0.totalAmount = "￥ 1,980 円" }.totalAmount == 1980)
        #expect(try row { $0.totalAmount = "１９８０" }.totalAmount == 1980)
        for bad in ["480 480", "abc", ",", "-1", "1.5", "12345678901", "円", "¥"] {
            #expect(check { $0.totalAmount = bad } == .invalid(ManualParcelText.amountInvalid), "\(bad)")
        }
    }

    @Test func datesMustBeRealCalendarDays() throws {
        #expect(try row { $0.expectedDate = "2024-02-29" }.expectedDate == "2024-02-29")
        for bad in ["2025-02-29", "2026-02-30", "2026-13-01", "2026-00-10", "1899-12-31", "2101-01-01", "2026/11/08", "2026-1-8", "あ"] {
            #expect(check { $0.orderedAt = bad } == .invalid(ManualParcelText.orderedAtInvalid), "\(bad)")
            #expect(check { $0.expectedDate = bad } == .invalid(ManualParcelText.expectedDateInvalid), "\(bad)")
        }
    }

    @Test func theCategoryIsOneOfTheSevenOrEmpty() throws {
        for category in ParcelCategory.allCases {
            #expect(try row { $0.category = category.rawValue }.category == category.rawValue)
        }
        #expect(check { $0.category = "other2" } == .invalid(ManualParcelText.categoryInvalid))
        #expect(check { $0.category = "FOOD" } == .invalid(ManualParcelText.categoryInvalid))
    }

    @Test func theFirstErrorInTheSchemasOrderIsTheOneShown() {
        let result = ManualParcel.check(
            input { $0.title = ""; $0.shop = ""; $0.totalAmount = "x"; $0.category = "x" }, userId: me, now: now
        )
        #expect(result == .invalid(ManualParcelText.titleEmpty))
        #expect(check { $0.totalAmount = "x"; $0.category = "x" } == .invalid(ManualParcelText.amountInvalid))
    }

    // MARK: the columns

    @Test func anEmptyOrderDateBecomesTodayInJapan() throws {
        #expect(try row { $0.orderedAt = "" }.orderedAt == "2026-11-08")
        #expect(try row { $0.orderedAt = "2026-10-01" }.orderedAt == "2026-10-01")
    }

    @Test func theTrackingNumberIsNormalizedAndTheCarrierComesFromIt() throws {
        let post = try row { $0.trackingNumber = " 1234-5678-9012-3 " }
        #expect(post.trackingNumber == "1234567890123")
        #expect(post.carrier == "日本郵便")
        // 12 digits alone do not say which carrier.
        #expect(try row { $0.trackingNumber = "123456789012" }.carrier == nil)
        #expect(try row { $0.trackingNumber = "" }.trackingNumber == nil)
        #expect(try row { $0.trackingNumber = " - " }.trackingNumber == nil)
        // A chosen carrier wins over the number's shape.
        #expect(try row { $0.trackingNumber = "1234567890123"; $0.carrier = "sagawa" }.carrier == "佐川急便")
        #expect(try row { $0.carrier = "yamato" }.carrier == "ヤマト運輸")
        #expect(try row { $0.carrier = "auto" }.carrier == nil)
    }

    @Test func theRowCarriesTheFixedColumnsAndTheChoices() throws {
        let r = try row { $0.category = "food"; $0.presence = "face"; $0.status = "shipped"; $0.expectedDate = "2026-11-10"; $0.totalAmount = "2480" }
        #expect(r.userId == me)
        #expect(r.source == "manual")
        #expect(r.shopKey == "other")
        #expect(r.lastEmailAt == "2026-11-07T16:00:00.000Z")
        #expect(r.categorySource == "user")
        #expect(r.requiresPresence == true)
        #expect(r.status == "shipped")
        #expect(r.expectedDate == "2026-11-10")
        let none = try row()
        #expect(none.category == nil && none.categorySource == nil)
        #expect(none.requiresPresence == nil)
        #expect(try row { $0.presence = "drop" }.requiresPresence == false)
        #expect(none.status == "ordered")
    }

    @Test func everyColumnIsSentIncludingTheNulls() throws {
        let data = try JSONEncoder().encode(try row())
        let object = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        for key in ["user_id", "title", "shop", "shop_key", "ordered_at", "expected_date", "expected_date_end", "expected_window_start",
                    "expected_window_end", "expected_text", "total_amount", "category", "category_source", "tracking_number", "carrier",
                    "tracking_url", "requires_presence", "presence_evidence", "status", "source", "last_email_at"] {
            #expect(object[key] != nil, "\(key)")
        }
        #expect(object["tracking_url"] is NSNull)
        #expect(object.count == 21)
    }

    // MARK: the insert

    private func writer(_ fake: FakeSupabase) async throws -> (ParcelWriter, DataChanges) {
        let (provider, _) = try await TestSession.signedIn(fake)
        let changes = DataChanges()
        return (ParcelWriter(provider: provider, changes: changes), changes)
    }

    @Test func insertsOneRowAsTheSignedInUserEvenWhenTheRowNamesAnotherUser() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        var mine = try row { $0.title = "手入力の荷物"; $0.category = "daily" }
        mine.userId = FakeSupabase.other
        let outcome = await writer.createManual(mine)
        guard case let .success(id) = outcome else {
            Issue.record("expected a success, got \(outcome)")
            return
        }
        let stored = try #require(await fake.row("parcels", id: id))
        #expect(stored["user_id"]?.string == me)
        #expect(stored["title"]?.string == "手入力の荷物")
        #expect(stored["source"]?.string == "manual")
        #expect(stored["shop_key"]?.string == "other")
        #expect(stored["category"]?.string == "daily")
        #expect(stored["category_source"]?.string == "user")
        #expect(stored["tracking_url"] == .null)
        #expect(await fake.rows("parcels").count == 1)
        #expect(await fake.requests("POST", "parcels").count == 1)
        #expect(changes.version == 1)
    }

    @Test func aRefusedInsertWritesNothingAndTellsNobody() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        await fake.fail("POST", "parcels", with: .http(500))
        let outcome = await writer.createManual(try row())
        #expect(outcome == .notUpdated(.failed))
        #expect(await fake.rows("parcels").isEmpty)
        #expect(changes.version == 0)
    }

    @Test func aLostAnswerIsUnknownAndTheOthersAreToldToReadAgain() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        await fake.fail("POST", "parcels", with: .applyThenDrop(.networkConnectionLost))
        let outcome = await writer.createManual(try row())
        #expect(outcome == .unknown)
        #expect(await fake.requests("POST", "parcels").count == 1)
        #expect(changes.version == 1)
    }

    // MARK: the model

    private func model(
        save: @escaping ManualParcelModel.Save,
        reloads: Counter = Counter(),
        userID: String? = FakeSupabase.me
    ) -> ManualParcelModel {
        let value = ManualParcelModel(
            today: "2026-11-08",
            save: save,
            userID: { userID },
            reload: { reloads.bump() },
            now: { Date(timeIntervalSince1970: 1_794_067_200) }
        )
        value.input.title = "本"
        value.input.shop = "店"
        return value
    }

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        var value: Int { lock.withLock { n } }
        func bump() { lock.withLock { n += 1 } }
    }

    @Test func aWrongFormShowsTheWebsWordsAndSendsNothing() async {
        let sends = Counter()
        let m = model(save: { _ in sends.bump(); return .success("x") })
        m.input.title = ""
        await m.submit()
        #expect(m.error == ManualParcelText.titleEmpty)
        #expect(sends.value == 0)
        #expect(!m.isSending)
    }

    @Test func aSavedParcelClosesTheFormAndReadsTheListAgain() async {
        let reloads = Counter()
        let m = model(save: { _ in .success("id") }, reloads: reloads)
        await m.submit()
        #expect(m.isSaved)
        #expect(m.error == nil)
        #expect(reloads.value == 1)
    }

    @Test func aFailedSaveKeepsWhatWasTypedAndCanBePressedAgain() async {
        let sends = Counter()
        let m = model(save: { _ in sends.bump(); return .notUpdated(.failed) })
        await m.submit()
        #expect(m.error == ManualParcelText.failed)
        #expect(!m.isSaved)
        #expect(m.input.title == "本")
        await m.submit()
        #expect(sends.value == 2)
    }

    @Test func anUnknownResultIsNotSentAgainByTheModelAndReadsTheList() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        await fake.fail("POST", "parcels", with: .applyThenDrop(.networkConnectionLost))
        let reloads = Counter()
        let m = model(save: { await writer.createManual($0) }, reloads: reloads)
        await m.submit()
        #expect(m.error == ManualParcelText.unknown)
        #expect(!m.isSaved)
        #expect(reloads.value == 1)
        #expect(await fake.requests("POST", "parcels").count == 1)
    }

    @Test func aSecondPressWhileOneIsOnItsWayIsIgnored() async {
        let gate = Gate()
        let sends = Counter()
        let m = model(save: { _ in
            sends.bump()
            await gate.wait()
            return .success("id")
        })
        let first = Task { await m.submit() }
        try? await Task.sleep(for: .milliseconds(100))
        #expect(m.isSending)
        await m.submit()
        await m.submit()
        gate.open()
        await first.value
        #expect(sends.value == 1)
        #expect(m.sendCount == 1)
        #expect(m.isSaved)
    }

    @Test func signedOutSendsNothing() async {
        let sends = Counter()
        let m = model(save: { _ in sends.bump(); return .success("x") }, userID: nil)
        await m.submit()
        #expect(m.error == ManualParcelText.notSignedIn)
        #expect(sends.value == 0)
    }

    // MARK: pressing again after a lost answer (the same id)

    @Test func theFormSendsTheIdItMadeWhenItWasOpenedOnEverySend() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        await fake.fail("POST", "parcels", with: .applyThenDrop(.networkConnectionLost))
        let reloads = Counter()
        let m = model(save: { await writer.createManual($0) }, reloads: reloads)
        await m.submit()
        #expect(m.error == ManualParcelText.unknown && !m.isSaved)
        #expect(await fake.rows("parcels").count == 1)
        // Pressed again: the same id is sent, the server says it is there (23505), and that is a success.
        await m.submit()
        #expect(m.isSaved && m.error == nil)
        let posts = await fake.requests("POST", "parcels")
        #expect(posts.count == 2)
        let ids = try posts.map { try #require(try JSONSerialization.jsonObject(with: $0.body) as? [String: Any])["id"] as? String }
        #expect(ids[0] == m.newID && ids[1] == m.newID)
        #expect(await fake.rows("parcels").count == 1)
        #expect(await fake.row("parcels", id: m.newID) != nil)
    }

    @Test func aDifferentFormGetsADifferentId() {
        let a = model(save: { _ in .success("x") })
        let b = model(save: { _ in .success("x") })
        #expect(a.newID != b.newID)
        #expect(UUID(uuidString: a.newID) != nil)
    }

    @Test func aDuplicateIsASuccessOnlyForARowThatCarriesAnId() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        var mine = try row()
        mine.id = Rows.id(7)
        await fake.insert("parcels", [Rows.parcel(7)])
        // The id exists already (this fake cannot tell whose it is): 23505 on a row that carried an id counts as made.
        #expect(await writer.createManual(mine) == .success(Rows.id(7)))
        // A row with no id has no such reading.
        var anon = try row()
        anon.id = nil
        await fake.fail("POST", "parcels", nth: 2, with: .http(409))
        #expect(await writer.createManual(anon) == .notUpdated(.failed))
    }

    @Test func theIdIsPartOfTheRowOnlyWhenGiven() throws {
        var withID = try row()
        withID.id = Rows.id(3)
        let object = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(withID)) as? [String: Any])
        #expect(object["id"] as? String == Rows.id(3))
        #expect(object.count == 22)
    }
}
