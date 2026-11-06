import Foundation
import Testing
@testable import Otodoke

/// [Task 7] ParcelWriter against FakeSupabase, which keeps the rows and moves updated_at on every write.
/// The four conditions (user_id, not cancelled, back only to RESTORABLE from delivered, the seven
/// categories as the user's), the version check on what the screen showed (Codex-P2), the three
/// kinds of result (Codex-P3), and the bulk contract (Codex-P1).
/// Negative controls: FakeSupabaseTests shows the fake changes a row when a condition is left out;
/// here the same situations must leave the row alone.
@Suite("ParcelWriter (task 7)")
@MainActor
struct ParcelWriterTests {
    nonisolated private static let shownStamp = "2026-11-01T09:30:15.123456+00:00"

    private func writer(_ fake: FakeSupabase) async throws -> ParcelWriter {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelWriter(provider: provider)
    }

    private func shown(_ n: Int, status: String = "shipped", updatedAt: String = shownStamp) -> ParcelVersion {
        ParcelVersion(id: Rows.id(n), status: status, updatedAt: updatedAt)
    }

    private func status(_ fake: FakeSupabase, _ n: Int) async -> String? {
        await fake.row("parcels", id: Rows.id(n))?["status"]?.string
    }

    private func stamp(_ fake: FakeSupabase, _ n: Int) async -> String? {
        await fake.row("parcels", id: Rows.id(n))?["updated_at"]?.string
    }

    private func patches(_ fake: FakeSupabase) async -> [StubRequest] {
        await fake.requests("PATCH", "parcels")
    }

