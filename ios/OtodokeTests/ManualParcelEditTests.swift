import Foundation
import Testing
@testable import Otodoke

/// 「編集」 and 「この荷物を消す」 of a parcel typed in by hand: the checks made on what is stored, the
/// columns that are written (only the changed ones), the update and the delete against FakeSupabase
/// (the conditions, the other people's and the mails' parcels, the result kinds), the model, and that
/// pressing again after a lost answer is safe.
@Suite("Manual parcel (edit and delete)")
@MainActor
struct ManualParcelEditTests {
    private let me = FakeSupabase.me

    private func saved(_ change: (inout ManualParcel.Saved) -> Void = { _ in }) -> ManualParcel.Saved {
        var value = ManualParcel.Saved(
            status: "shipped", totalAmount: 2480, category: "food", orderedAt: "2026-11-01", expectedDate: "2026-11-10",
            trackingNumber: "1234567890123", carrier: "日本郵便", requiresPresence: true, updatedAt: "2026-11-01T09:30:15.123456+00:00"
        )
        change(&value)
        return value
    }

    /// The form as it starts for `saved` (what the screen shows before anything is typed).
    private func form(_ s: ManualParcel.Saved, _ change: (inout ManualParcelInput) -> Void = { _ in }) -> ManualParcelInput {
        var input = ManualParcelInput()
        input.title = "本"
        input.shop = "店"
        input.orderedAt = s.orderedAt ?? ""
        input.expectedDate = s.expectedDate ?? ""
        input.totalAmount = s.totalAmount.map(String.init) ?? ""
        input.category = s.category ?? ""
        input.trackingNumber = s.trackingNumber ?? ""
        input.carrier = ManualParcel.carrierChoice(s.carrier, tracking: s.trackingNumber)
        input.presence = s.requiresPresence == nil ? "" : (s.requiresPresence == true ? "face" : "drop")
        input.status = s.status
        change(&input)
        return input
    }

    private func columns(_ s: ManualParcel.Saved, _ change: (inout ManualParcelInput) -> Void = { _ in }) throws -> [String: ManualParcel.Column] {
        guard case let .valid(values) = ManualParcel.checkEdit(form(s, change), saved: s) else {
            Issue.record("expected a valid form")
            throw CancellationError()
        }
        return values
    }

    private func error(_ s: ManualParcel.Saved, _ change: (inout ManualParcelInput) -> Void) -> String? {
        if case let .invalid(message) = ManualParcel.checkEdit(form(s, change), saved: s) { return message }
        return nil
    }

    // MARK: only the changed columns are written

    @Test func savingWithoutChangesWritesNoneOfTheColumnsAMailAdded() throws {
        let values = try columns(saved())
        for key in ["category", "category_source", "expected_date", "expected_date_end", "expected_window_start", "expected_window_end", "expected_text",
                    "tracking_number", "carrier", "tracking_url", "presence_evidence", "ordered_at"] {
            #expect(values[key] == nil, "\(key)")
        }
        #expect(values["title"] == .text("本"))
        #expect(values["shop_key"] == .text("other"))
        #expect(values["status"] == .text("shipped"))
        #expect(values["total_amount"] == .number(2480))
        #expect(values["requires_presence"] == .flag(true))
    }

    @Test func aChangedCategoryIsTheUsersChoiceAndAClearedOneIsAutomaticAgain() throws {
        let changed = try columns(saved()) { $0.category = "daily" }
        #expect(changed["category"] == .text("daily"))
        #expect(changed["category_source"] == .text("user"))
        let cleared = try columns(saved()) { $0.category = "" }
        #expect(cleared["category"] == .null)
        #expect(cleared["category_source"] == .null)
    }

