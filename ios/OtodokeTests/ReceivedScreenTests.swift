import Foundation
import Testing
@testable import Otodoke

/// Requirements at the list/detail boundary, independent of the regenerated Web golden table.
@Suite("Receipt screens (build 14)")
@MainActor
struct ReceivedScreenTests {
    nonisolated private static let today = "2026-11-04"
    nonisolated private static let now = ISO.date("2026-11-04T03:00:00Z")!

    private func list(_ fake: FakeSupabase) async throws -> ParcelListModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelListModel(reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider),
                               today: { Self.today }, now: { Self.now }, sleep: ControlledSleeper().sleep)
    }

    private func detail(_ fake: FakeSupabase) async throws -> ParcelDetailModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider),
                                 writer: ParcelWriter(provider: provider), today: { Self.today })
    }

    @Test func receiptLabelsRequireDeliveredAndAFiniteTime() throws {
        #expect(BadgeText.status("delivered") == "配達済み")
        #expect(BadgeText.status("delivered", receivedAt: "2026-11-04T03:00:00Z") == "受け取り済み")
        for bad in ["infinity", "-infinity", "invalid", ""] {
            #expect(BadgeText.status("delivered", receivedAt: bad) == "配達済み")
        }
        #expect(BadgeText.status("shipped", receivedAt: "2026-11-04T03:00:00Z") == "発送済み")
        #expect(BadgeText.status("cancelled", receivedAt: "2026-11-04T03:00:00Z") == "キャンセル")
        for received: JSONValue in [.null, "2026-11-04T03:00:00Z"] {
            let row = try Rows.parcelRow(Rows.parcel(1, ["status": "delivered", "received_at": received, "requires_presence": true]))
            let card = ParcelCardContent.make(row, today: Self.today)
            #expect(card.presenceBadge == nil)
            #expect(card.statusLabel == (received == .null ? "配達済み" : "受け取り済み"))
        }
    }

    @Test func manualChoicesKeepDeliverySeparateFromReceipt() {
        let choices = ManualParcelText.statusChoices(keeping: "delivered")
        #expect(choices.map(\.value) == ["ordered", "shipped", "delivered", "received"])
        #expect(choices.map(\.name) == ["注文済み", "発送済み", "配達済み", "受け取り済み"])
    }

    @Test func swipeOnDeliveredMovesItToReceivedAndUndoRestoresDelivery() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "expected_date": "2026-11-03", "last_email_at": "2026-11-03T00:00:00Z"])])
        let model = try await list(fake)
        await model.load()
        #expect(model.sections.arrived.map(\.id) == [Rows.id(1)])
        await model.markDelivered(id: Rows.id(1))
        #expect(model.sections.arrived.isEmpty)
        #expect(model.rows.first.map(ParcelRules.isReceived) == true)
        #expect(model.toast == ListToast(text: "受け取り済みにしました", canUndo: true))
        await model.undo()
        #expect(model.sections.arrived.map(\.id) == [Rows.id(1)])
        #expect(model.rows.first?.status == "delivered")
        #expect(model.rows.first?.receivedAt == nil)
        #expect(model.toast == nil)
    }

    @Test func notYetDismissesTheQuestionWithoutReceiving() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "expected_date": "2026-10-01", "last_email_at": "2026-10-02T00:00:00Z"])])
        let model = try await list(fake)
        await model.load()
        #expect(model.sections.toCheck.map(\.id) == [Rows.id(1)])
        await model.dismissCheck(id: Rows.id(1))
        #expect(model.sections.toCheck.isEmpty)
        #expect(model.sections.arrived.map(\.id) == [Rows.id(1)])
        #expect(model.rows.first?.receivedAt == nil)
        #expect(model.rows.first?.checkDismissedAt != nil)
        #expect(model.toast == nil)
    }

    @Test func detailOffersReceiptThenUnreceiptInsideTheApp() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "expected_date": "2026-11-03", "last_email_at": "2026-11-03T00:00:00Z"])])
        let model = try await detail(fake)
        await model.load()
        #expect(model.showsMarkReceived && model.showsNotDelivered && !model.showsNotReceived)
        await model.markReceived()
        #expect(model.fields?.statusLabel == "受け取り済み")
        #expect(model.showsNotReceived && !model.showsNotDelivered && !model.showsMarkReceived)
        await model.markNotReceived()
        #expect(model.fields?.statusLabel == "配達済み")
        #expect(model.showsMarkReceived && model.showsNotDelivered && !model.showsNotReceived)
    }

    @Test func deliveryEvidenceUsesOnlyTheLatestDeliveryExtractionAndItsOwnWords() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        await fake.insert("extractions", [
            Rows.extraction(1, parcel: 1, email: Rows.email(1, ["sent_at": "2026-11-01T00:00:00Z"]), ["result": ["relevance": "delivered", "relevance_evidence": "古い配達の文"]]),
            Rows.extraction(2, parcel: 1, email: Rows.email(2, ["sent_at": "2026-11-03T00:00:00Z"]), ["result": ["relevance": "delivered", "relevance_evidence": "  玄関前に配達しました。  "]]),
            Rows.extraction(3, parcel: 1, email: Rows.email(3, ["sent_at": "2026-11-04T00:00:00Z"]), ["result": ["relevance": "shipped", "relevance_evidence": "発送の文は使わない"]]),
            Rows.extraction(4, parcel: 1, email: Rows.email(4, ["sent_at": "2026-11-04T01:00:00Z"]), ["result": ["relevance": "delivered", "relevance_evidence": " \n "]]),
            Rows.extraction(5, parcel: 1, email: nil, ["result": ["relevance": "delivered", "relevance_evidence": "元メールがない文は使わない"]]),
        ])
        let model = try await detail(fake)
        await model.load()
        #expect(model.deliveryEvidence == "玄関前に配達しました。")
        #expect(model.timeline?.value?.count == 4)
    }

    @Test func noDeliveryEvidenceMeansNoExtraDetailRow() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered"])])
        await fake.insert("extractions", [Rows.extraction(1, parcel: 1, email: Rows.email(1), ["result": ["notes": "配達したかは不明"]])])
        let model = try await detail(fake)
        await model.load()
        #expect(model.deliveryEvidence == nil)
    }

    @Test func deletingTheAccountDropsAListReadThatIsStillOnItsWay() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let model = try await list(fake)
        let gate = Gate()
        await fake.fail("GET", "parcels", with: .hold(gate))
        let reading = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "parcels") == 1 })
        model.clearForSignOut()
        gate.open()
        await reading.value
        #expect(model.rows.isEmpty && model.toast == nil && model.counts == nil)
        await model.load()
        #expect(model.rows.isEmpty)
    }

    @Test func deletingTheAccountDropsAReceiptAnswerAndItsUndoToken() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let model = try await list(fake)
        await model.load()
        let gate = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(gate))
        let saving = Task { await model.markDelivered(id: Rows.id(1)) }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })
        model.clearForSignOut()
        gate.open()
        await saving.value
        #expect(model.rows.isEmpty && model.toast == nil && model.saving.isEmpty)
    }

    @Test func deletingTheAccountDropsDetailCalendarAndReceivedResults() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered", "received_at": "2026-11-04T00:00:00Z"])])
        let model = try await detail(fake)
        await model.load()
        #expect(model.row != nil)
        model.clearForSignOut()
        await model.load()
        #expect(model.row == nil && model.items == nil && model.timeline == nil)

        let (provider, _) = try await TestSession.signedIn(fake)
        let calendar = CalendarModel(reader: ParcelReader(provider: provider), changes: nil, today: { Self.today })
        let received = DeliveredModel(reader: StatusListReader(provider: provider), changes: nil)
        await received.load()
        #expect(received.count == 1)
        calendar.clearForSignOut()
        received.clearForSignOut()
        await calendar.load()
        await received.load()
        #expect(calendar.byDay == nil)
        #expect(received.parcels == nil && received.items == nil && received.query.isEmpty)
    }
}