    private func selectColumns(_ r: StubRequest) -> Set<String> {
        Set((r.query("select").first ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    }

    // MARK: 届いた

    @Test func marksDeliveredOnTheShownVersionWithEveryCondition() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        let next = await fake.peekNextTimestamp()
        let result = await writer.markDelivered(shown(1))
        #expect(result == .success(UndoToken(id: Rows.id(1), restoreTo: "shipped", deliveredUpdatedAt: next)))
        #expect(await status(fake, 1) == "delivered")
        let sent = await patches(fake)
        #expect(sent.count == 1)
        let patch = try #require(sent.first)
        #expect(patch.query("id") == ["eq.\(Rows.id(1))"])
        #expect(patch.query("user_id") == ["eq.\(FakeSupabase.me)"])
        #expect(Set(patch.query("status")) == ["neq.cancelled", "eq.shipped"])
        #expect(patch.query("updated_at") == ["eq.\(Self.shownStamp)"])
        #expect(selectColumns(patch).isSuperset(of: ["id", "status", "updated_at"]))
        #expect((patch.header("prefer") ?? "").contains("return=representation"))
        #expect(NSDictionary(dictionary: patch.jsonDictionary ?? [:]) == NSDictionary(dictionary: ["status": "delivered"]))
    }

    @Test func updatedAtIsSentExactlyAsRead() async throws {
        // "+00:00" and six fractional digits survive: a Date, a lost "+" or a cut would match no row.
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["updated_at": "2026-11-03T23:59:59.999999+00:00"])])
        let writer = try await writer(fake)
        let result = await writer.markDelivered(shown(1, updatedAt: "2026-11-03T23:59:59.999999+00:00"))
        guard case .success = result else {
            Issue.record("expected success, got \(result)")
            return
        }
        #expect(await patches(fake).first?.query("updated_at") == ["eq.2026-11-03T23:59:59.999999+00:00"])
    }

    @Test func aRowChangedSinceItWasShownIsNotOverwritten() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        let mail = await fake.touch("parcels", id: Rows.id(1), ["status": "out_for_delivery"])
        #expect(await writer.markDelivered(shown(1)) == .notUpdated(.conflict))
        #expect(await status(fake, 1) == "out_for_delivery")
        #expect(await stamp(fake, 1) == mail)
    }

    @Test func aStatusOtherThanTheShownOneIsNotOverwritten() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "attempted"])])
        let writer = try await writer(fake)
        #expect(await writer.markDelivered(shown(1, status: "shipped")) == .notUpdated(.conflict))
        #expect(await status(fake, 1) == "attempted")
    }

    @Test func aCancelledParcelIsNeverMarkedDelivered() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "cancelled"])])
        let writer = try await writer(fake)
        #expect(await writer.markDelivered(shown(1, status: "shipped")) == .notUpdated(.conflict))
        #expect(await writer.markDelivered(shown(1, status: "cancelled")) == .notUpdated(.invalidInput))
        #expect(await status(fake, 1) == "cancelled")
        for patch in await patches(fake) { #expect(patch.query("status").contains("neq.cancelled")) }
    }

    @Test func anotherUsersParcelIsNotTouched() async throws {
        // Negative control of condition 1: the same PATCH without user_id changes this row (FakeSupabaseTests).
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(9, ["user_id": .string(FakeSupabase.other)])])
        let writer = try await writer(fake)
        #expect(await writer.markDelivered(shown(9)) == .notUpdated(.conflict))
        #expect(await status(fake, 9) == "shipped")
    }

    @Test(arguments: ["not-a-uuid", "", "00000000-0000-4000-8000-00000000000Z", "1; drop table parcels"])
    func refusesAnIdThatIsNotAUUIDWithoutSending(id: String) async throws {
        let fake = FakeSupabase.make()
        let writer = try await writer(fake)
        #expect(await writer.markDelivered(ParcelVersion(id: id, status: "shipped", updatedAt: Self.shownStamp)) == .notUpdated(.invalidInput))
        #expect(await writer.undoDelivered(UndoToken(id: id, restoreTo: "shipped", deliveredUpdatedAt: Self.shownStamp)) == .notUpdated(.invalidInput))
        #expect(await writer.markNotDelivered(id: id) == .notUpdated(.invalidInput))
        #expect(await writer.setCategory(id: id, category: .food) == .notUpdated(.invalidInput))
        #expect(await fake.restRequests().isEmpty)
    }

    @Test(arguments: ["delivered", "cancelled", "bogus"])
    func marksOnlyFromAStatusItCanGoBackTo(from: String) async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": .string(from)])])
        let writer = try await writer(fake)
        #expect(await writer.markDelivered(shown(1, status: from)) == .notUpdated(.invalidInput))
        #expect(await patches(fake).isEmpty)
    }

    @Test func twoRowsBackIsNotASuccess() async throws {
        let fake = FakeSupabase.make()
        // Two rows answering to one id: never in the real table, but "exactly one row" must be checked.
        await fake.insert("parcels", [Rows.parcel(1), Rows.parcel(1)])
        let writer = try await writer(fake)
        #expect(await writer.markDelivered(shown(1)) == .notUpdated(.failed))
    }

    @Test func aServerErrorIsNotUpdated() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", with: .http(500))
        #expect(await writer.markDelivered(shown(1)) == .notUpdated(.failed))
        #expect(await status(fake, 1) == "shipped")
    }

    @Test func offlineIsNotUpdated() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", with: .transport(.notConnectedToInternet))
        #expect(await writer.markDelivered(shown(1)) == .notUpdated(.failed))
        #expect(await status(fake, 1) == "shipped")
    }

    @Test func aLostAnswerIsUnknownAndIsNotSentAgain() async throws {
        // Codex-P3: the update happened, the answer did not arrive.
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        #expect(await writer.markDelivered(shown(1)) == .unknown)
        #expect(await status(fake, 1) == "delivered")
        #expect(await patches(fake).count == 1)
    }

    @Test func aTimeoutIsUnknown() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", with: .transport(.timedOut))
        #expect(await writer.markDelivered(shown(1)) == .unknown)
        #expect(await patches(fake).count == 1)
    }

    // MARK: 元に戻す

    @Test func undoRestoresOnTheDeliveredVersion() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "attempted"])])
        let writer = try await writer(fake)
        guard case let .success(token) = await writer.markDelivered(shown(1, status: "attempted")) else {
            Issue.record("markDelivered failed")
            return
        }
        let result = await writer.undoDelivered(token)
        guard case let .success(after) = result else {
            Issue.record("undo: \(result)")
            return
        }
        #expect(after.id == Rows.id(1))
        #expect(after.status == "attempted")
        #expect(after.updatedAt == (await stamp(fake, 1)))
        #expect(await status(fake, 1) == "attempted")
        let undo = try #require(await patches(fake).last)
        #expect(undo.query("user_id") == ["eq.\(FakeSupabase.me)"])
        #expect(undo.query("status") == ["eq.delivered"])
        #expect(undo.query("updated_at") == ["eq.\(token.deliveredUpdatedAt)"])
        #expect(NSDictionary(dictionary: undo.jsonDictionary ?? [:]) == NSDictionary(dictionary: ["status": "attempted"]))
    }

    @Test func undoDoesNotOverwriteADeliveryMailThatCameInBetween() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        guard case let .success(token) = await writer.markDelivered(shown(1)) else {
            Issue.record("markDelivered failed")
            return
        }
        let mail = await fake.touch("parcels", id: Rows.id(1), ["status": "delivered"])
        #expect(await writer.undoDelivered(token) == .notUpdated(.conflict))
        #expect(await status(fake, 1) == "delivered")
        #expect(await stamp(fake, 1) == mail)
    }

    @Test(arguments: ["delivered", "cancelled", "bogus", ""])
    func undoGoesBackOnlyToARestorableStatus(to: String) async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered"])])
        let writer = try await writer(fake)
        #expect(await writer.undoDelivered(UndoToken(id: Rows.id(1), restoreTo: to, deliveredUpdatedAt: Self.shownStamp)) == .notUpdated(.invalidInput))
        #expect(await patches(fake).isEmpty)
    }

    @Test func aDeliveryMailBeforeTheSwipeLeavesNothingToUndo() async throws {
        // Codex-P2: list read → a delivery mail updates the row → swipe → nothing written, no undo.
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        let mail = await fake.touch("parcels", id: Rows.id(1), ["status": "delivered"])
        #expect(await writer.markDelivered(shown(1)) == .notUpdated(.conflict))
        #expect(await status(fake, 1) == "delivered")
        #expect(await stamp(fake, 1) == mail)
    }

    // MARK: すべて受取済にする (Codex-P1)

    @Test func bulkWritesEachRowOnItsOwn() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1), Rows.parcel(2, ["status": "ordered"]), Rows.parcel(3)])
        let writer = try await writer(fake)
        let results = await writer.markDelivered(all: [shown(3), shown(1), shown(2, status: "ordered")])
        #expect(results.map(\.id) == [Rows.id(3), Rows.id(1), Rows.id(2)])
        for r in results {
            guard case let .success(token) = r.outcome else {
                Issue.record("\(r.id): \(r.outcome)")
                continue
            }
            #expect(token.id == r.id)
            #expect(token.deliveredUpdatedAt == (await stamp(fake, Int(r.id.suffix(12))!)))
        }
        #expect(results.compactMap { if case let .success(t) = $0.outcome { t.restoreTo } else { nil } } == ["shipped", "shipped", "ordered"])
        #expect(await patches(fake).count == 3)
        for n in 1...3 { #expect(await status(fake, n) == "delivered") }
    }

    @Test func bulkReportsARowCancelledMeanwhileAsAConflict() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1), Rows.parcel(2), Rows.parcel(3)])
        let writer = try await writer(fake)
        await fake.touch("parcels", id: Rows.id(2), ["status": "cancelled"])
        let results = await writer.markDelivered(all: [shown(1), shown(2), shown(3)])
        try #require(results.count == 3)
        #expect(results.map(\.outcome).filter { if case .success = $0 { true } else { false } }.count == 2)
        #expect(results[1].outcome == .notUpdated(.conflict))
        #expect(await status(fake, 2) == "cancelled")
    }

    @Test func bulkGoesOnAfterOneFailure() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1), Rows.parcel(2), Rows.parcel(3)])
        let writer = try await writer(fake)
        await fake.fail("PATCH", "parcels", nth: 2, with: .http(500))
        let results = await writer.markDelivered(all: [shown(1), shown(2), shown(3)])
        try #require(results.count == 3)
        #expect(results[1].outcome == .notUpdated(.failed))
        #expect(await status(fake, 1) == "delivered")
        #expect(await status(fake, 2) == "shipped")
        #expect(await status(fake, 3) == "delivered")
    }

    @Test func bulkOfMoreThanFiveHundredIsRefusedWhole() async throws {
        let fake = FakeSupabase.make()
        let writer = try await writer(fake)
        let many = (1...501).map { shown($0) }
        let results = await writer.markDelivered(all: many)
        #expect(results.count == 501)
        #expect(results.allSatisfy { $0.outcome == .notUpdated(.invalidInput) })
        #expect(await patches(fake).isEmpty)
        #expect(ParcelWriter.maxAtOnce == 500)
    }

    @Test func bulkUndoRestoresTheRestWhenOneWasChangedInBetween() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1), Rows.parcel(2, ["status": "ordered"]), Rows.parcel(3)])
        let writer = try await writer(fake)
        let marked = await writer.markDelivered(all: [shown(1), shown(2, status: "ordered"), shown(3)])
        let tokens = marked.compactMap { if case let .success(t) = $0.outcome { t } else { nil } }
        #expect(tokens.count == 3)
        await fake.touch("parcels", id: Rows.id(3), ["status": "delivered"])
        let undone = await writer.undoDelivered(all: tokens)
        #expect(undone.map(\.id) == [Rows.id(1), Rows.id(2), Rows.id(3)])
        try #require(undone.count == 3)
        #expect(undone[2].outcome == .notUpdated(.conflict))
        #expect(await status(fake, 1) == "shipped")
        #expect(await status(fake, 2) == "ordered")
        #expect(await status(fake, 3) == "delivered")
    }

    // MARK: 届いていない

    @Test func notDeliveredGoesBackToShippedWithATrackingNumber() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "tracking_number": "1234-5678-9012"])])
        let writer = try await writer(fake)
        let read = await stamp(fake, 1)
        let result = await writer.markNotDelivered(id: Rows.id(1))
        guard case let .success(after) = result else {
            Issue.record("\(result)")
            return
        }
        #expect(after.status == "shipped")
        #expect(await status(fake, 1) == "shipped")
        let get = try #require(await fake.requests("GET", "parcels").last)
        #expect(get.query("id") == ["eq.\(Rows.id(1))"])
        #expect(get.query("user_id") == ["eq.\(FakeSupabase.me)"])
        #expect(selectColumns(get).isSuperset(of: ["tracking_number", "carrier", "status", "updated_at"]))
        let patch = try #require(await patches(fake).first)
        #expect(patch.query("user_id") == ["eq.\(FakeSupabase.me)"])
        #expect(patch.query("status") == ["eq.delivered"])
        #expect(patch.query("updated_at") == ["eq.\(read ?? "")"])
        #expect(NSDictionary(dictionary: patch.jsonDictionary ?? [:]) == NSDictionary(dictionary: ["status": "shipped"]))
    }

    @Test func notDeliveredGoesBackToOrderedWithoutNumberOrCarrier() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "tracking_number": "   ", "carrier": nil])])
        let writer = try await writer(fake)
        guard case let .success(after) = await writer.markNotDelivered(id: Rows.id(1)) else {
            Issue.record("markNotDelivered failed")
            return
        }
        #expect(after.status == "ordered")
        #expect(await status(fake, 1) == "ordered")
    }

    @Test func notDeliveredRefusesAParcelThatIsNotDelivered() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped"])])
        let writer = try await writer(fake)
        #expect(await writer.markNotDelivered(id: Rows.id(1)) == .notUpdated(.conflict))
        #expect(await writer.markNotDelivered(id: Rows.id(2)) == .notUpdated(.conflict))
        #expect(await patches(fake).isEmpty)
    }

    @Test func notDeliveredFailsWhenTheReadFails() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered"])])
        let writer = try await writer(fake)
        await fake.fail("GET", "parcels", with: .http(500))
        #expect(await writer.markNotDelivered(id: Rows.id(1)) == .notUpdated(.failed))
        #expect(await patches(fake).isEmpty)
    }

    @Test func notDeliveredDoesNotOverwriteAWriteBetweenItsReadAndItsUpdate() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered"])])
        let writer = try await writer(fake)
        await fake.before("PATCH", "parcels") { tables in
            guard let i = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(1)) }) else { return }
            tables["parcels"]![i]["updated_at"] = "2026-11-04T06:00:00.000001+00:00"
        }
        #expect(await writer.markNotDelivered(id: Rows.id(1)) == .notUpdated(.conflict))
        #expect(await status(fake, 1) == "delivered")
    }

    // MARK: 分類

    @Test func setsACategoryAsTheUsersChoice() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["category": "other", "category_source": "auto"])])
        let writer = try await writer(fake)
        let result = await writer.setCategory(id: Rows.id(1), category: .electronics)
        guard case .success = result else {
            Issue.record("\(result)")
            return
        }
        let row = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(row["category"] == "electronics")
        #expect(row["category_source"] == "user")
        let patch = try #require(await patches(fake).first)
        #expect(patch.query("id") == ["eq.\(Rows.id(1))"])
        #expect(patch.query("user_id") == ["eq.\(FakeSupabase.me)"])
        #expect(NSDictionary(dictionary: patch.jsonDictionary ?? [:]) == NSDictionary(dictionary: ["category": "electronics", "category_source": "user"]))
    }

    @Test func doesNotSetAnotherUsersCategory() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(9, ["user_id": .string(FakeSupabase.other), "category": nil])])
        let writer = try await writer(fake)
        #expect(await writer.setCategory(id: Rows.id(9), category: .food) == .notUpdated(.conflict))
        #expect(await fake.row("parcels", id: Rows.id(9))?["category"] == .null)
    }

    @Test func everyCategoryWrittenIsOneOfTheSeven() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let writer = try await writer(fake)
        for category in ParcelCategory.allCases { _ = await writer.setCategory(id: Rows.id(1), category: category) }
        let written = await patches(fake).compactMap { $0.jsonDictionary?["category"] as? String }
        #expect(written == ["food", "daily", "hobby", "fashion", "electronics", "beauty", "other"])
    }
}
