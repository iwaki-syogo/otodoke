import Foundation
import Testing
@testable import Otodoke

/// Why unread mail waits: the Web's readUnreadReasons and the app's UnreadReasonsRule run the same table of cases
/// (Fixtures/unread-reasons.json; src/lib/__tests__/unread-reasons-table.test.ts is the other half). The app's reads are
/// made against FakeSupabase, which answers the two reads from the table the way the database does.
struct UnreadReasonsCase: Decodable {
    struct Expected: Decodable, Equatable {
        let stopped: Int
        let overLimit: Int
        let failed: Int
    }

    let name: String
    let emails: [JSONValue]
    let expected: Expected

    struct File: Decodable {
        let now: String
        let cases: [UnreadReasonsCase]
    }

    static func load() throws -> [UnreadReasonsCase] { try loadFile().cases }

    static func loadFile() throws -> File {
        let bundle = Bundle(for: FixtureBundleToken.self)
        let url = bundle.url(forResource: "unread-reasons", withExtension: "json", subdirectory: "Fixtures")
            ?? bundle.url(forResource: "unread-reasons", withExtension: "json")
            ?? URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/unread-reasons.json")
        return try JSONDecoder().decode(File.self, from: Data(contentsOf: url))
    }

    /// The table as rows of the user.
    var rows: [Row] {
        emails.compactMap { value -> Row? in
            guard case var .object(row) = value else { return nil }
            row["user_id"] = .string(FakeSupabase.me)
            return row
        }
    }
}

@Suite("Unread reasons: stopped, over the limit, failed")
@MainActor
struct UnreadReasonsTests {
    private let now = ISO.date("2026-11-04T03:00:00Z")!

    private func reasons(_ rows: [Row]) async throws -> LoadResult<UnreadReasons> {
        let fake = FakeSupabase.make()
        await fake.insert("emails", rows)
        let (provider, _) = try await TestSession.signedIn(fake)
        return await SettingsReader(provider: provider).unreadReasons(now: now)
    }

    @Test func theTableTheWebAlsoRunsGivesTheSameAnswers() async throws {
        // The clock is the table's own (the Web's test sets the same one): the 3-minute rule of a pending mail depends on it.
        #expect(try UnreadReasonsCase.loadFile().now == "2026-11-04T03:00:00Z")
        let cases = try UnreadReasonsCase.load()
        #expect(cases.contains { $0.name.contains("pending") })
        #expect(cases.count >= 15)
        for c in cases {
            let got = try await reasons(c.rows)
            #expect(got == .loaded(UnreadReasons(stopped: c.expected.stopped, overLimit: c.expected.overLimit, failed: c.expected.failed)), "\(c.name)")
        }
    }

    @Test func negativeControlTheRuleSeesAnAnswerAfterTheStop() throws {
        // The stop that a later real mail cancels is not a stop; a rule that ignored the mail would say 1.
        let c = try #require(UnreadReasonsCase.load().first { $0.name.hasPrefix("a mail read after the stop") })
        #expect(c.expected.stopped == 0)
        let rows = c.emails.compactMap { value -> UnreadReasonRow? in
            guard case let .object(r) = value, let status = r["processing_status"]?.string, status != "processed" else { return nil }
            return UnreadReasonRow(id: r["id"]?.string ?? "", processingStatus: status, error: r["error"]?.string, createdAt: r["created_at"]?.string ?? "")
        }
        #expect(UnreadReasonsRule.count(rows: rows, lastProcessedAt: nil).stopped == 1)
        #expect(UnreadReasonsRule.count(rows: rows, lastProcessedAt: "2026-11-02T11:00:00+00:00").stopped == 0)
    }

