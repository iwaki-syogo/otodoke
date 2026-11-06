import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 6] The data foundation of M1: iOS-10 (no disk cache for Supabase's answers), the one
/// fence type for reads (the meaning of ParcelListModel.finishRead), and 「古くなった」 across tabs, which
/// only ParcelWriter publishes (CX1, 11/6 13:20): on a success or an unknown result, once per bulk call.
@Suite("ReadFence (batch 2, task 6)")
struct ReadFenceTests {
    @Test func theNewestReadIsCurrent() {
        var fence = ReadFence()
        let t = fence.beginRead()
        #expect(fence.verdict(t) == .current)
    }

    @Test func aNewerReadSupersedesAnOlderOne() {
        var fence = ReadFence()
        let old = fence.beginRead()
        let new = fence.beginRead()
        #expect(fence.verdict(old) == .superseded)
        #expect(fence.verdict(new) == .current)
    }

    @Test func aWriteInFlightMakesTheReadStale() {
        var fence = ReadFence()
        let t = fence.beginRead()
        fence.beginWrite()
        #expect(fence.writesInFlight == 1)
        #expect(fence.verdict(t) == .stale)
    }

    @Test func aReadBegunDuringAWriteIsStale() {
        var fence = ReadFence()
        fence.beginWrite()
        let t = fence.beginRead()
        #expect(fence.verdict(t) == .stale)
        fence.endWrite()
        // The write ended after the read began: the read may show the row from before it.
        #expect(fence.verdict(t) == .stale)
    }

    @Test func aWriteThatCameAndWentMakesTheReadStale() {
        var fence = ReadFence()
        let t = fence.beginRead()
        fence.beginWrite()
        fence.endWrite()
        #expect(fence.writesInFlight == 0)
        #expect(fence.verdict(t) == .stale)
        let again = fence.beginRead()
        #expect(fence.verdict(again) == .current)
    }

    @Test func supersededIsToldBeforeStale() {
        var fence = ReadFence()
        let old = fence.beginRead()
        fence.beginWrite()
        _ = fence.beginRead()
        #expect(fence.verdict(old) == .superseded)
    }

    @Test func twoWritesAtOnce() {
        var fence = ReadFence()
        fence.beginWrite()
        fence.beginWrite()
        fence.endWrite()
        let t = fence.beginRead()
        #expect(fence.verdict(t) == .stale)
        fence.endWrite()
        let after = fence.beginRead()
        #expect(fence.verdict(after) == .current)
    }
}

@Suite("DataChanges (batch 2, task 6)")
@MainActor
struct DataChangesTests {
    @Test func publishMovesTheVersionOn() {
        let changes = DataChanges()
        #expect(changes.version == 0)
        changes.publish()
        changes.publish()
        #expect(changes.version == 2)
    }

    @Test func onlyAScreenThatReadBeforeThePublishIsStale() {
        let changes = DataChanges()
        let before = ChangeMark(changes)
        before.markRead()
        changes.publish()
        let after = ChangeMark(changes)
        after.markRead()
        #expect(before.isStale == true)
        #expect(after.isStale == false)
        before.markRead()
        #expect(before.isStale == false)
    }

    @Test func withoutDataChangesNothingIsStale() {
        let mark = ChangeMark(nil)
        mark.markRead()
        #expect(mark.isStale == false)
    }
}

/// CX1: the writer is the one publisher.
@Suite("ParcelWriter publishes 「古くなった」 (batch 2, task 6, CX1)")
@MainActor
struct WriterPublishesTests {
    private func setUp(_ rows: [Row]) async throws -> (FakeSupabase, ParcelWriter, DataChanges) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", rows)
        let (provider, _) = try await TestSession.signedIn(fake)
        let changes = DataChanges()
        return (fake, ParcelWriter(provider: provider, changes: changes), changes)
    }

    private func version(_ fake: FakeSupabase, _ n: Int) async throws -> ParcelVersion {
        ParcelVersion(try Rows.parcelRow(try #require(await fake.row("parcels", id: Rows.id(n)))))
    }

    @Test func aSuccessPublishesOnce() async throws {
        let (fake, writer, changes) = try await setUp([Rows.parcel(1)])
        let shown = try await version(fake, 1)
        let result = await writer.setCategory(shown, category: .food)
        guard case .success = result else {
            Issue.record("expected success, got \(result)")
            return
        }
        #expect(changes.version == 1)
    }

    @Test func anUnknownResultPublishesToo() async throws {
        let (fake, writer, changes) = try await setUp([Rows.parcel(1)])
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.timedOut))
        let shown = try await version(fake, 1)
        #expect(await writer.markDelivered(shown) == .unknown)
        #expect(changes.version == 1)
    }

    @Test func aConflictPublishesNothing() async throws {
        let (fake, writer, changes) = try await setUp([Rows.parcel(1)])
        let shown = try await version(fake, 1)
        await fake.touch("parcels", id: Rows.id(1), ["title": "変わった"])
        #expect(await writer.setCategory(shown, category: .food) == .notUpdated(.conflict))
        #expect(changes.version == 0)
    }

    @Test func aSureFailurePublishesNothing() async throws {
        let (fake, writer, changes) = try await setUp([Rows.parcel(1)])
        await fake.fail("PATCH", "parcels", with: .http(500))
        let shown = try await version(fake, 1)
        #expect(await writer.markDelivered(shown) == .notUpdated(.failed))
        await fake.fail("PATCH", "parcels", nth: 2, with: .transport(.notConnectedToInternet))
        #expect(await writer.markDelivered(shown) == .notUpdated(.failed))
        #expect(changes.version == 0)
    }

    @Test func refusedInputPublishesNothing() async throws {
        let (_, writer, changes) = try await setUp([])
        #expect(await writer.markDelivered(ParcelVersion(id: "not-a-uuid", status: "shipped", updatedAt: "x")) == .notUpdated(.invalidInput))
        #expect(changes.version == 0)
    }

    @Test func aBulkCallPublishesOnce() async throws {
        let (fake, writer, changes) = try await setUp([Rows.parcel(1), Rows.parcel(2), Rows.parcel(3)])
        let shown = [try await version(fake, 1), try await version(fake, 2), try await version(fake, 3)]
        let results = await writer.markDelivered(all: shown)
        #expect(results.count == 3)
        #expect(changes.version == 1)

        let tokens = results.compactMap { r -> UndoToken? in
            if case let .success(t) = r.outcome { return t }
            return nil
        }
        #expect(tokens.count == 3)
        _ = await writer.undoDelivered(all: tokens)
        #expect(changes.version == 2)
    }

    @Test func aBulkCallWithNothingWrittenPublishesNothing() async throws {
        let (fake, writer, changes) = try await setUp([Rows.parcel(1), Rows.parcel(2)])
        let shown = [try await version(fake, 1), try await version(fake, 2)]
        await fake.touch("parcels", id: Rows.id(1), ["title": "a"])
        await fake.touch("parcels", id: Rows.id(2), ["title": "b"])
        _ = await writer.markDelivered(all: shown)
        #expect(changes.version == 0)
    }

    @Test func notDeliveredPublishesOnSuccess() async throws {
        let (_, writer, changes) = try await setUp([Rows.parcel(1, ["status": "delivered"])])
        let result = await writer.markNotDelivered(id: Rows.id(1))
        guard case .success = result else {
            Issue.record("expected success, got \(result)")
            return
        }
        #expect(changes.version == 1)
    }

    @Test func aWriterWithoutDataChangesStillWrites() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1)])
        let (provider, _) = try await TestSession.signedIn(fake)
        let writer = ParcelWriter(provider: provider)
        let shown = try await version(fake, 1)
        let result = await writer.setCategory(shown, category: .food)
        guard case .success = result else {
            Issue.record("expected success, got \(result)")
            return
        }
    }
}

