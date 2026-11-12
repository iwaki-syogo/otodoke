import Foundation
import Testing
@testable import Otodoke

/// The Web's leftReceived result is about requested rows left behind, including a known zero-row
/// refusal. Exercise the real list, writer and local PostgREST fake rather than a copied reducer.
@Suite("Undo remaining receipts (Web parity)")
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

    private func assertRemainingNotice(_ model: ParcelListModel) {
        #expect(model.toast == ListToast(text: "受け取り済みのままの荷物があります", canUndo: false))
        #expect(model.toastNote == nil)
    }

    @Test func oneOfTwoReceiptsReceivedAgainElsewhereStaysAndIsSaidToRemain() async throws {
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
        assertRemainingNotice(model)
        #expect(try await current(fake, 1).receivedAt == newReceipt.deliveredReceivedAt)
        #expect(try await current(fake, 2).receivedAt == nil)
        #expect(await fake.count("PATCH", "parcels") == before + 2)
        await model.undo()
        #expect(await fake.count("PATCH", "parcels") == before + 2)
    }

    @Test func zeroRowsRestoredStillReportsTheKnownRemainingReceipts() async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        for n in 1...2 {
            await fake.touch("parcels", id: Rows.id(n), ["received_at": "2026-11-04T03:00:02Z"])
        }
        await model.undo()
        assertRemainingNotice(model)
        #expect(await fake.count("PATCH", "parcels") == 4)
        for n in 1...2 { #expect(try await current(fake, n).receivedAt == "2026-11-04T03:00:02Z") }
    }

    @Test func aKnownZeroRowRefusalDoesNotBecomeUnknownWhenTheRefreshFails() async throws {
        let (fake, _, model) = try await world(count: 1)
        try await receiveAll(model)
        await fake.touch("parcels", id: Rows.id(1), ["received_at": "2026-11-04T03:00:02Z"])
        await fake.fail(where: Self.isListRead, nth: 2, with: .transport(.notConnectedToInternet))
        await model.undo()
        assertRemainingNotice(model)
        #expect(model.refreshFailed)
        #expect(await fake.count("PATCH", "parcels") == 2)
    }

    @Test func anInvalidUndoStampIsARefusalBeforeSendingAndSaysAReceiptRemains() async throws {
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
        assertRemainingNotice(model)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(try await current(fake, 1).receivedAt == ManualParcel.isoString(Self.now))
    }

    @Test func oneConfirmedRestoreAndOneServerRefusalReportsWhatRemains() async throws {
        let (fake, _, model) = try await world()
        try await receiveAll(model)
        await fake.fail("PATCH", "parcels", nth: 4, with: .http(403))
        await model.undo()
        assertRemainingNotice(model)
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

    @Test func anUnknownRestoreWhoseReadStillShowsTheReceiptReportsRemaining() async throws {
        let (fake, _, model) = try await world(count: 1)
        try await receiveAll(model)
        await fake.fail("PATCH", "parcels", nth: 2, with: .transport(.networkConnectionLost))
        await model.undo()
        assertRemainingNotice(model)
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
        assertRemainingNotice(model)
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
