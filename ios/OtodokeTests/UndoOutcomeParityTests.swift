import Foundation
import Testing
@testable import Otodoke

/// Match the Web's existing neutral copy without changing native outcome classification or writes.
/// Exercise the real list, writer and local PostgREST fake rather than a copied reducer.
@Suite("Undo result wording (Web parity)")
@MainActor
struct UndoOutcomeParityTests {
    nonisolated private static let now = ISO.date("2026-11-04T03:00:00Z")!
    nonisolated private static let isListRead: @Sendable (StubRequest) -> Bool = {
        $0.method == "GET" && $0.path == "/rest/v1/parcels" && $0.query("status").isEmpty
    }

    private func world(count: Int = 2) async throws -> (FakeSupabase, ParcelWriter, ParcelListModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", (1...count).map {
            Rows.parcel($0, ["status": "delivered", "received_at": nil,
                             "expected_date": "2026-10-01", "last_email_at": "2026-10-01T00:00:00Z"])
        })
        let (provider, _) = try await TestSession.signedIn(fake)
        let writer = ParcelWriter(provider: provider)
        let model = ParcelListModel(reader: ParcelReader(provider: provider), writer: writer,
                                    today: { "2026-11-04" }, now: { Self.now }, sleep: ControlledSleeper().sleep)
        return (fake, writer, model)
    }

    private func receiveAll(_ model: ParcelListModel) async throws {
        await model.load()
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
    }

    private func current(_ fake: FakeSupabase, _ n: Int) async throws -> ParcelVersion {
        ParcelVersion(try Rows.parcelRow(try #require(await fake.row("parcels", id: Rows.id(n)))))
    }

    private func assertNotice(_ model: ParcelListModel, changed: Bool) {
        let text = changed ? "ほかで変更された荷物があります" : "元に戻せない荷物があります"
        #expect(model.toast == ListToast(text: text, canUndo: false))
        #expect(model.toast?.text.contains("受け取り済みのまま") == false)
        #expect(model.toastNote == nil)
    }

    private func assertOutcomeNotice(_ model: ParcelListModel, unconfirmed: Bool, changed: Bool = false) {
        #expect(model.toast == ListToast(text: unconfirmed ? "確かめられませんでした" : "元に戻せませんでした", canUndo: false))
        #expect(model.toastNote == (changed ? "ほかで変更された荷物があります" : nil))
    }

    @Test(arguments: [false, true])
    func aKnownRefusalDoesNotHideWhetherAnotherUnknownWasResolvedByReading(unknownWasSaved: Bool) async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        let refused = await fake.row("parcels", id: Rows.id(1))
        await fake.fail("PATCH", "parcels", nth: 3, with: .http(403))
        await fake.fail("PATCH", "parcels", nth: 4,
                        with: unknownWasSaved ? .applyThenDrop(.networkConnectionLost) : .transport(.networkConnectionLost))

        await model.undo()

        assertOutcomeNotice(model, unconfirmed: !unknownWasSaved)
        #expect(await fake.row("parcels", id: Rows.id(1)) == refused)
        #expect(try await current(fake, 2).receivedAt == (unknownWasSaved ? nil : ManualParcel.isoString(Self.now)))
        #expect(model.unconfirmed.isEmpty)
        #expect(await fake.count("PATCH", "parcels") == 4)
    }

    @Test(arguments: [false, true])
    func aReadResolvesEachUnknownWithoutTreatingAKnownConflictAsUnconfirmed(unknownWasSaved: Bool) async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        await fake.touch("parcels", id: Rows.id(1), ["status": "cancelled", "received_at": nil])
        let changed = await fake.row("parcels", id: Rows.id(1))
        await fake.fail("PATCH", "parcels", nth: 4,
                        with: unknownWasSaved ? .applyThenDrop(.networkConnectionLost) : .transport(.networkConnectionLost))

        await model.undo()

        if unknownWasSaved { assertNotice(model, changed: true) }
        else { assertOutcomeNotice(model, unconfirmed: true, changed: true) }
        #expect(await fake.row("parcels", id: Rows.id(1)) == changed)
        #expect(try await current(fake, 2).receivedAt == (unknownWasSaved ? nil : ManualParcel.isoString(Self.now)))
        #expect(model.unconfirmed.isEmpty)
        #expect(await fake.count("PATCH", "parcels") == 4)
    }

    @Test(arguments: [false, true], [false, true])
    func mixedRestoreChangeRefusalAndUnknownKeepTheirFactsInPriorityOrder(unknownWasSaved: Bool, readFails: Bool) async throws {
        let (fake, _, model) = try await world(count: 4)
        try await receiveAll(model)
        await fake.touch("parcels", id: Rows.id(2), ["status": "cancelled", "received_at": nil])
        let changed = await fake.row("parcels", id: Rows.id(2))
        let refused = await fake.row("parcels", id: Rows.id(3))
        await fake.fail("PATCH", "parcels", nth: 7, with: .http(403))
        await fake.fail("PATCH", "parcels", nth: 8,
                        with: unknownWasSaved ? .applyThenDrop(.networkConnectionLost) : .transport(.networkConnectionLost))
        if readFails { await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet)) }

        await model.undo()

        assertOutcomeNotice(model, unconfirmed: readFails || !unknownWasSaved, changed: true)
        #expect(try await current(fake, 1).receivedAt == nil)
        #expect(await fake.row("parcels", id: Rows.id(2)) == changed)
        #expect(await fake.row("parcels", id: Rows.id(3)) == refused)
        #expect(try await current(fake, 4).receivedAt == (unknownWasSaved ? nil : ManualParcel.isoString(Self.now)))
        #expect(model.unconfirmed == (readFails ? [Rows.id(4)] : []))
        #expect(await fake.count("PATCH", "parcels") == 8)
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == 8)
    }

    @Test(arguments: ["invalid-json", "duplicate", "missing-field", "wrong-id"], [false, true])
    func aBrokenUndoReplyIsResolvedOnlyByAReadThatConfirmsRestoration(shape: String, readFails: Bool) async throws {
        let (fake, _, model) = try await world(count: 1)
        try await receiveAll(model)
        StubURLProtocol.register(host: fake.host) { request in
            let reply = await fake.handle(request)
            guard request.method == "PATCH", request.path == "/rest/v1/parcels",
                  request.jsonDictionary?["received_at"] is NSNull,
                  case let .http(status, headers, data) = reply, (200..<300).contains(status),
                  let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                  var row = rows.first else { return reply }
            switch shape {
            case "duplicate": return .json(status, [row, row], headers: headers)
            case "missing-field": row["updated_at"] = nil
            case "wrong-id": row["id"] = Rows.id(99)
            default: return .http(status: status, headers: headers, body: Data("synthetic invalid JSON".utf8))
            }
            return .json(status, [row], headers: headers)
        }
        if readFails { await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet)) }

        await model.undo()

        if readFails {
            assertOutcomeNotice(model, unconfirmed: true)
            #expect(model.unconfirmed == [Rows.id(1)])
        } else {
            #expect(model.toast == nil)
            #expect(model.unconfirmed.isEmpty)
        }
        #expect(try await current(fake, 1).receivedAt == nil)
        #expect(await fake.requests("GET", "parcels").filter(Self.isListRead).count == 2)
        #expect(await fake.count("PATCH", "parcels") == 2)
    }

    @Test(arguments: ["missing", "wrong-status"])
    func aReadCannotResolveAnUnknownFromAMissingRowOrOnlyANullReceipt(_ state: String) async throws {
        let (fake, _, model) = try await world(count: 1)
        try await receiveAll(model)
        await fake.fail("PATCH", "parcels", nth: 2, with: .transport(.networkConnectionLost))
        await fake.before("GET", "parcels", nth: 2) { tables in
            if state == "missing" { tables["parcels"] = [] }
            else {
                guard let i = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(1)) }) else { return }
                tables["parcels"]?[i]["status"] = "cancelled"
                tables["parcels"]?[i]["received_at"] = .null
            }
        }

        await model.undo()

        assertOutcomeNotice(model, unconfirmed: true)
        #expect(model.unconfirmed.isEmpty)
        #expect(await fake.count("PATCH", "parcels") == 2)
        if state == "missing" { #expect(await fake.row("parcels", id: Rows.id(1)) == nil) }
        else { #expect(try await current(fake, 1).status == "cancelled") }
    }

    @Test func resolvingOnlyOneOfTwoUnknownsDoesNotHideTheOtherBesideARefusalAndChange() async throws {
        let (fake, _, model) = try await world(count: 4)
        try await receiveAll(model)
        await fake.touch("parcels", id: Rows.id(1), ["status": "cancelled", "received_at": nil])
        let changed = await fake.row("parcels", id: Rows.id(1))
        let refused = await fake.row("parcels", id: Rows.id(2))
        await fake.fail("PATCH", "parcels", nth: 6, with: .http(403))
        await fake.fail("PATCH", "parcels", nth: 7, with: .applyThenDrop(.networkConnectionLost))
        await fake.fail("PATCH", "parcels", nth: 8, with: .transport(.networkConnectionLost))

        await model.undo()

        assertOutcomeNotice(model, unconfirmed: true, changed: true)
        #expect(await fake.row("parcels", id: Rows.id(1)) == changed)
        #expect(await fake.row("parcels", id: Rows.id(2)) == refused)
        #expect(try await current(fake, 3).receivedAt == nil)
        #expect(try await current(fake, 4).receivedAt == ManualParcel.isoString(Self.now))
        #expect(model.unconfirmed.isEmpty)
        #expect(await fake.count("PATCH", "parcels") == 8)
    }

    @Test(arguments: ["refused", "unknown"], [false, true])
    func aDelayedUndoCannotReplaceANewerToastOrReviveARetiredScreen(answer: String, retire: Bool) async throws {
        let (fake, _, model) = try await world()
        await model.load()
        await model.markDelivered(id: Rows.id(1))
        let release = Gate()
        defer { release.open() }
        await fake.fail("PATCH", "parcels", nth: 2,
                        with: .holdThen(release, answer == "refused" ? .http(403) : .transport(.networkConnectionLost)))
        let run = Task { await model.undo() }
        let reached = await waitFor { await fake.count("PATCH", "parcels") == 2 }
        try #require(reached && model.isUndoing)
        if retire { model.clearForSignOut() }
        else { await model.markDelivered(id: Rows.id(2)) }
        let newer = model.toast, note = model.toastNote
        release.open()
        await run.value

        #expect(model.toast == newer)
        #expect(model.toastNote == note)
        #expect(await fake.count("PATCH", "parcels") == (retire ? 2 : 3))
        if retire {
            #expect(model.rows.isEmpty && model.toast == nil)
        } else {
            #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
            #expect(try await current(fake, 2).receivedAt == ManualParcel.isoString(Self.now))
        }
    }

    @Test(arguments: ["unreceived", "cancelled", "deleted"])
    func anOldUndoDescribesAChangeWithoutClaimingAReceiptRemains(_ condition: String) async throws {
        let (fake, writer, model) = try await world(count: 1)
        try await receiveAll(model)
        let received = try await current(fake, 1)
        let receivedAt = try #require(received.receivedAt)
        if condition == "unreceived" {
            guard case .success = await writer.markNotReceived(id: Rows.id(1), now: Self.now.addingTimeInterval(1)) else {
                Issue.record("the other screen did not clear the receipt")
                return
            }
        } else if condition == "cancelled" {
            await fake.touch("parcels", id: Rows.id(1), ["status": "cancelled", "received_at": nil])
        } else {
            await fake.mutate { $0["parcels"] = [] }
        }
        let before = await fake.row("parcels", id: Rows.id(1))
        let count = await fake.count("PATCH", "parcels")

        await model.undo()

        assertNotice(model, changed: true)
        #expect(await fake.row("parcels", id: Rows.id(1)) == before)
        let patch = try #require(await fake.requests("PATCH", "parcels").last)
        #expect(patch.query("user_id") == ["eq.\(FakeSupabase.me)"])
        #expect(patch.query("status") == ["eq.delivered"])
        #expect(patch.query("received_at").contains("eq.\(receivedAt)"))
        #expect(patch.query("updated_at") == ["eq.\(received.updatedAt)"])
        #expect(await fake.count("PATCH", "parcels") == count + 1)
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == count + 1)
    }

    @Test func anOldKeptReceiptDoesNotClaimTheCurrentParcelIsStillReceived() async throws {
        let (fake, writer, model) = try await world()
        await model.load()
        await fake.before("PATCH", "parcels", nth: 2) { tables in
            guard let i = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(2)) }) else { return }
            tables["parcels"]?[i]["received_at"] = "2026-11-04T03:00:02Z"
            tables["parcels"]?[i]["updated_at"] = "2026-11-04T05:00:00.900000+00:00"
        }
        await model.deliverAll()
        #expect(model.toast?.canUndo == true)
        #expect(model.toastNote == "元に戻せない荷物があります")
        guard case .success = await writer.markNotReceived(id: Rows.id(2), now: Self.now.addingTimeInterval(3)) else {
            Issue.record("the other screen did not clear the kept receipt")
            return
        }
        let kept = await fake.row("parcels", id: Rows.id(2))
        let count = await fake.count("PATCH", "parcels")

        await model.undo()

        assertNotice(model, changed: false)
        #expect(try await current(fake, 1).receivedAt == nil)
        #expect(try await current(fake, 2).receivedAt == nil)
        #expect(await fake.row("parcels", id: Rows.id(2)) == kept)
        #expect(await fake.count("PATCH", "parcels") == count + 1)
        #expect(await fake.requests("PATCH", "parcels").last?.query("id") == ["eq.\(Rows.id(1))"])
    }

    @Test func anExplicitRefusalTakesPriorityOverAKnownChangeWithoutOverwritingEitherRow() async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        await fake.touch("parcels", id: Rows.id(1), ["status": "cancelled", "received_at": nil])
        let before = await fake.rows("parcels")
        await fake.fail("PATCH", "parcels", nth: 4, with: .http(403))

        await model.undo()

        assertOutcomeNotice(model, unconfirmed: false, changed: true)
        #expect(await fake.rows("parcels") == before)
        #expect(await fake.count("PATCH", "parcels") == 4)
        #expect(model.unconfirmed.isEmpty)
    }

    @Test(arguments: [false, true])
    func aConflictCannotTurnAnUnknownRestoreAndFailedReadIntoAChangedNotice(unknownWasSaved: Bool) async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        await fake.touch("parcels", id: Rows.id(1), ["status": "cancelled", "received_at": nil])
        let changed = await fake.row("parcels", id: Rows.id(1))
        await fake.fail("PATCH", "parcels", nth: 4,
                        with: unknownWasSaved ? .applyThenDrop(.networkConnectionLost) : .transport(.networkConnectionLost))
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))

        await model.undo()

        assertOutcomeNotice(model, unconfirmed: true, changed: true)
        #expect(model.unconfirmed == [Rows.id(2)])
        #expect(model.refreshFailed)
        #expect(await fake.row("parcels", id: Rows.id(1)) == changed)
        #expect(try await current(fake, 2).receivedAt == (unknownWasSaved ? nil : ManualParcel.isoString(Self.now)))
        #expect(await fake.count("PATCH", "parcels") == 4)
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == 4)
    }

    @Test func oneOfTwoReceiptsReceivedAgainElsewhereIsReportedAsChanged() async throws {
        let (fake, writer, model) = try await world()
        try await receiveAll(model)
        guard case .success = await writer.markNotReceived(id: Rows.id(1), now: Self.now.addingTimeInterval(1)) else {
            Issue.record("the other device did not clear the first receipt")
            return
        }
        guard case let .success(newReceipt) = await writer.markDelivered(try await current(fake, 1), now: Self.now.addingTimeInterval(2)) else {
            Issue.record("the other device did not receive the parcel again")
            return
        }
        let before = await fake.count("PATCH", "parcels")
        await model.undo()
        assertNotice(model, changed: true)
        #expect(try await current(fake, 1).receivedAt == newReceipt.deliveredReceivedAt)
        #expect(try await current(fake, 2).receivedAt == nil)
        #expect(await fake.count("PATCH", "parcels") == before + 2)
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == before + 2)
    }

    @Test func zeroRowsRestoredReportsTheKnownChange() async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        for n in 1...2 {
            await fake.touch("parcels", id: Rows.id(n), ["received_at": "2026-11-04T03:00:02Z"])
        }
        await model.undo()
        assertNotice(model, changed: true)
        #expect(await fake.count("PATCH", "parcels") == 4)
        for n in 1...2 { #expect(try await current(fake, n).receivedAt == "2026-11-04T03:00:02Z") }
    }

    @Test func aKnownZeroRowRefusalDoesNotBecomeUnknownWhenTheRefreshFails() async throws {
        let (fake, _, model) = try await world(count: 1)
        try await receiveAll(model)
        await fake.touch("parcels", id: Rows.id(1), ["received_at": "2026-11-04T03:00:02Z"])
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.undo()
        assertNotice(model, changed: true)
        #expect(model.refreshFailed)
        #expect(await fake.count("PATCH", "parcels") == 2)
    }

    @Test func anInvalidUndoStampIsARefusalBeforeSendingAndUsesNeutralCopy() async throws {
        let (fake, _, model) = try await world(count: 1)
        // The receipt is really saved. Only its reply's version is malformed, making the generated
        // token invalid for the next write. No private state or production test hook is involved.
        StubURLProtocol.register(host: fake.host) { request in
            let reply = await fake.handle(request)
            guard request.method == "PATCH", request.path == "/rest/v1/parcels",
                  request.jsonDictionary?["status"] as? String == "delivered",
                  case let .http(status, headers, data) = reply, (200..<300).contains(status),
                  var rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]], rows.count == 1 else { return reply }
            rows[0]["updated_at"] = ""
            return .json(status, rows, headers: headers)
        }
        try await receiveAll(model)
        await model.undo()
        assertOutcomeNotice(model, unconfirmed: false)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(try await current(fake, 1).receivedAt == ManualParcel.isoString(Self.now))
    }

    @Test func oneConfirmedRestoreAndOneServerRefusalUseNeutralCopy() async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        await fake.fail("PATCH", "parcels", nth: 4, with: .http(403))
        await model.undo()
        assertOutcomeNotice(model, unconfirmed: false)
        let rows = await fake.rows("parcels")
        #expect(rows.filter { $0["received_at"] == .null }.count == 1)
        #expect(rows.filter { $0["received_at"]?.string == ManualParcel.isoString(Self.now) }.count == 1)
        #expect(await fake.count("PATCH", "parcels") == 4)
    }

    @Test(arguments: [true, false])
    func allServerOrBeforeSendFailuresKeepTheGenericFailure(serverRefusal: Bool) async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        for n in 3...4 {
            await fake.fail("PATCH", "parcels", nth: n,
                            with: serverRefusal ? .http(403) : .transport(.notConnectedToInternet))
        }
        await model.undo()
        #expect(model.toast == ListToast(text: "元に戻せませんでした", canUndo: false))
        #expect(await fake.count("PATCH", "parcels") == 4)
        for n in 1...2 { #expect(try await current(fake, n).receivedAt == ManualParcel.isoString(Self.now)) }
    }

    @Test func anUnknownRestoreConfirmedByTheReadIsDoneWithoutRetrying() async throws {
        let (fake, _, model) = try await world(count: 1)
        try await receiveAll(model)
        await fake.fail("PATCH", "parcels", nth: 2, with: .applyThenDrop(.networkConnectionLost))
        await model.undo()
        #expect(model.toast == nil)
        #expect(model.unconfirmed.isEmpty)
        #expect(try await current(fake, 1).receivedAt == nil)
        #expect(await fake.count("PATCH", "parcels") == 2)
    }

    @Test func anUnknownRestoreRemainsUnconfirmedWhenTheReadDoesNotProveRestoration() async throws {
        let (fake, _, model) = try await world(count: 1)
        try await receiveAll(model)
        await fake.fail("PATCH", "parcels", nth: 2, with: .transport(.networkConnectionLost))
        await model.undo()
        assertOutcomeNotice(model, unconfirmed: true)
        #expect(model.unconfirmed.isEmpty)
        #expect(try await current(fake, 1).receivedAt == ManualParcel.isoString(Self.now))
        #expect(await fake.count("PATCH", "parcels") == 2)
    }

    @Test func anUnknownRestoreAndFailedReadRemainUnconfirmed() async throws {
        let (fake, _, model) = try await world(count: 1)
        try await receiveAll(model)
        await fake.fail("PATCH", "parcels", nth: 2, with: .applyThenDrop(.networkConnectionLost))
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.undo()
        #expect(model.toast == ListToast(text: "確かめられませんでした", canUndo: false))
        #expect(model.unconfirmed == [Rows.id(1)])
        #expect(await fake.count("PATCH", "parcels") == 2)
    }

    @Test func aConfirmedRestoreDoesNotHideAnotherUnknownResultWhoseReadFailed() async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        await fake.fail("PATCH", "parcels", nth: 4, with: .applyThenDrop(.networkConnectionLost))
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.undo()
        #expect(model.toast == ListToast(text: "確かめられませんでした", canUndo: false))
        #expect(model.unconfirmed.count == 1)
        #expect(await fake.count("PATCH", "parcels") == 4)
    }

    @Test func normallyRestoringEveryReceiptHidesTheToast() async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        await model.undo()
        #expect(model.toast == nil)
        #expect(model.unconfirmed.isEmpty)
        #expect(await fake.count("PATCH", "parcels") == 4)
        for n in 1...2 { #expect(try await current(fake, n).receivedAt == nil) }
    }

    @Test func oneWrittenAndOneAlreadyReceivedOfferOnlyTheWrittenUndoAndExplainBothNotices() async throws {
        let (fake, _, model) = try await world()
        await model.load()
        await fake.before("PATCH", "parcels", nth: 2) { tables in
            guard let i = tables["parcels"]?.firstIndex(where: { $0["id"] == .string(Rows.id(2)) }) else { return }
            tables["parcels"]?[i]["received_at"] = "2026-11-04T03:00:02Z"
            tables["parcels"]?[i]["updated_at"] = "2026-11-04T05:00:00.900000+00:00"
        }
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        #expect(model.toastNote == "元に戻せない荷物があります")
        await model.undo()
        assertNotice(model, changed: false)
        let patches = await fake.requests("PATCH", "parcels")
        #expect(patches.count == 3)
        #expect(patches.last?.query("id") == ["eq.\(Rows.id(1))"])
        #expect(try await current(fake, 1).receivedAt == nil)
        #expect(try await current(fake, 2).receivedAt == "2026-11-04T03:00:02Z")
    }

    @Test func everyBulkRowAlreadyReceivedShowsSavedWithNoUndoAndNeverResends() async throws {
        let (fake, _, model) = try await world()
        await model.load()
        for n in 1...2 { await fake.touch("parcels", id: Rows.id(n), ["received_at": "2026-11-04T03:00:02Z"]) }
        await model.deliverAll()
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: false))
        #expect(model.toastNote == nil)
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == 2)
        for n in 1...2 { #expect(try await current(fake, n).receivedAt == "2026-11-04T03:00:02Z") }
    }

    @Test func aSingleAlreadyReceivedRowShowsSavedWithNoUndoAndNeverResends() async throws {
        let (fake, _, model) = try await world(count: 1)
        await model.load()
        await fake.touch("parcels", id: Rows.id(1), ["received_at": "2026-11-04T03:00:02Z"])
        await model.markDelivered(id: Rows.id(1))
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: false))
        #expect(model.toastNote == nil)
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(try await current(fake, 1).receivedAt == "2026-11-04T03:00:02Z")
    }

    @Test(arguments: ["failed-read", "missing", "cancelled", "unreceived"], [false, true])
    func aRefusedReceiptIsNotSavedWithoutAPresentConfirmedReceipt(condition: String, bulk: Bool) async throws {
        let (fake, _, model) = try await world(count: 1)
        await model.load()
        switch condition {
        case "failed-read":
            await fake.touch("parcels", id: Rows.id(1), ["received_at": "2026-11-04T03:00:02Z"])
            await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        case "missing":
            await fake.mutate { $0["parcels"] = [] }
        case "cancelled":
            await fake.touch("parcels", id: Rows.id(1), ["status": "cancelled", "received_at": nil])
        default:
            await fake.touch("parcels", id: Rows.id(1), ["status": "delivered", "received_at": nil])
        }
        if bulk { await model.deliverAll() } else { await model.markDelivered(id: Rows.id(1)) }
        #expect(model.toast == nil)
        #expect(model.toastNote == nil)
        #expect(await fake.count("PATCH", "parcels") == 1)
        if condition == "failed-read" { #expect(model.refreshFailed) }
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == 1)
    }
}