/// iOS-10: mail bodies come back in Supabase's answers; none of them may stay in a disk cache.
@Suite("No disk cache for Supabase (batch 2, task 6, iOS-10)")
struct NoDiskCacheTests {
    /// Ephemeral (a memory-only cache) or no cache at all.
    static func keepsNothingOnDisk(_ configuration: URLSessionConfiguration) -> Bool {
        guard let cache = configuration.urlCache else { return true }
        return cache.diskCapacity == 0
    }

    @Test func theCheckBitesOnTheDefaultConfiguration() {
        // Negative control: URLSession.shared and the default configuration keep a disk cache.
        #expect(Self.keepsNothingOnDisk(URLSessionConfiguration.default) == false)
        #expect(Self.keepsNothingOnDisk(URLSession.shared.configuration) == false)
        // Positive control.
        #expect(Self.keepsNothingOnDisk(URLSessionConfiguration.ephemeral) == true)
    }

    @Test func theAppsSessionKeepsNothingOnDisk() {
        let session = SupabaseProvider.liveURLSession()
        #expect(session !== URLSession.shared)
        #expect(Self.keepsNothingOnDisk(session.configuration))
    }

    @Test func theTestSessionStillGoesThroughTheStub() async throws {
        let fake = FakeSupabase.make()
        _ = try await TestSession.signedIn(fake)
        #expect(await fake.count("POST", "verify") == 1)
    }
}