    @Test func aChangedDateDropsTheRangeTheTimeAndTheWording() throws {
        let values = try columns(saved()) { $0.expectedDate = "2026-11-12" }
        #expect(values["expected_date"] == .text("2026-11-12"))
        for key in ["expected_date_end", "expected_window_start", "expected_window_end", "expected_text"] { #expect(values[key] == .null, "\(key)") }
        #expect(try columns(saved()) { $0.expectedDate = "" }["expected_date"] == .null)
    }

    @Test func aChangedNumberOrCarrierDropsTheTrackingUrlAndAnUnchangedOneKeepsIt() throws {
        let number = try columns(saved()) { $0.trackingNumber = "9999-8888-7777" }
        #expect(number["tracking_number"] == .text("999988887777"))
        #expect(number["tracking_url"] == .null)
        let chosen = try columns(saved()) { $0.carrier = "sagawa" }
        #expect(chosen["carrier"] == .text("佐川急便"))
        #expect(chosen["tracking_number"] == .text("1234567890123"))
        #expect(chosen["tracking_url"] == .null)
        // The number written differently but the same after normalizing: unchanged.
        #expect(try columns(saved()) { $0.trackingNumber = " 1234-5678-9012-3 " }["tracking_url"] == nil)
    }

    @Test func aChangedWayOfReceivingDropsTheEvidence() throws {
        #expect(try columns(saved()) { $0.presence = "drop" }["presence_evidence"] == .null)
        #expect(try columns(saved()) { $0.presence = "drop" }["requires_presence"] == .flag(false))
        #expect(try columns(saved())["presence_evidence"] == nil)
    }

    @Test func anOrderDateLeftEmptyKeepsTheStoredOneAndNeverBecomesToday() throws {
        #expect(try columns(saved()) { $0.orderedAt = "" }["ordered_at"] == nil)
        #expect(try columns(saved()) { $0.orderedAt = "2026-10-01" }["ordered_at"] == .text("2026-10-01"))
        let none = saved { $0.orderedAt = nil }
        #expect(try columns(none) { $0.orderedAt = "" }["ordered_at"] == nil)
    }

    @Test func aCarrierNameTheFiveDoNotCoverIsKeptUnlessChosenOtherwise() throws {
        let other = saved { $0.carrier = "ゆうパック便"; $0.trackingNumber = nil }
        #expect(ManualParcel.carrierChoice(other.carrier, tracking: nil) == "keep")
        #expect(try columns(other)["carrier"] == nil)
        // Kept while the number changes: the stored name stays.
        #expect(try columns(other) { $0.trackingNumber = "1234567890123" }["carrier"] == .text("ゆうパック便"))
        #expect(try columns(other) { $0.carrier = "auto" }["carrier"] == .null)
    }

    // MARK: the checks made on what is stored

    @Test func aCancelledParcelMayStayCancelledAndOnlyThen() throws {
        let cancelled = saved { $0.status = "cancelled" }
        #expect(try columns(cancelled)["status"] == .text("cancelled"))
        #expect(error(saved()) { $0.status = "cancelled" } == ManualParcelText.checkInput)
        // A status a mail set is accepted for any parcel.
        #expect(try columns(saved()) { $0.status = "out_for_delivery" }["status"] == .text("out_for_delivery"))
        #expect(error(saved()) { $0.status = "unknown" } == ManualParcelText.checkInput)
    }

    @Test func theStoredAmountMayBeSavedBackEvenAboveTheLimitButNoOtherAmountAboveItMay() throws {
        let big = saved { $0.totalAmount = 20_000_000 }
        #expect(try columns(big)["total_amount"] == .number(20_000_000))
        #expect(error(big) { $0.totalAmount = "20000001" } == ManualParcelText.amountInvalid)
        #expect(error(saved()) { $0.totalAmount = "20000000" } == ManualParcelText.amountInvalid)
        #expect(error(saved()) { $0.totalAmount = "10000001" } == ManualParcelText.amountInvalid)
        #expect(try columns(saved()) { $0.totalAmount = "10000000" }["total_amount"] == .number(10_000_000))
        #expect(try columns(saved()) { $0.totalAmount = "" }["total_amount"] == .null)
    }

    @Test func theFormChecksAreTheNewParcelsChecks() {
        #expect(error(saved()) { $0.title = " " } == ManualParcelText.titleEmpty)
        #expect(error(saved()) { $0.shop = String(repeating: "a", count: 101) } == ManualParcelText.shopTooLong)
        #expect(error(saved()) { $0.expectedDate = "2026-02-30" } == ManualParcelText.expectedDateInvalid)
        #expect(error(saved()) { $0.category = "x" } == ManualParcelText.categoryInvalid)
        #expect(error(saved()) { $0.trackingNumber = String(repeating: "1", count: 41) } == ManualParcelText.trackingTooLong)
    }

    @Test func theFormStartsWithWhatIsStored() throws {
        let row = try Rows.parcelRow(Rows.parcel(1, [
            "source": "manual", "title": "本", "status": "attempted", "total_amount": 480, "category": "nope", "carrier": "ゆうパック便",
            "tracking_number": "ABC", "requires_presence": false, "ordered_at": "2026-11-01",
        ]))
        let input = ManualParcelInput(editing: row)
        #expect(input.title == "本" && input.shop == "テスト店")
        #expect(input.totalAmount == "480")
        #expect(input.category == "")
        #expect(input.carrier == "keep")
        #expect(input.presence == "drop")
        #expect(input.status == "attempted")
        #expect(input.expectedDate == "")
        // A status the form cannot show starts as 注文済み.
        let odd = try Rows.parcelRow(Rows.parcel(2, ["source": "manual", "status": "unknown"]))
        #expect(ManualParcelInput(editing: odd).status == "ordered")
    }

    @Test func theStatusChoicesAddOnlyTheOneTheParcelIsAt() {
        #expect(ManualParcelText.statusChoices(keeping: "shipped").map(\.value) == ["ordered", "shipped", "delivered"])
        #expect(ManualParcelText.statusChoices(keeping: "cancelled").map(\.value) == ["ordered", "shipped", "delivered", "cancelled"])
        #expect(ManualParcelText.statusChoices(keeping: "attempted").map(\.name).last == "不在・再配達")
        #expect(ManualParcelText.statusChoices(keeping: "cancelled").map(\.name).last == "キャンセル")
    }

    // MARK: the update

    private func writer(_ fake: FakeSupabase) async throws -> (ParcelWriter, DataChanges) {
        let (provider, _) = try await TestSession.signedIn(fake)
        let changes = DataChanges()
        return (ParcelWriter(provider: provider, changes: changes), changes)
    }

    private func manualRow(_ n: Int = 1, _ over: Row = [:]) -> Row {
        Rows.parcel(n, ["source": "manual", "title": "元", "shop": "元の店", "category": "food", "category_source": "mail", "expected_date": "2026-11-10",
                        "expected_text": "11/10 午前", "tracking_number": "1234567890123", "carrier": "日本郵便", "tracking_url": "https://example.com/t",
                        "requires_presence": true, "presence_evidence": "対面で", "ordered_at": "2026-11-01", "total_amount": 2480] as Row)
            .merging(over) { _, new in new }
    }

    private func opened(_ row: Row) -> String { row["updated_at"]?.string ?? "" }

    private func edited(_ rowValues: Row, _ change: (inout ManualParcelInput) -> Void = { _ in }) throws -> ManualParcelInput {
        var input = ManualParcelInput(editing: try Rows.parcelRow(rowValues))
        input.title = "新しい本"
        change(&input)
        return input
    }

    @Test func updatesOnlyTheChangedColumnsAndKeepsWhatAMailAdded() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        let outcome = await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: opened(original))
        #expect(outcome == .saved)
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(stored["title"]?.string == "新しい本")
        #expect(stored["category_source"]?.string == "mail")
        #expect(stored["expected_text"]?.string == "11/10 午前")
        #expect(stored["tracking_url"]?.string == "https://example.com/t")
        #expect(stored["presence_evidence"]?.string == "対面で")
        #expect(stored["source"]?.string == "manual")
        #expect(changes.version == 1)
        // The write is conditioned on the version it read and on being the signed-in user's typed-in parcel.
        let patch = try #require(await fake.requests("PATCH", "parcels").first)
        let query = patch.url.query ?? ""
        for part in ["id=eq.", "user_id=eq.", "source=eq.manual", "updated_at=eq."] { #expect(query.contains(part), "\(part)") }
    }

