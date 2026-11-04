import Foundation
import Security
import Testing
@testable import Otodoke

/// [Task 3, implementer's own] How the Supabase client is wired: implicit flow, one request per press
/// on the login calls, the user's JWT on PostgREST, and where the Keychain keeps the session.
@Suite("Auth wiring (task 3)")
@MainActor
struct AuthFlowTests {
    private func make(_ fake: FakeSupabase) -> AuthService {
        AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()))
    }

    @Test func sendsTheCodeInTheImplicitFlow() async throws {
        // PKCE would add a code challenge, and a login link opened in another browser would then fail.
        let fake = FakeSupabase.make()
        try await make(fake).sendCode(email: FakeSupabase.email)
        let body = try #require(await fake.requests("POST", "otp").first?.jsonDictionary)
        #expect(body["code_challenge"] == nil)
        #expect(body["code_challenge_method"] == nil)
    }

    @Test func noAnswerOnSendingIsNotSentAgain() async {
        let fake = FakeSupabase.make()
        await fake.fail("POST", "otp", with: .transport(.networkConnectionLost))
        await #expect(throws: LoginError.network) { try await make(fake).sendCode(email: FakeSupabase.email) }
        #expect(await fake.count("POST", "otp") == 1)
    }

    @Test func aServerErrorOnSendingIsNotSentAgain() async {
        let fake = FakeSupabase.make()
        await fake.fail("POST", "otp", with: .http(503))
        await #expect(throws: LoginError.other) { try await make(fake).sendCode(email: FakeSupabase.email) }
        #expect(await fake.count("POST", "otp") == 1)
    }

    @Test func noAnswerOnVerifyingIsNotSentAgain() async {
        let fake = FakeSupabase.make()
        await fake.fail("POST", "verify", with: .transport(.timedOut))
        await #expect(throws: LoginError.network) { try await make(fake).verifyCode(email: FakeSupabase.email, code: FakeSupabase.goodCode) }
        #expect(await fake.count("POST", "verify") == 1)
    }

    @Test func postgrestCarriesTheUsersToken() async throws {
        let fake = FakeSupabase.make()
        let (provider, _) = try await TestSession.signedIn(fake)
        // The fake answers 401 unless the bearer is a token it issued at sign-in.
        _ = try await provider.database.from("parcels").select().execute()
        let read = try #require(await fake.requests("GET", "parcels").first)
        #expect(read.header("apikey") == FakeSupabase.anonKey)
        #expect(read.header("authorization")?.hasPrefix("Bearer ") == true)
        #expect(read.header("authorization") != "Bearer \(FakeSupabase.anonKey)")
    }

    @Test func postgrestSendsNothingWhenSignedOut() async {
        let fake = FakeSupabase.make()
        let provider = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage())
        await #expect(throws: (any Error).self) { _ = try await provider.database.from("parcels").select().execute() }
        #expect(await fake.restRequests().isEmpty)
    }

    @Test func theSessionStaysOnThisDevice() throws {
        let storage = KeychainSessionStorage(service: "com.iwakisyogo.otodoke.tests.\(UUID().uuidString)")
        let key = "sb-test-auth-token"
        defer { try? storage.remove(key: key) }
        try storage.store(key: key, value: Data("session".utf8))
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: storage.service,
            kSecAttrAccount as String: key,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        #expect(SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess)
        let attributes = try #require(result as? [String: Any])
        #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
    }

    @Test func removingAMissingItemIsNotAnError() throws {
        let storage = KeychainSessionStorage(service: "com.iwakisyogo.otodoke.tests.\(UUID().uuidString)")
        try storage.remove(key: "nothing-here")
    }
}
