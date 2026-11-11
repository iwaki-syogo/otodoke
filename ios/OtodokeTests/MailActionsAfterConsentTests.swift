import Foundation
import Testing
@testable import Otodoke

@Suite("Mail API: automatic reading after consent")
@MainActor
struct MailActionsAfterConsentTests {
    @Test(arguments: [
        "2026-11-12T03:00:00.123456+00:00",
        "2026-11-12T12:00:00.000001+09:00",
        "2026-11-11T22:30:00.999999-04:30",
    ])
    func anAutomaticReadSendsOnlyTheRawReceiptAndAManualRetryStillSendsAnEmptyObject(decidedAt: String) async throws {
        let fake = FakeSupabase.make()
        let (provider, auth) = try await TestSession.signedIn(fake)
        let token = try await provider.auth.session.accessToken
        let stamp = try #require(auth.session.stamp())
        let server = FakeMailServer.make(supabase: fake)
        await server.force("read-waiting", .answer(status: 200, ok: true, code: nil, extra: ["stopped": false, "over_limit": false]))
        let client = MailActionsClient(baseURL: server.baseURL, session: server.urlSession)
        let receipt = AIReadingConsentSaveReceipt(decision: .allowed, decidedAt: decidedAt, stamp: stamp)
        #expect(try await client.readWaiting(afterConsent: receipt, accessToken: token) == ReadWaitingResult())
        _ = try await client.readWaiting(accessToken: token)
        let requests = await server.requests("read-waiting")
        #expect(requests.count == 2)
        let automatic = try #require(requests.first)
        let manual = try #require(requests.last)
        #expect(automatic.jsonDictionary as? [String: String] == ["after_consent": decidedAt])
        #expect(manual.jsonDictionary?.isEmpty == true)
        for request in requests {
            #expect(request.method == "POST")
            #expect(request.path == "/api/mail/read-waiting")
            #expect(request.header("authorization") == "Bearer \(token)")
            #expect(request.timeoutInterval == MailActionsClient.readTimeout)
        }
    }

    @Test(arguments: ["denied", "notDetermined", "empty", "invalid", "infinity"])
    func anAutomaticReadNeedsAnAllowedReceiptWithAValidServerTimeBeforeSending(kind: String) async {
        let fake = FakeSupabase.make()
        let server = FakeMailServer.make(supabase: fake)
        let client = MailActionsClient(baseURL: server.baseURL, session: server.urlSession)
        let stamp = SessionStamp(userID: FakeSupabase.me, generation: 1)
        let decision: AIReadingDecision = kind == "denied" ? .denied : (kind == "notDetermined" ? .notDetermined : .allowed)
        let time = kind == "empty" ? "" : (kind == "invalid" ? "not a date" : (kind == "infinity" ? "-infinity" : "2026-11-12T03:00:00Z"))
        let receipt = AIReadingConsentSaveReceipt(decision: decision, decidedAt: time, stamp: stamp)
        await #expect(throws: MailAPIFailure.invalidInput) {
            try await client.readWaiting(afterConsent: receipt, accessToken: "test-token")
        }
        #expect(await server.count("read-waiting") == 0)
    }

    @Test(arguments: ["timedOut", "connectionLost", "offline", "unavailable", "consentRequired", "readFailed"])
    func anAutomaticReadNeverRetriesAfterAnUnknownOrFailedResult(kind: String) async {
        let fake = FakeSupabase.make()
        let server = FakeMailServer.make(supabase: fake)
        let expected: MailAPIFailure
        switch kind {
        case "timedOut":
            await server.force("read-waiting", .transport(.timedOut))
            expected = .unknownResult
        case "connectionLost":
            await server.force("read-waiting", .transport(.networkConnectionLost))
            expected = .unknownResult
        case "offline":
            await server.force("read-waiting", .transport(.notConnectedToInternet))
            expected = .network
        case "unavailable":
            await server.force("read-waiting", .answer(status: 503, ok: false, code: "unavailable"))
            expected = .unavailable
        case "consentRequired":
            await server.force("read-waiting", .answer(status: 403, ok: false, code: "ai_consent_required"))
            expected = .aiConsentRequired
        default:
            await server.force("read-waiting", .answer(status: 500, ok: false, code: "read_failed"))
            expected = .readFailed
        }
        let client = MailActionsClient(baseURL: server.baseURL, session: server.urlSession)
        let receipt = AIReadingConsentSaveReceipt(decision: .allowed, decidedAt: "2026-11-12T03:00:00.123456+00:00", stamp: SessionStamp(userID: FakeSupabase.me, generation: 1))
        await #expect(throws: expected) {
            try await client.readWaiting(afterConsent: receipt, accessToken: "test-token")
        }
        #expect(await server.count("read-waiting") == 1)
    }

    @Test(arguments: [(true, false), (false, true), (false, false)])
    func anAutomaticReadKeepsTheExistingStoppedAndLimitResponseMeaning(stopped: Bool, overLimit: Bool) async throws {
        let fake = FakeSupabase.make()
        let server = FakeMailServer.make(supabase: fake)
        await server.force("read-waiting", .answer(status: 200, ok: true, code: nil, extra: ["stopped": stopped, "over_limit": overLimit]))
        let client = MailActionsClient(baseURL: server.baseURL, session: server.urlSession)
        let receipt = AIReadingConsentSaveReceipt(decision: .allowed, decidedAt: "2026-11-12T03:00:00.123456+00:00", stamp: SessionStamp(userID: FakeSupabase.me, generation: 1))
        #expect(try await client.readWaiting(afterConsent: receipt, accessToken: "test-token") == ReadWaitingResult(stopped: stopped, overLimit: overLimit))
        #expect(await server.count("read-waiting") == 1)
    }
}
