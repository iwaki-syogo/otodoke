import Foundation
import Testing
@testable import Otodoke

@Suite("Received parcel writes")
@MainActor
struct ReceivedWriterTests {
    private let now = Date(timeIntervalSince1970: 1_793_761_200) // 2026-11-04T03:00:00Z

    private func world(_ row: Row) async throws -> (FakeSupabase, ParcelWriter) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [row])
        let (provider, _) = try await TestSession.signedIn(fake)
        return (fake, ParcelWriter(provider: provider))
    }

    @Test func receivedFromDeliveredCanBeUndoneToTheExactPreviousReceiptAndAnswer() async throws {
        let row = Rows.parcel(1, ["status": "delivered", "received_at": nil, "check_dismissed_at": "2026-10-20T00:00:00Z"])
        let (fake, writer) = try await world(row)
        let shown = ParcelVersion(try Rows.parcelRow(row))
        guard case let .success(token) = await writer.markDelivered(shown, now: now) else {
            Issue.record("mark received failed")
            return
        }
        #expect(token.restoreTo == "delivered")
        #expect(token.previousReceivedAt == nil)
        #expect(token.previousCheckDismissedAt == "2026-10-20T00:00:00Z")
        #expect(await fake.requests("PATCH", "parcels").count == 1)
        let marked = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(marked["status"] == "delivered")
        #expect(marked["received_at"]?.string == ManualParcel.isoString(now))
        guard case .success = await writer.undoDelivered(token) else {
            Issue.record("undo received failed")
            return
        }
        let restored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(restored["status"] == "delivered")
        #expect(restored["received_at"] == .null)
        #expect(restored["check_dismissed_at"] == "2026-10-20T00:00:00Z")
    }

    @Test(arguments: ["2026-10-20", "2026-10-21", "2026-10-22"])
    func notReceivedRecordsStillOnlyAtFourteenDays(date: String) async throws {
        let now = try #require(ISO.date("2026-11-04T03:00:00Z"))
        let row = Rows.parcel(1, ["status": "delivered", "received_at": "2026-10-22T00:00:00Z", "expected_date": .string(date)])
        let (fake, writer) = try await world(row)
        guard case .success = await writer.markNotReceived(id: Rows.id(1), now: now) else {
            Issue.record("not received failed")
            return
        }
        let patch = try #require(await fake.requests("PATCH", "parcels").first)
        #expect(patch.jsonDictionary?["received_at"] is NSNull)
        #expect((patch.jsonDictionary?["check_dismissed_at"] != nil) == (date <= "2026-10-21"))
        #expect(patch.query("status") == ["eq.delivered"])
        #expect(patch.query("updated_at") == ["eq.2026-11-01T09:30:15.123456+00:00"])
    }

    @Test func aNewDeliveryMailKeepsAnOldExpectedDateFromBeingDismissedTooEarly() async throws {
        let row = Rows.parcel(1, ["status": "delivered", "received_at": "2026-11-04T00:00:00Z", "expected_date": "2026-10-01", "last_email_at": "2026-11-03T22:00:00Z"])
        let (fake, writer) = try await world(row)
        guard case .success = await writer.markNotReceived(id: Rows.id(1), now: now) else {
            Issue.record("not received failed")
            return
        }
        let patch = try #require(await fake.requests("PATCH", "parcels").first)
        #expect(patch.jsonDictionary?["check_dismissed_at"] == nil)
    }

    @Test func stillRequiresDeliveredNullReceiptAndTheReadVersion() async throws {
        let row = Rows.parcel(1, ["status": "delivered", "received_at": nil, "expected_date": "2026-10-01"])
        let (fake, writer) = try await world(row)
        guard case .success = await writer.dismissCheck(id: Rows.id(1), now: now) else {
            Issue.record("still failed")
            return
        }
        let patch = try #require(await fake.requests("PATCH", "parcels").first)
        #expect(patch.query("received_at") == ["is.null"])
        #expect(patch.query("status") == ["eq.delivered"])
        #expect(patch.query("updated_at") == ["eq.2026-11-01T09:30:15.123456+00:00"])
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        let parcel = try Rows.parcelRow(stored)
        #expect(!ParcelRules.needsCheck(parcel, today: "2027-01-01"))
    }

    @Test(arguments: ["delivered", "received"])
    func manualReceiptChoiceIsOneInsertWithAnExplicitReceiptValue(choice: String) async throws {
        let fake = FakeSupabase.make()
        let (provider, _) = try await TestSession.signedIn(fake)
        let writer = ParcelWriter(provider: provider)
        var input = ManualParcelInput.defaults(today: "2026-11-04")
        input.title = "テスト商品"
        input.shop = "テスト店"
        input.status = choice
        guard case let .valid(row) = ManualParcel.check(input, userId: FakeSupabase.me, now: now, id: Rows.id(1)) else {
            Issue.record("manual input rejected")
            return
        }
        #expect(await writer.createManual(row) == .success(Rows.id(1)))
        let posts = await fake.requests("POST", "parcels")
        #expect(posts.count == 1)
        #expect(await fake.requests("PATCH", "parcels").isEmpty)
        let post = try #require(posts.first)
        #expect(post.jsonDictionary?["status"] as? String == "delivered")
        #expect(post.jsonDictionary?["received_at"] as? String == (choice == "delivered" ? "-infinity" : ManualParcel.isoString(now)))
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(stored["status"] == "delivered")
        #expect(stored["received_at"] == (choice == "delivered" ? .null : .string(ManualParcel.isoString(now))))
    }

    @Test func manualReceivedToDeliveredUsesThePressTimeForItsFourteenDayAnswer() async throws {
        let row = Rows.parcel(1, ["source": "manual", "status": "delivered", "received_at": "2026-10-22T00:00:00Z", "expected_date": "2026-10-21"])
        let (fake, writer) = try await world(row)
        let parcel = try Rows.parcelRow(row)
        var input = ManualParcelInput(editing: parcel)
        #expect(input.status == "received")
        input.status = "delivered"
        #expect(await writer.updateManual(id: parcel.id, input: input, openedUpdatedAt: parcel.updatedAt, now: now) == .saved)
        let patch = try #require(await fake.requests("PATCH", "parcels").first)
        #expect(patch.jsonDictionary?["received_at"] is NSNull)
        #expect(patch.jsonDictionary?["check_dismissed_at"] as? String == ManualParcel.isoString(now))
        #expect(patch.query("updated_at") == ["eq.\(parcel.updatedAt)"])
    }

    @Test func stillCannotOverwriteAReceiptWrittenAfterItsRead() async throws {
        let row = Rows.parcel(1, ["status": "delivered", "received_at": nil])
        let (fake, writer) = try await world(row)
        await fake.before("PATCH", "parcels") { tables in
            guard let index = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(1)) }) else { return }
            tables["parcels"]?[index]["received_at"] = "2026-11-04T01:00:00Z"
        }
        #expect(await writer.dismissCheck(id: Rows.id(1), now: now) == .notUpdated(.conflict))
        #expect(await fake.row("parcels", id: Rows.id(1))?["check_dismissed_at"] == .null)
    }
}