    @Test func theQueriesAreTheWebsAndAnotherUsersMailIsNotCounted() async throws {
        let fake = FakeSupabase.make()
        let mine = SettingsRows.mail(1, ["processing_status": "failed", "error": "claude_unavailable", "created_at": "2026-11-02T10:00:00+00:00"])
        let others = SettingsRows.mail(2, ["user_id": .string(FakeSupabase.other), "processing_status": "processed", "created_at": "2026-11-02T11:00:00+00:00"])
        await fake.insert("emails", [mine, others])
        let (provider, _) = try await TestSession.signedIn(fake)
        let got = await SettingsReader(provider: provider).unreadReasons(now: now)
        #expect(got == .loaded(UnreadReasons(stopped: 1, overLimit: 0, failed: 0)))
        let reads = await fake.requests("GET", "emails")
        #expect(reads.count == 2)
        let last = try #require(reads.last)
        #expect(last.query("or") == ["(\(SettingsReader.notSampleNorConfirmation))"])
        let web = "and(provider_email_id.is.null,classification.is.null),and(provider_email_id.is.null,classification.neq.forwarding_confirmation),"
            + "and(provider_email_id.not.like.demo:%,classification.is.null),and(provider_email_id.not.like.demo:%,classification.neq.forwarding_confirmation)"
        #expect(SettingsReader.notSampleNorConfirmation == web)
        let first = try #require(reads.first)
        #expect(first.query("or") == ["(\(StatusRules.unreadFilter(now: now)))"])
    }

    @Test func aFailedReadIsFailedNotZero() async throws {
        for failing in [1, 2] {
            let fake = FakeSupabase.make()
            await fake.insert("emails", [SettingsRows.mail(1, ["processing_status": "failed", "error": "claude_error"])])
            let (provider, _) = try await TestSession.signedIn(fake)
            await fake.fail("GET", "emails", nth: failing, with: .http(500))
            let got = await SettingsReader(provider: provider).unreadReasons(now: now)
            #expect(got == .failed, "read \(failing)")
        }
    }

    // MARK: the settings model

    private func model(unread: Int, rows: [Row], failReasons: Bool = false) async throws -> SettingsModel {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", rows)
        await fake.setUnreadEmails(unread)
        let (provider, auth) = try await TestSession.signedIn(fake)
        if failReasons {
            // The rows of the unread mail (the select names processing_status), not the confirmations or the counts.
            await fake.fail(where: { $0.method == "GET" && ($0.query("select").first ?? "").contains("processing_status") }, with: .http(500))
        }
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
        await model.load()
        return model
    }

    @Test func theReasonsAreReadOnlyWhenSomeMailWaitsAndAreKeptWithTheCount() async throws {
        let stopped = SettingsRows.mail(1, ["processing_status": "failed", "error": "claude_unavailable", "created_at": "2026-11-02T10:00:00+00:00"])
        let waiting = try await model(unread: 1, rows: [stopped])
        #expect(waiting.unread == .loaded(1))
        #expect(waiting.unreadReasons == .loaded(UnreadReasons(stopped: 1, overLimit: 0, failed: 0)))
        // Negative control: nothing waiting reads no reasons.
        let none = try await model(unread: 0, rows: [stopped])
        #expect(none.unreadReasons == nil)
    }

    @Test func reasonsThatCouldNotBeReadStateNoReason() async throws {
        let stopped = SettingsRows.mail(1, ["processing_status": "failed", "error": "claude_unavailable", "created_at": "2026-11-02T10:00:00+00:00"])
        let failed = try await model(unread: 1, rows: [stopped], failReasons: true)
        #expect(failed.unreadReasons == .failed)
    }

    @Test func aReadThatFailsAfterAStoppedOneDoesNotKeepTheOldReason() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", [SettingsRows.mail(1, ["processing_status": "failed", "error": "claude_unavailable", "created_at": "2026-11-02T10:00:00+00:00"])])
        await fake.setUnreadEmails(1)
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
        await model.load()
        #expect(model.unreadReasons == .loaded(UnreadReasons(stopped: 1, overLimit: 0, failed: 0)))
        // The second read of the unread rows (the first was the load above) fails: the count is still read (1 waiting), the reason is not stated.
        await fake.fail(where: { $0.method == "GET" && ($0.query("select").first ?? "").contains("processing_status") }, nth: 2, with: .http(500))
        await model.load()
        #expect(model.unread == .loaded(1))
        #expect(model.unreadReasons == .failed)
        // And when it can be read again, the reason is back.
        await model.load()
        #expect(model.unreadReasons == .loaded(UnreadReasons(stopped: 1, overLimit: 0, failed: 0)))
    }
}
