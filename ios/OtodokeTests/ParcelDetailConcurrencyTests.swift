import Foundation
import Testing
@testable import Otodoke

/// [Fix C1・C2・C4・SEC-N5] The detail page when reads and writes overlap: an unknown write whose read
/// fails too is never sent again, a slow read never puts back what a save changed, and a save started
/// in an earlier opening of the category sheet never closes a later one.
@Suite("ParcelDetailModel overlaps (fix 1)")
@MainActor
struct ParcelDetailConcurrencyTests {
    private func seeded(status: String = "delivered") async throws -> (FakeSupabase, ParcelDetailModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": .string(status), "tracking_number": "1234-5678-9012", "category": "food"])])
        await fake.insert("parcel_items", [Rows.item(1, parcel: 1)])
        await fake.insert("extractions", [Rows.extraction(1, parcel: 1, email: Rows.email(1))])
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
        await model.load()
        return (fake, model)
    }

    private func stored(_ fake: FakeSupabase, _ column: String) async -> String? {
        await fake.row("parcels", id: Rows.id(1))?[column]?.string
    }

    // MARK: C1

    @Test func notDeliveredLostThenAFailedReadThenATapSendsNothing() async throws {
        let (fake, model) = try await seeded()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        // GET parcels: 1 = the page, 2 = the writer's read before writing, 3 = the read after the lost
        // answer, 4 = the read on the next tap.
        await fake.fail("GET", "parcels", nth: 3, with: .http(500))
        await fake.fail("GET", "parcels", nth: 4, with: .transport(.notConnectedToInternet))
        await model.markNotDelivered()
        #expect(model.isUnconfirmed == true)
        #expect(model.notDeliveredError == "確かめられませんでした")
        #expect(model.showsNotDelivered == true)

        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(await fake.count("GET", "parcels") == 4)
        #expect(model.notDeliveredError == "確かめられませんでした")

        // A read that works settles it: it had gone through.
        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.isUnconfirmed == false)
        #expect(model.notDeliveredError == nil)
        #expect(model.row?.status == "shipped")
        #expect(model.showsNotDelivered == false)
    }

    @Test func aCategoryLostThenAFailedReadThenAChoiceSendsNothing() async throws {
        let (fake, model) = try await seeded()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await fake.fail("GET", "parcels", nth: 2, with: .http(500))
        await fake.fail("GET", "parcels", nth: 3, with: .http(500))
        #expect(await model.setCategory(.hobby) == false)
        #expect(model.categoryError == "確かめられませんでした")
        #expect(model.isUnconfirmed == true)

        #expect(await model.setCategory(.daily) == false)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.categoryError == "確かめられませんでした")
        #expect(await stored(fake, "category") == "hobby")

        // 「届いていない」 is not sent either while it is not known.
        await fake.fail("GET", "parcels", nth: 4, with: .http(500))
        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 1)

        // The next read works: the chip shows what was saved, and choices write again.
        #expect(await model.setCategory(.daily) == false)
        #expect(model.isUnconfirmed == false)
        #expect(model.shownCategory == .hobby)
        #expect(model.categoryError == nil)
        #expect(await model.setCategory(.daily) == true)
        #expect(await fake.count("PATCH", "parcels") == 2)
        #expect(await stored(fake, "category") == "daily")
    }

    // MARK: C2

    @Test func aSlowReadAnsweredBeforeACategorySaveDoesNotPutTheOldOneBack() async throws {
        let (fake, model) = try await seeded()
        let gate = Gate()
        await fake.fail("GET", "parcels", nth: 2, with: .delay(gate))
        let refresh = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "parcels") == 2 })
        #expect(await model.setCategory(.hobby) == true)
        gate.open()
        await refresh.value
        #expect(await fake.count("GET", "parcels") == 3)
        #expect(model.shownCategory == .hobby)
        #expect(model.storedCategory == .hobby)
        #expect(model.row?.updatedAt == (await stored(fake, "updated_at")))
    }

    @Test func aSlowReadAnsweredBeforeNotDeliveredDoesNotBringBackDelivered() async throws {
        let (fake, model) = try await seeded()
        let gate = Gate()
        await fake.fail("GET", "parcels", nth: 2, with: .delay(gate))
        let refresh = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "parcels") == 2 })
        await model.markNotDelivered()
        #expect(model.row?.status == "shipped")
        gate.open()
        await refresh.value
        #expect(model.row?.status == "shipped")
        #expect(model.showsNotDelivered == false)
    }

    @Test func aReadAnsweredWhileASaveIsInFlightIsReadAgainAfterIt() async throws {
        let (fake, model) = try await seeded()
        let patch = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(patch))
        let save = Task { await model.setCategory(.hobby) }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })
        await model.load()
        #expect(model.shownCategory == .hobby)
        patch.open()
        #expect(await save.value == true)
        #expect(await waitFor { await fake.count("GET", "parcels") == 3 })
        #expect(model.storedCategory == .hobby)
    }

    @Test func anOlderLoadThatFailsLateKeepsTheNewerParcel() async throws {
        let (fake, model) = try await seeded()
        let gate = Gate()
        await fake.fail("GET", "parcels", nth: 2, with: .holdThen(gate, .http(500)))
        let older = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "parcels") == 2 })
        await model.load()
        gate.open()
        await older.value
        #expect(model.row?.id == Rows.id(1))
    }

    // MARK: C4

    @Test func aSaveFromAnEarlierOpeningDoesNotCloseALaterOne() {
        var sheet = SheetPresentation()
        sheet.open()
        let first = sheet.current
        #expect(sheet.isCurrent(first))
        sheet.open()
        #expect(!sheet.isCurrent(first))
        #expect(sheet.isCurrent(sheet.current))
    }

    // MARK: SEC-N5

    @Test func theThreeReadsCarryTheUser() async throws {
        let (fake, _) = try await seeded()
        for resource in ["parcels", "parcel_items", "extractions"] {
            let get = try #require(await fake.requests("GET", resource).first, "\(resource)")
            #expect(get.query("user_id") == ["eq.\(FakeSupabase.me)"], "\(resource)")
        }
    }

    @Test func signedOutTheDetailReadsSendNothing() async throws {
        let fake = FakeSupabase.make()
        let provider = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage())
        let reader = ParcelReader(provider: provider)
        #expect(await reader.parcel(id: Rows.id(1)) == .failed)
        #expect(await reader.items(parcelID: Rows.id(1)) == .failed)
        #expect(await reader.extractions(parcelID: Rows.id(1)) == .failed)
        #expect(await fake.restRequests().isEmpty)
    }
}
