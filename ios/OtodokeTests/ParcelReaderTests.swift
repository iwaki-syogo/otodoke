import Foundation
import Testing
@testable import Otodoke

/// [Task 6] ParcelReader against FakeSupabase: every row past 1,000, keyset pages (`id > last id`), no
/// stop at the first count, a failed page fails the whole read, counts that fail on their own, and
/// the three detail reads.
@Suite("ParcelReader (task 6)")
@MainActor
struct ParcelReaderTests {
    private func reader(_ fake: FakeSupabase) async throws -> ParcelReader {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelReader(provider: provider)
    }

    private func shuffledParcels(_ range: ClosedRange<Int>, seed: UInt64 = 7) -> [Row] {
        var rng = SplitMix64(seed: seed)
        return range.map { Rows.parcel($0) }.shuffled(using: &rng)
    }

    private func parcelGets(_ fake: FakeSupabase) async -> [StubRequest] {
        await fake.requests("GET", "parcels")
    }

    // MARK: all parcels

    @Test func readsPastAThousandInIdOrder() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", shuffledParcels(1...1500))
        let result = try await reader(fake).allParcels()
        let rows = try #require(result.value)
        #expect(rows.count == 1500)
        #expect(rows.map(\.id) == (1...1500).map(Rows.id))
        #expect(await parcelGets(fake).count >= 2)
    }

    @Test func pagesByIdAfterTheLastOneNotByOffset() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", shuffledParcels(1...1500))
        _ = try await reader(fake).allParcels()
        let gets = await parcelGets(fake)
        try #require(gets.count == 2)
        for get in gets {
            #expect(get.query("user_id") == ["eq.\(FakeSupabase.me)"])
            #expect(get.query("order").first?.hasPrefix("id.asc") == true || get.query("order").first == "id")
            #expect(get.query("offset").isEmpty)
            if let range = get.header("range") { #expect(range.hasPrefix("0-")) }
        }
        #expect(gets[0].query("id").isEmpty)
        #expect(gets[1].query("id") == ["gt.\(Rows.id(1000))"])
    }

    @Test func exactlyTwoThousandNeedsOneMoreEmptyPage() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", shuffledParcels(1...2000))
        let rows = try #require(try await reader(fake).allParcels().value)
        #expect(rows.count == 2000)
        #expect(await parcelGets(fake).count == 3)
    }

    @Test func fewerThanAPageIsOneRequest() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", shuffledParcels(1...999))
        let rows = try #require(try await reader(fake).allParcels().value)
        #expect(rows.count == 999)
        #expect(await parcelGets(fake).count == 1)
    }

    @Test func noParcelsIsAnEmptyListNotAFailure() async throws {
        let fake = FakeSupabase.make()
        #expect(try await reader(fake).allParcels() == .loaded([]))
    }

    @Test func onlyTheSignedInUsersParcels() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1), Rows.parcel(2, ["user_id": .string(FakeSupabase.other)]), Rows.parcel(3)])
        let rows = try #require(try await reader(fake).allParcels().value)
        #expect(rows.map(\.id) == [Rows.id(1), Rows.id(3)])
    }

    @Test func rowsAddedBetweenPagesNeitherRepeatNorStopTheRead() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", shuffledParcels(2...1501))
        // After the first page (and its count of 1,500) was answered: one row before the cursor, one after.
        await fake.before("GET", "parcels", nth: 2) { tables in
            tables["parcels", default: []].append(Rows.parcel(1))
            tables["parcels", default: []].append(Rows.parcel(9999))
        }
        let rows = try #require(try await reader(fake).allParcels().value)
        let ids = rows.map(\.id)
        #expect(Set(ids).count == ids.count, "no row twice")
        for n in 2...1501 { #expect(ids.contains(Rows.id(n))) }
        #expect(ids.contains(Rows.id(9999)), "a row added after the first count is still read")
        #expect(ids == ids.sorted())
    }

    @Test func aFailedSecondPageFailsTheWholeRead() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", shuffledParcels(1...1500))
        await fake.fail("GET", "parcels", nth: 2, with: .http(500))
        #expect(try await reader(fake).allParcels() == .failed)
    }

    @Test func noAnswerOnTheSecondPageFailsTheWholeRead() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", shuffledParcels(1...1500))
        await fake.fail("GET", "parcels", nth: 2, with: .transport(.notConnectedToInternet))
        #expect(try await reader(fake).allParcels() == .failed)
    }

    @Test func aFailedFirstPageFails() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", shuffledParcels(1...10))
        await fake.fail("GET", "parcels", nth: 1, with: .http(503))
        #expect(try await reader(fake).allParcels() == .failed)
    }

    @Test func signedOutReadsNothing() async {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let provider = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage())
        #expect(await ParcelReader(provider: provider).allParcels() == .failed)
        #expect(await fake.restRequests().isEmpty)
    }

    @Test func sendsTheAnonKeyAndTheUsersToken() async throws {
        let fake = FakeSupabase.make()
        _ = try await reader(fake).allParcels()
        let get = try #require(await parcelGets(fake).first)
        #expect(get.header("apikey") == FakeSupabase.anonKey)
        let bearer = try #require(get.header("authorization"))
        #expect(bearer.hasPrefix("Bearer "))
        #expect(!bearer.contains(FakeSupabase.anonKey))
    }

    // MARK: counts

    private let now = ISO.date("2026-11-04T03:00:00.250Z")!

    @Test func countsDeliveredCancelledAndUnread() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [
            Rows.parcel(1, ["status": "delivered"]), Rows.parcel(2, ["status": "delivered"]), Rows.parcel(3, ["status": "delivered"]),
            Rows.parcel(4, ["status": "cancelled"]),
            Rows.parcel(5, ["status": "delivered", "user_id": .string(FakeSupabase.other)]),
            Rows.parcel(6, ["status": "shipped"]),
        ])
        await fake.setUnreadEmails(2)
        let counts = try await reader(fake).counts(now: now)
        #expect(counts == ParcelCounts(delivered: .loaded(3), cancelled: .loaded(1), unread: .loaded(2)))
        let emails = try #require(await fake.requests().first { $0.path == "/rest/v1/emails" })
        #expect(emails.query("or") == ["(\(StatusRules.unreadFilter(now: now)))"])
        #expect((emails.header("prefer") ?? "").contains("count=exact"))
        let parcelCounts = await fake.restRequests().filter { $0.path == "/rest/v1/parcels" }
        #expect(parcelCounts.count == 2)
        for r in parcelCounts {
            #expect(r.query("user_id") == ["eq.\(FakeSupabase.me)"])
            #expect((r.header("prefer") ?? "").contains("count=exact"))
        }
    }

    @Test func zeroIsZeroAndAFailureIsAFailure() async throws {
        let fake = FakeSupabase.make()
        let reader = try await reader(fake)
        await fake.fail("HEAD", "parcels", nth: 1, with: .http(500))
        await fake.fail("GET", "parcels", nth: 1, with: .http(500))
        let counts = await reader.counts(now: now)
        // Exactly one of the two parcel counts failed (the first one sent); the other and unread are real zeros.
        let values = [counts.delivered, counts.cancelled]
        #expect(values.filter { $0 == .failed }.count == 1)
        #expect(values.filter { $0 == .loaded(0) }.count == 1)
        #expect(counts.unread == .loaded(0))
    }

    @Test func unreadFailsOnItsOwn() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "delivered"])])
        let reader = try await reader(fake)
        await fake.fail("HEAD", "emails", with: .transport(.notConnectedToInternet))
        await fake.fail("GET", "emails", with: .transport(.notConnectedToInternet))
        let counts = await reader.counts(now: now)
        #expect(counts.unread == .failed)
        #expect(counts.delivered == .loaded(1))
        #expect(counts.cancelled == .loaded(0))
    }

    // MARK: detail

    @Test func oneParcel() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1), Rows.parcel(2)])
        let reader = try await reader(fake)
        let found = await reader.parcel(id: Rows.id(2))
        guard case let .loaded(row) = found else {
            Issue.record("parcel(id:) failed")
            return
        }
        #expect(row?.id == Rows.id(2))
        #expect(await reader.parcel(id: Rows.id(3)) == .loaded(nil))
        await fake.fail("GET", "parcels", nth: 3, with: .http(500))
        #expect(await reader.parcel(id: Rows.id(1)) == .failed)
    }

    @Test func itemsInCreatedOrder() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcel_items", [
            Rows.item(1, parcel: 1, ["created_at": "2026-11-02T00:00:00+00:00"]),
            Rows.item(2, parcel: 1, ["created_at": "2026-11-01T00:00:00+00:00"]),
            Rows.item(3, parcel: 2),
        ])
        let reader = try await reader(fake)
        let items = try #require(await reader.items(parcelID: Rows.id(1)).value)
        #expect(items.map(\.name) == ["品目2", "品目1"])
        #expect(await reader.items(parcelID: Rows.id(5)) == .loaded([]))
        await fake.fail("GET", "parcel_items", nth: 3, with: .http(500))
        #expect(await reader.items(parcelID: Rows.id(1)) == .failed)
    }

    @Test func extractionsWithTheirMails() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("extractions", [Rows.extraction(1, parcel: 1, email: Rows.email(1)), Rows.extraction(2, parcel: 2, email: Rows.email(2))])
        let reader = try await reader(fake)
        let xs = try #require(await reader.extractions(parcelID: Rows.id(1)).value)
        #expect(xs.map(\.id) == [Rows.id(20_001)])
        #expect(xs.first?.email?.subject == "件名1")
        let get = try #require(await fake.requests("GET", "extractions").first)
        #expect(get.query("parcel_id") == ["eq.\(Rows.id(1))"])
        let select = get.query("select").first?.replacingOccurrences(of: " ", with: "") ?? ""
        #expect(select.contains("emails("))
        for column in ["id", "subject", "from_address", "from_name", "sent_at", "classification", "text_body", "html_body"] {
            #expect(select.contains(column), "\(column)")
        }
        for column in ["confidence", "result", "created_at"] { #expect(select.contains(column), "\(column)") }
        await fake.fail("GET", "extractions", nth: 2, with: .http(500))
        #expect(await reader.extractions(parcelID: Rows.id(1)) == .failed)
    }
}