    @Test func aChangedCategoryIsWrittenAsTheUsers() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        #expect(await writer.updateManual(id: Rows.id(1), input: try edited(original) { $0.category = "daily" }, openedUpdatedAt: opened(original)) == .saved)
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(stored["category"]?.string == "daily" && stored["category_source"]?.string == "user")
    }

    @Test func aCancelledParcelIsSavedAsCancelledAndAHugeStoredAmountIsKept() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow(1, ["status": "cancelled", "total_amount": 99_000_000])
        await fake.insert("parcels", [original])
        #expect(await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: opened(original)) == .saved)
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(stored["status"]?.string == "cancelled")
        #expect(stored["total_amount"] == .int(99_000_000))
    }

    @Test func aWrongFormIsToldAfterTheReadAndWritesNothing() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        let outcome = await writer.updateManual(id: Rows.id(1), input: try edited(original) { $0.title = "" }, openedUpdatedAt: opened(original))
        #expect(outcome == .invalid(ManualParcelText.titleEmpty))
        #expect(await fake.requests("PATCH", "parcels").isEmpty)
        #expect(changes.version == 0)
    }

    @Test func aMailsParcelAnotherUsersParcelAndAMissingOneAreNotFoundAndNothingIsWritten() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let mail = Rows.parcel(1, ["source": "mail"])
        let others = manualRow(2, ["user_id": .string(FakeSupabase.other)])
        await fake.insert("parcels", [mail, others])
        let input = try edited(manualRow())
        for id in [Rows.id(1), Rows.id(2), Rows.id(3), "not-a-uuid"] {
            #expect(await writer.updateManual(id: id, input: input, openedUpdatedAt: opened(manualRow())) == .notFound, "\(id)")
        }
        #expect(await fake.requests("PATCH", "parcels").isEmpty)
        #expect(await fake.row("parcels", id: Rows.id(1))?["title"]?.string == "品名1")
    }

    @Test func aParcelChangedBetweenTheReadAndTheWriteIsNotOverwritten() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        await fake.before("PATCH", "parcels") { tables in
            if let i = tables["parcels"]?.firstIndex(where: { $0["id"]?.string == Rows.id(1) }) { tables["parcels"]?[i]["updated_at"] = .string("2026-11-02T00:00:00.000001+00:00") }
        }
        let outcome = await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: opened(original))
        #expect(outcome == .changed)
        #expect(await fake.row("parcels", id: Rows.id(1))?["title"]?.string == "元")
        #expect(changes.version == 0)
    }

    @Test func aParcelUpdatedAfterTheFormWasOpenedIsNotWrittenAndSaysChanged() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        let opened = opened(original)
        // A delivery mail updates the parcel after the form was opened and before 保存.
        await fake.touch("parcels", id: Rows.id(1), ["status": "shipped"])
        let outcome = await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: opened)
        #expect(outcome == .changed)
        #expect(await fake.requests("PATCH", "parcels").isEmpty)
        #expect(await fake.row("parcels", id: Rows.id(1))?["title"]?.string == "元")
        #expect(changes.version == 0)
    }

    @Test func negativeControlNobodyUpdatedTheParcelSoTheEditIsSavedOnTheOpenedVersion() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        #expect(await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: opened(original)) == .saved)
        let patch = try #require(await fake.requests("PATCH", "parcels").first)
        let query = patch.url.query ?? ""
        #expect(query.contains("updated_at=eq."))
        #expect(await fake.row("parcels", id: Rows.id(1))?["title"]?.string == "新しい本")
    }

    @Test func writingTheSameValuesAgainIsSavedOnceAndTheSameStaleFormAgainWritesNothingMore() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        // Nothing typed differs from what is stored: still a save, on the opened version.
        let same = try edited(original) { $0.title = "元" }
        #expect(await writer.updateManual(id: Rows.id(1), input: same, openedUpdatedAt: opened(original)) == .saved)
        // The first save moved updated_at on. The same form (opened before) says exactly what is stored now: saved, no second write.
        #expect(await writer.updateManual(id: Rows.id(1), input: same, openedUpdatedAt: opened(original)) == .saved)
        #expect(await fake.requests("PATCH", "parcels").count == 1)
        // A form that differs from what is stored is not written over (it is not the same form any more).
        let other = try edited(original) { $0.title = "別の品名" }
        #expect(await writer.updateManual(id: Rows.id(1), input: other, openedUpdatedAt: opened(original)) == .changed)
        #expect(await fake.requests("PATCH", "parcels").count == 1)
    }

    @Test func aFormWithoutAnOpenedVersionWritesNothing() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        #expect(await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: "") == .changed)
        #expect(await fake.requests("PATCH", "parcels").isEmpty)
    }

    @Test func theModelSendsTheVersionTheFormWasOpenedWithAndReadsAgainOnChanged() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        let reloads = Counter()
        let m = ManualParcelModel(
            editing: try Rows.parcelRow(original),
            update: { await writer.updateManual(id: $0, input: $1, openedUpdatedAt: $2) },
            delete: { await writer.deleteManual(id: $0) },
            stillThere: { true }, userID: { FakeSupabase.me }, reload: { reloads.bump() }
        )
        m.input.title = "新しい本"
        await fake.touch("parcels", id: Rows.id(1), ["status": "shipped"])
        await m.submit()
        #expect(m.error == ManualParcelText.changed && !m.isSaved)
        #expect(reloads.value == 1)
        #expect(await fake.row("parcels", id: Rows.id(1))?["title"]?.string == "元")
    }

    @Test func aParcelWithNoTitleCanStillBeEdited() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow(1, ["title": nil])
        await fake.insert("parcels", [original])
        #expect(await writer.updateManual(id: Rows.id(1), input: try edited(original) { $0.shop = "新しい店" }, openedUpdatedAt: opened(original)) == .saved)
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(stored["title"]?.string == "新しい本" && stored["shop"]?.string == "新しい店")
    }

    @Test func aStoredNullTitleIsADifferenceOnAnOldVersionAndNeverTheSame() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow(1, ["title": nil])
        await fake.insert("parcels", [original])
        await fake.touch("parcels", id: Rows.id(1), ["status": "shipped"])
        let outcome = await writer.updateManual(id: Rows.id(1), input: try edited(original) { $0.shop = "店" }, openedUpdatedAt: opened(original))
        #expect(outcome == .changed)
        #expect(await fake.requests("PATCH", "parcels").isEmpty)
        // The check itself: null is never equal to a typed text, text equal to text is.
        let s = saved()
        let columns = try self.columns(s)
        #expect(ManualParcel.writesNothing(columns, saved: s, title: nil, shop: "店") == false)
        #expect(ManualParcel.writesNothing(columns, saved: s, title: "本", shop: nil) == false)
        #expect(ManualParcel.writesNothing(columns, saved: s, title: "本", shop: "店") == true)
    }

    /// A tracking number the automatic choice names, and the name it gives.
    private func autoCarrier() throws -> (number: String, name: String) {
        for number in ["123456789012", "1234567890123", "123456789012345", "1234-5678-9012", "1Z999AA10123456784", "JP1234567890JP", "RR123456789JP"] {
            if let name = ManualParcel.carrierName(.auto, tracking: number) { return (number, name) }
        }
        throw Failure()
    }

    private struct Failure: Error {}

    @Test func aNamedCarrierChangedToAutomaticThatComesToTheSameCarrierKeepsTheTrackingUrl() async throws {
        let (number, name) = try autoCarrier()
        let s = saved { $0.trackingNumber = number; $0.carrier = name }
        let cols = try columns(s) { $0.carrier = "auto" }
        #expect(cols["tracking_number"] == nil && cols["carrier"] == nil && cols["tracking_url"] == nil)
        // A carrier that is really another one is still a difference.
        let other = try columns(s) { $0.carrier = ManualParcel.carrierChoice(name, tracking: number) == "yamato" ? "japanpost" : "yamato" }
        #expect(other["carrier"] != nil && other["tracking_url"] == .null)
    }

    @Test func aSaveWithTheCarrierSetToAutomaticWhoseAnswerIsLostIsSavedWhenPressedAgain() async throws {
        let (number, name) = try autoCarrier()
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow(1, ["tracking_number": .string(number), "carrier": .string(name)])
        await fake.insert("parcels", [original])
        let m = ManualParcelModel(
            editing: try Rows.parcelRow(original),
            update: { await writer.updateManual(id: $0, input: $1, openedUpdatedAt: $2) },
            delete: { await writer.deleteManual(id: $0) },
            stillThere: { true }, userID: { FakeSupabase.me }, reload: {}
        )
        m.input.title = "新しい本"
        m.input.carrier = "auto"
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await m.submit()
        #expect(m.error == ManualParcelText.unknown && !m.isSaved)
        await m.submit()
        #expect(m.isSaved && m.error == nil)
        #expect(await fake.requests("PATCH", "parcels").count == 1)
        // The tracking URL the mail had put there was never dropped.
        #expect(await fake.row("parcels", id: Rows.id(1))?["tracking_url"]?.string == "https://example.com/t")
    }

    @Test func aFailedUpdateIsFailedAndALostAnswerIsUnknown() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        await fake.fail("PATCH", "parcels", with: .http(500))
        #expect(await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: opened(original)) == .failed)
        #expect(changes.version == 0)
        await fake.fail("PATCH", "parcels", nth: 2, with: .applyThenDrop(.networkConnectionLost))
        #expect(await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: opened(original)) == .unknown)
        #expect(changes.version == 1)
        #expect(await fake.requests("PATCH", "parcels").count == 2)
    }

    @Test func aFailedReadIsFailed() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        await fake.fail("GET", "parcels", with: .http(500))
        #expect(await writer.updateManual(id: Rows.id(1), input: try edited(original), openedUpdatedAt: opened(original)) == .failed)
        #expect(await fake.requests("PATCH", "parcels").isEmpty)
    }

    // MARK: the delete

    @Test func deletesOnlyMyTypedInParcel() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        await fake.insert("parcels", [manualRow(1), Rows.parcel(2, ["source": "mail"]), manualRow(3, ["user_id": .string(FakeSupabase.other)])])
        #expect(await writer.deleteManual(id: Rows.id(2)) == .notUpdated(.conflict))
        #expect(await writer.deleteManual(id: Rows.id(3)) == .notUpdated(.conflict))
        #expect(await writer.deleteManual(id: "x") == .notUpdated(.invalidInput))
        #expect(await fake.rows("parcels").count == 3)
        #expect(changes.version == 0)
        #expect(await writer.deleteManual(id: Rows.id(1)) == .success(Rows.id(1)))
        #expect(await fake.rows("parcels").count == 2)
        #expect(changes.version == 1)
        let delete = try #require(await fake.requests("DELETE", "parcels").last)
        let query = delete.url.query ?? ""
        for part in ["id=eq.", "user_id=eq.", "source=eq.manual"] { #expect(query.contains(part), "\(part)") }
    }

    @Test func aLostDeleteAnswerIsUnknownAndTheSecondDeleteFindsNothing() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        await fake.insert("parcels", [manualRow(1)])
        await fake.fail("DELETE", "parcels", with: .applyThenDrop(.networkConnectionLost))
        #expect(await writer.deleteManual(id: Rows.id(1)) == .unknown)
        #expect(await fake.rows("parcels").isEmpty)
        #expect(await writer.deleteManual(id: Rows.id(1)) == .notUpdated(.conflict))
    }

    // MARK: the model

    final class Counter: @unchecked Sendable {
        private let lock = NSLock()
        private var n = 0
        var value: Int { lock.withLock { n } }
        func bump() { lock.withLock { n += 1 } }
    }

    private func model(
        update: @escaping ManualParcelModel.Update = { _, _, _ in .saved },
        delete: @escaping ManualParcelModel.Delete = { .success($0) },
        stillThere: @escaping ManualParcelModel.StillThere = { true },
        reloads: Counter = Counter(),
        userID: String? = FakeSupabase.me
    ) throws -> ManualParcelModel {
        ManualParcelModel(
            editing: try Rows.parcelRow(manualRow()),
            update: update, delete: delete, stillThere: stillThere, userID: { userID }, reload: { reloads.bump() }
        )
    }

    @Test func aSavedEditClosesTheFormAndReadsTheParcelAgain() async throws {
        let reloads = Counter()
        let m = try model(reloads: reloads)
        await m.submit()
        #expect(m.isSaved && m.error == nil)
        #expect(reloads.value == 1)
    }

    @Test func eachResultOfAnEditSaysTheWebsWords() async throws {
        let cases: [(ParcelWriter.ManualEditOutcome, String)] = [
            (.invalid(ManualParcelText.titleEmpty), ManualParcelText.titleEmpty),
            (.notFound, ManualParcelText.notFound),
            (.failed, ManualParcelText.failed),
            (.changed, ManualParcelText.changed),
            (.unknown, ManualParcelText.unknown),
        ]
        for (outcome, words) in cases {
            let m = try model(update: { _, _, _ in outcome })
            await m.submit()
            #expect(m.error == words)
            #expect(!m.isSaved && !m.isSending)
        }
        #expect(ManualParcelText.notFound == "見つかりません")
    }

    @Test func aSecondPressWhileOneIsOnItsWayIsIgnoredAndCloseIsHeldBack() async throws {
        let gate = Gate()
        let sends = Counter()
        let m = try model(update: { _, _, _ in
            sends.bump()
            await gate.wait()
            return .saved
        })
        let first = Task { await m.submit() }
        try? await Task.sleep(for: .milliseconds(100))
        #expect(m.isSending && m.isBusy)
        await m.submit()
        await m.deleteParcel()
        gate.open()
        await first.value
        #expect(sends.value == 1)
        #expect(m.deleteCount == 0)
    }

    @Test func pressingSaveAgainAfterALostAnswerThatWentThroughIsSavedAndWritesOnce() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow()
        await fake.insert("parcels", [original])
        let reloads = Counter()
        let m = ManualParcelModel(
            editing: try Rows.parcelRow(original),
            update: { await writer.updateManual(id: $0, input: $1, openedUpdatedAt: $2) },
            delete: { await writer.deleteManual(id: $0) },
            stillThere: { true }, userID: { FakeSupabase.me }, reload: { reloads.bump() }
        )
        m.input.title = "新しい本"
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await m.submit()
        #expect(m.error == ManualParcelText.unknown && !m.isSaved)
        // The first send went through and moved updated_at on; the form was opened before that, but it says exactly what
        // is stored now: saved (the sheet closes), and nothing is written a second time.
        await m.submit()
        #expect(m.isSaved && m.error == nil)
        #expect(await fake.requests("PATCH", "parcels").count == 1)
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(stored["title"]?.string == "新しい本")
        #expect(stored["tracking_url"]?.string == "https://example.com/t")
    }

    @Test func negativeControlAMailAddedATrackingNumberAfterTheLostAnswerSoPressingAgainWritesNothingAndSaysChanged() async throws {
        let fake = FakeSupabase.make()
        let (writer, _) = try await writer(fake)
        let original = manualRow(1, ["tracking_number": .null, "carrier": .null, "tracking_url": .null])
        await fake.insert("parcels", [original])
        let m = ManualParcelModel(
            editing: try Rows.parcelRow(original),
            update: { await writer.updateManual(id: $0, input: $1, openedUpdatedAt: $2) },
            delete: { await writer.deleteManual(id: $0) },
            stillThere: { true }, userID: { FakeSupabase.me }, reload: {}
        )
        m.input.title = "新しい本"
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await m.submit()
        #expect(m.error == ManualParcelText.unknown && !m.isSaved)
        // The first send went through; then a shipping mail added the tracking number the form does not have.
        await fake.touch("parcels", id: Rows.id(1), ["tracking_number": "9876543210987", "carrier": "ヤマト運輸", "status": "shipped"])
        await m.submit()
        #expect(m.error == ManualParcelText.changed && !m.isSaved)
        #expect(await fake.requests("PATCH", "parcels").count == 1)
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(stored["tracking_number"]?.string == "9876543210987")
        #expect(stored["title"]?.string == "新しい本")
    }

    @Test func deleteNeedsTheCheck() async throws {
        let sends = Counter()
        let m = try model(delete: { sends.bump(); return .success($0) })
        await m.deleteParcel()
        #expect(m.deleteError == ManualParcelText.deleteUnchecked)
        #expect(ManualParcelText.deleteUnchecked == "「本当に消す」にチェックを入れてください")
        #expect(sends.value == 0 && !m.isDeleted)
        m.deleteConfirmed = true
        await m.deleteParcel()
        #expect(m.isDeleted && m.deleteError == nil)
        #expect(sends.value == 1)
    }

    @Test func eachResultOfADeleteSaysTheWebsWords() async throws {
        let failed = try model(delete: { _ in .notUpdated(.failed) })
        failed.deleteConfirmed = true
        await failed.deleteParcel()
        #expect(failed.deleteError == ManualParcelText.deleteFailed && !failed.isDeleted)
        let missing = try model(delete: { _ in .notUpdated(.conflict) })
        missing.deleteConfirmed = true
        await missing.deleteParcel()
        #expect(missing.deleteError == ManualParcelText.notFound && !missing.isDeleted)
        let signedOut = try model(userID: nil)
        signedOut.deleteConfirmed = true
        await signedOut.deleteParcel()
        #expect(signedOut.deleteError == ManualParcelText.notSignedIn)
    }

    @Test func aLostDeleteAnswerReadsTheParcelAndNeverSendsAgain() async throws {
        let sends = Counter()
        // Gone: the delete went through.
        let gone = try model(delete: { _ in sends.bump(); return .unknown }, stillThere: { false })
        gone.deleteConfirmed = true
        await gone.deleteParcel()
        #expect(gone.isDeleted)
        // Still there: it did not.
        let there = try model(delete: { _ in .unknown }, stillThere: { true })
        there.deleteConfirmed = true
        await there.deleteParcel()
        #expect(!there.isDeleted && there.deleteError == ManualParcelText.deleteFailed)
        // Could not be read: it says so, and a second press that finds nothing reads again and closes.
        let calls = Counter()
        let unread = try model(
            delete: { _ in calls.bump(); return calls.value == 1 ? .unknown : .notUpdated(.conflict) },
            stillThere: { calls.value == 1 ? nil : false }
        )
        unread.deleteConfirmed = true
        await unread.deleteParcel()
        #expect(!unread.isDeleted && unread.deleteError == ManualParcelText.deleteUnknown)
        // The check is let go after a result that is not a delete, so it is checked again for the second press.
        #expect(!unread.deleteConfirmed)
        unread.deleteConfirmed = true
        await unread.deleteParcel()
        #expect(unread.isDeleted)
        #expect(sends.value == 1)
    }

    @Test func theCheckIsLetGoAfterAFailedUnknownOrConflictingDelete() async throws {
        let results: [WriteOutcome<String>] = [.notUpdated(.failed), .unknown, .notUpdated(.conflict)]
        for result in results {
            let m = try model(delete: { _ in result }, stillThere: { true })
            m.deleteConfirmed = true
            await m.deleteParcel()
            #expect(!m.isDeleted && !m.deleteConfirmed, "\(result)")
            // Pressed again without the check: refused before anything is sent.
            await m.deleteParcel()
            #expect(m.deleteError == ManualParcelText.deleteUnchecked, "\(result)")
        }
    }

    @Test func aDeleteThatFindsNoRowChecksTheParcelAndReadsAgainWhenItIsThere() async throws {
        // Gone: counts as deleted.
        let gone = try model(delete: { _ in .notUpdated(.conflict) }, stillThere: { false })
        gone.deleteConfirmed = true
        await gone.deleteParcel()
        #expect(gone.isDeleted)
        // Still there (the row changed under us): the detail and the list are read again.
        let reloads = Counter()
        let there = try model(delete: { _ in .notUpdated(.conflict) }, stillThere: { true }, reloads: reloads)
        there.deleteConfirmed = true
        await there.deleteParcel()
        #expect(!there.isDeleted && there.deleteError == ManualParcelText.notFound && reloads.value == 1)
        // Not readable: it says it could not be confirmed.
        let unread = try model(delete: { _ in .notUpdated(.conflict) }, stillThere: { nil })
        unread.deleteConfirmed = true
        await unread.deleteParcel()
        #expect(!unread.isDeleted && unread.deleteError == ManualParcelText.deleteUnknown)
    }

    @Test func aSecondPressOfDeleteWhileOneIsOnItsWayIsIgnored() async throws {
        let gate = Gate()
        let sends = Counter()
        let m = try model(delete: { id in
            sends.bump()
            await gate.wait()
            return .success(id)
        })
        m.deleteConfirmed = true
        let first = Task { await m.deleteParcel() }
        try? await Task.sleep(for: .milliseconds(100))
        #expect(m.isDeleting && m.isBusy)
        await m.deleteParcel()
        await m.submit()
        gate.open()
        await first.value
        #expect(sends.value == 1 && m.sendCount == 0)
    }

    @Test func deleteAgainstTheFakeRemovesTheRowAndDoesNotTouchAMailsParcel() async throws {
        let fake = FakeSupabase.make()
        let (writer, changes) = try await writer(fake)
        await fake.insert("parcels", [manualRow(1), Rows.parcel(2, ["source": "mail"])])
        let m = ManualParcelModel(
            editing: try Rows.parcelRow(manualRow(1)),
            update: { await writer.updateManual(id: $0, input: $1, openedUpdatedAt: $2) },
            delete: { await writer.deleteManual(id: $0) },
            stillThere: { nil }, userID: { FakeSupabase.me }, reload: {}
        )
        m.deleteConfirmed = true
        await m.deleteParcel()
        #expect(m.isDeleted)
        #expect(await fake.rows("parcels").map { $0["id"]?.string } == [Rows.id(2)])
        #expect(changes.version == 1)
    }
}
