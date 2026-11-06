import Foundation
import Testing
@testable import Otodoke

/// [Task 7] The forwarding address: made on first use with the Web's rules (src/lib/inbox.ts).
@Suite("InboxAddressService (task 7)")
@MainActor
struct InboxAddressTests {
    private func service(_ fake: FakeSupabase, bytes: @escaping @Sendable (Int) -> [UInt8] = InboxAddressService.secureRandomBytes) async throws -> InboxAddressService {
        let (provider, _) = try await TestSession.signedIn(fake)
        return InboxAddressService(provider: provider, randomBytes: bytes)
    }

    /// Hands out the given byte runs in turn (the last one again when they run out).
    private final class Script: @unchecked Sendable {
        private let lock = NSLock()
        private var runs: [[UInt8]]
        init(_ runs: [[UInt8]]) { self.runs = runs }
        func next(_ n: Int) -> [UInt8] {
            lock.withLock {
                let run = runs.count > 1 ? runs.removeFirst() : runs[0]
                return Array(run.prefix(n))
            }
        }
    }

    private func address(_ row: Row) -> Row {
        var r = row
        r["id"] = r["id"] ?? .string(UUID().uuidString.lowercased())
        r["created_at"] = r["created_at"] ?? "2026-11-01T00:00:00+00:00"
        return r
    }

    @Test func theAlphabetLeavesOutLookAlikes() {
        let alphabet = String(InboxAddressService.alphabet)
        #expect(alphabet == "abcdefghjkmnpqrstuvwxyz23456789")
        for c in "0o1li" { #expect(!alphabet.contains(c)) }
        #expect(InboxAddressService.length == 10)
    }

    @Test func mapsBytesLikeTheWeb() {
        #expect(InboxAddressService.localPart(from: [0, 1, 30, 31, 255, 62, 100, 200, 8, 9]) == "ab9ahahrjk")
    }

    @Test func secureBytesHaveTheLengthAsked() {
        #expect(InboxAddressService.secureRandomBytes(10).count == 10)
        #expect(InboxAddressService.secureRandomBytes(32) != InboxAddressService.secureRandomBytes(32))
    }

    @Test func returnsTheExistingAddressWithoutMakingOne() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("inbox_addresses", [address(["user_id": .string(FakeSupabase.me), "local_part": "kmnpqrstuv"])])
        let local = try await service(fake).ensure()
        #expect(local == "kmnpqrstuv")
        #expect(await fake.count("POST", "inbox_addresses") == 0)
        let read = try #require(await fake.requests("GET", "inbox_addresses").first)
        #expect(read.query("user_id") == ["eq.\(FakeSupabase.me)"])
    }

    @Test func makesOneForSomeoneWithoutARow() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("inbox_addresses", [address(["user_id": .string(FakeSupabase.other), "local_part": "zzzzzzzzzz"])])
        let local = try await service(fake).ensure()
        #expect(local.count == 10)
        #expect(local.allSatisfy { InboxAddressService.alphabet.contains($0) })
        let post = try #require(await fake.requests("POST", "inbox_addresses").first)
        #expect(post.jsonDictionary?["user_id"] as? String == FakeSupabase.me)
        #expect(post.jsonDictionary?["local_part"] as? String == local)
        let mine = await fake.rows("inbox_addresses").filter { $0["user_id"] == .string(FakeSupabase.me) }
        #expect(mine.map { $0["local_part"] } == [.string(local)])
    }

    @Test func aRaceForTheSameUserReadsTheWinner() async throws {
        let fake = FakeSupabase.make()
        await fake.before("POST", "inbox_addresses") { tables in
            tables["inbox_addresses", default: []].append([
                "id": "00000000-0000-4000-8000-00000000ffff", "user_id": .string(FakeSupabase.me),
                "local_part": "wxyz234567", "created_at": "2026-11-01T00:00:00+00:00",
            ])
        }
        let local = try await service(fake).ensure()
        #expect(local == "wxyz234567")
        #expect(await fake.count("POST", "inbox_addresses") == 1)
    }

    @Test func aTakenLocalPartIsTriedAgain() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("inbox_addresses", [address(["user_id": .string(FakeSupabase.other), "local_part": "aaaaaaaaaa"])])
        let script = Script([[UInt8](repeating: 0, count: 10), [UInt8](repeating: 1, count: 10)])
        let local = try await service(fake, bytes: { script.next($0) }).ensure()
        #expect(local == "bbbbbbbbbb")
        #expect(await fake.count("POST", "inbox_addresses") == 2)
    }

    @Test func givesUpAfterThreeTakenTries() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("inbox_addresses", [address(["user_id": .string(FakeSupabase.other), "local_part": "aaaaaaaaaa"])])
        let svc = try await service(fake, bytes: { [UInt8](repeating: 0, count: $0) })
        await #expect(throws: InboxAddressError.couldNotAllocate) { try await svc.ensure() }
        #expect(await fake.count("POST", "inbox_addresses") == 3)
    }

    @Test func aFailedInsertIsAnError() async throws {
        let fake = FakeSupabase.make()
        let svc = try await service(fake)
        await fake.fail("POST", "inbox_addresses", with: .http(500))
        await #expect(throws: InboxAddressError.insertFailed) { try await svc.ensure() }
    }

    @Test func aFailedReadIsAnErrorAndMakesNothing() async throws {
        let fake = FakeSupabase.make()
        let svc = try await service(fake)
        await fake.fail("GET", "inbox_addresses", with: .transport(.notConnectedToInternet))
        await #expect(throws: InboxAddressError.readFailed) { try await svc.ensure() }
        #expect(await fake.count("POST", "inbox_addresses") == 0)
    }

    @Test func theFullAddress() {
        #expect(InboxAddressService.email(localPart: "abcdefghjk", domain: "in.example.test") == "abcdefghjk@in.example.test")
        #expect(InboxAddressService.email(localPart: "abcdefghjk", domain: "") == nil)
    }
}
