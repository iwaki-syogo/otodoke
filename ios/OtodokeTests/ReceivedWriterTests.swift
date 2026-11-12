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

/// B3: an undo belongs to the receipt this operation actually wrote. Ordinary concurrent writers
/// advance updated_at; the explicit stamp-collision case isolates the additional Web contract.
@Suite("Receipt undo ownership (B3)")
@MainActor
struct ReceiptUndoOwnershipTests {
    nonisolated private static let now = ISO.date("2026-11-04T03:00:00Z")!

    private func setup(_ rows: [Row]) async throws -> (FakeSupabase, ParcelWriter, ParcelListModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", rows)
        let (provider, _) = try await TestSession.signedIn(fake)
        let writer = ParcelWriter(provider: provider)
        let sleeper = ControlledSleeper()
        let model = ParcelListModel(reader: ParcelReader(provider: provider), writer: writer,
                                    today: { "2026-11-04" }, now: { Self.now }, sleep: sleeper.sleep)
        return (fake, writer, model)
    }

    private func current(_ fake: FakeSupabase, _ n: Int) async throws -> ParcelVersion {
        ParcelVersion(try Rows.parcelRow(try #require(await fake.row("parcels", id: Rows.id(n)))))
    }

    private func checkedRow(_ n: Int) -> Row {
        Rows.parcel(n, ["status": "delivered", "received_at": nil,
                        "expected_date": "2026-10-01", "last_email_at": "2026-10-01T00:00:00Z"])
    }

    @Test func anOldUndoCannotEraseAnotherDevicesUnreceiveAndReceive() async throws {
        let (fake, writer, _) = try await setup([Rows.parcel(1)])
        guard case let .success(oldToken) = await writer.markDelivered(try await current(fake, 1), now: Self.now) else {
            Issue.record("first receipt was not saved")
            return
        }
        guard case .success = await writer.markNotReceived(id: Rows.id(1), now: Self.now.addingTimeInterval(1)) else {
            Issue.record("other device could not clear the first receipt")
            return
        }
        guard case let .success(newToken) = await writer.markDelivered(try await current(fake, 1), now: Self.now.addingTimeInterval(2)) else {
            Issue.record("other device could not receive again")
            return
        }
        #expect(newToken.deliveredUpdatedAt != oldToken.deliveredUpdatedAt)
        #expect(newToken.deliveredReceivedAt != oldToken.deliveredReceivedAt)
        #expect(await writer.undoDelivered(oldToken) == .notUpdated(.conflict))
        let kept = try await current(fake, 1)
        #expect(kept.status == "delivered")
        #expect(kept.receivedAt == newToken.deliveredReceivedAt)
        #expect(kept.updatedAt == newToken.deliveredUpdatedAt)
    }

    @Test func aMixedBulkUndoTouchesOnlyItsWrittenRowsAndKeepsANewerReceipt() async throws {
        let (fake, writer, model) = try await setup([checkedRow(1), checkedRow(2), checkedRow(3)])
        await model.load()
        #expect(Set(model.sections.toCheck.map(\.id)) == Set([1, 2, 3].map(Rows.id)))
        // The second target was received elsewhere after the screen read it: this operation writes 0 rows.
        await fake.before("PATCH", "parcels", nth: 2) { tables in
            guard let i = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(2)) }) else { return }
            tables["parcels"]?[i]["received_at"] = "2026-11-04T03:00:01Z"
            tables["parcels"]?[i]["updated_at"] = "2026-11-04T05:00:00.900000+00:00"
        }
        await model.deliverAll()
        #expect(model.toast?.canUndo == true)
        #expect(await fake.requests("PATCH", "parcels").count == 3)
        // A row this operation did write is cleared and received again by another device.
        guard case .success = await writer.markNotReceived(id: Rows.id(3), now: Self.now.addingTimeInterval(2)) else {
            Issue.record("other device could not clear the bulk receipt")
            return
        }
        guard case let .success(newToken) = await writer.markDelivered(try await current(fake, 3), now: Self.now.addingTimeInterval(3)) else {
            Issue.record("other device could not receive the bulk row again")
            return
        }
        let beforeUndo = await fake.requests("PATCH", "parcels").count
        await model.undo()
        let undoRequests = await fake.requests("PATCH", "parcels").dropFirst(beforeUndo)
        #expect(undoRequests.count == 2)
        #expect(Set(undoRequests.flatMap { $0.query("id") }) == Set([1, 3].map { "eq.\(Rows.id($0))" }))
        #expect(try await current(fake, 1).receivedAt == nil)
        #expect(try await current(fake, 2).receivedAt == "2026-11-04T03:00:01Z")
        #expect(try await current(fake, 3).receivedAt == newToken.deliveredReceivedAt)
        #expect(try await current(fake, 3).updatedAt == newToken.deliveredUpdatedAt)
        #expect(model.toast == ListToast(text: "受け取り済みのままの荷物があります", canUndo: false))
    }

    @Test func zeroWrittenRowsNeverOfferOrSendAnUndo() async throws {
        let (fake, _, model) = try await setup([checkedRow(1)])
        await model.load()
        await fake.touch("parcels", id: Rows.id(1), ["received_at": "2026-11-04T03:00:01Z"])
        await model.deliverAll()
        #expect(await fake.requests("PATCH", "parcels").count == 1)
        #expect(model.toast?.canUndo != true)
        let beforeUndo = await fake.requests("PATCH", "parcels").count
        await model.undo()
        #expect(await fake.requests("PATCH", "parcels").count == beforeUndo)
        #expect(try await current(fake, 1).receivedAt == "2026-11-04T03:00:01Z")
    }

    @Test(arguments: ["shipped", "delivered"])
    func aNormalUndoStillRestoresItsOwnPreviousState(status: String) async throws {
        let row = Rows.parcel(1, ["status": .string(status), "received_at": nil,
                                 "check_dismissed_at": status == "delivered" ? "2026-10-20T00:00:00Z" : nil])
        let (fake, writer, _) = try await setup([row])
        let before = try await current(fake, 1)
        guard case let .success(token) = await writer.markDelivered(before, now: Self.now) else {
            Issue.record("receipt was not saved")
            return
        }
        guard case .success = await writer.undoDelivered(token) else {
            Issue.record("own unchanged receipt could not be undone")
            return
        }
        let after = try await current(fake, 1)
        #expect(after.status == before.status)
        #expect(after.receivedAt == before.receivedAt)
        #expect(after.checkDismissedAt == before.checkDismissedAt)
    }

    @Test func aDifferentReceiptCannotBeUndoneEvenIfTheVersionStampIsReused() async throws {
        let (fake, writer, _) = try await setup([Rows.parcel(1)])
        guard case let .success(token) = await writer.markDelivered(try await current(fake, 1), now: Self.now) else {
            Issue.record("receipt was not saved")
            return
        }
        // Deliberately reuse the stamp to isolate received_at ownership from ordinary OCC.
        // This is not the normal B3 sequence, whose real writes advance updated_at above.
        await fake.mutate { tables in
            guard let i = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(1)) }) else { return }
            tables["parcels"]?[i]["received_at"] = "2026-11-04T03:00:02Z"
        }
        #expect(await writer.undoDelivered(token) == .notUpdated(.conflict))
        #expect(try await current(fake, 1).receivedAt == "2026-11-04T03:00:02Z")
    }

    @Test(arguments: [true, false])
    func markingReceivedNeverReplacesAReceiptAlreadySetAtTheMatchedVersion(wasReceivedWhenShown: Bool) async throws {
        let existingReceipt = "2026-11-04T02:00:00Z"
        let row = Rows.parcel(1, ["status": "delivered", "received_at": wasReceivedWhenShown ? .string(existingReceipt) : nil])
        let (fake, writer, _) = try await setup([row])
        let shown = try await current(fake, 1)
        if !wasReceivedWhenShown {
            // Deliberately keep the shown stamp: the null condition must protect the write by itself.
            await fake.before("PATCH", "parcels") { tables in
                guard let i = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(1)) }) else { return }
                tables["parcels"]?[i]["received_at"] = .string(existingReceipt)
            }
        }
        #expect(await writer.markDelivered(shown, now: Self.now) == .notUpdated(.conflict))
        let kept = try await current(fake, 1)
        #expect(kept.receivedAt == existingReceipt)
        #expect(kept.updatedAt == shown.updatedAt)
        #expect(await fake.requests("PATCH", "parcels").count == 1)
    }

    @Test(arguments: [nil, "", "not-a-time", "infinity", "-infinity"] as [String?])
    func undoWithoutAConfirmedFiniteReceiptIsRefusedBeforeSending(receivedAt: String?) async throws {
        let row = Rows.parcel(1, ["status": "delivered", "received_at": "2026-11-04T03:00:00Z"])
        let (fake, writer, _) = try await setup([row])
        let before = try await current(fake, 1)
        let token = UndoToken(id: before.id, restoreTo: "shipped", deliveredUpdatedAt: before.updatedAt,
                              deliveredReceivedAt: receivedAt)
        #expect(await writer.undoDelivered(token) == .notUpdated(.invalidInput))
        #expect(await fake.requests("PATCH", "parcels").isEmpty)
        #expect(try await current(fake, 1) == before)
    }

    @Test(arguments: ["missing", "null", "malformed", "infinity", "-infinity", "wrong-status"])
    func anUnconfirmedReceiptAnswerCreatesNoUndoAndIsNeverRetried(answer: String) async throws {
        let (fake, writer, _) = try await setup([Rows.parcel(1)])
        StubURLProtocol.register(host: fake.host) { request in
            let reply = await fake.handle(request)
            guard request.method == "PATCH", request.path == "/rest/v1/parcels",
                  case let .http(status, headers, data) = reply, (200..<300).contains(status),
                  var rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], rows.count == 1 else { return reply }
            // The write really ran, but its answer fails to confirm the state needed for an undo.
            switch answer {
            case "missing": rows[0].removeValue(forKey: "received_at")
            case "null": rows[0]["received_at"] = NSNull()
            case "malformed": rows[0]["received_at"] = "not-a-time"
            case "wrong-status": rows[0]["status"] = "shipped"
            default: rows[0]["received_at"] = answer
            }
            return .json(status, rows, headers: headers)
        }
        #expect(await writer.markDelivered(try await current(fake, 1), now: Self.now) == .unknown)
        #expect(await fake.requests("PATCH", "parcels").count == 1)
        let stored = try await current(fake, 1)
        #expect(stored.status == "delivered")
        #expect(stored.receivedAt == ManualParcel.isoString(Self.now))
    }

    @Test(arguments: ["2026-11-04T03:00:00+00:00", "2026-11-04T03:00:00.000000+00:00"])
    func theUndoReceiptUsesTheServersTimestampSpellingAndRemainsUndoable(storedAt: String) async throws {
        let (fake, writer, _) = try await setup([Rows.parcel(1)])
        // Postgres may return the same timestamptz in a different spelling from the client's ISO string.
        // Normalize this one response and the fake's stored row together; no real server is involved.
        StubURLProtocol.register(host: fake.host) { request in
            let reply = await fake.handle(request)
            guard request.method == "PATCH", request.path == "/rest/v1/parcels",
                  request.jsonDictionary?["received_at"] is String,
                  case let .http(status, headers, data) = reply, (200..<300).contains(status) else { return reply }
            await fake.mutate { tables in
                guard let i = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(1)) }) else { return }
                tables["parcels"]?[i]["received_at"] = .string(storedAt)
            }
            guard var rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], rows.count == 1 else { return reply }
            rows[0]["received_at"] = storedAt
            return .json(status, rows, headers: headers)
        }
        #expect(Instant.micros(storedAt) == Instant.micros(ManualParcel.isoString(Self.now)))
        guard case let .success(token) = await writer.markDelivered(try await current(fake, 1), now: Self.now) else {
            Issue.record("receipt was not saved")
            return
        }
        #expect(token.deliveredReceivedAt == storedAt)
        guard case .success = await writer.undoDelivered(token) else {
            Issue.record("timestamp spelling must not make an own unchanged receipt impossible to undo")
            return
        }
        #expect(try await current(fake, 1).status == "shipped")
        #expect(try await current(fake, 1).receivedAt == nil)
    }
}
