import Auth
import Foundation
import Testing
@testable import Otodoke

private actor TokenSessionProbe {
    let value: Session
    let started: Gate
    let release: Gate
    private(set) var reads = 0
    init(_ value: Session, started: Gate = Gate.opened(), release: Gate = Gate.opened()) {
        self.value = value; self.started = started; self.release = release
    }
    func read() async -> Session { reads += 1; started.open(); await release.wait(); return value }
}

@MainActor
private struct TokenReaderWorld {
    let fake: FakeSupabase
    let auth: AuthService
    init() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        let auth = PW.auth(fake)
        // The listener stays off so one test can hold the SDK-new/AuthService-old owner boundary.
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        self.fake = fake; self.auth = auth
    }
}

@Suite("Session access token reader")
@MainActor
struct SessionAccessTokenReaderTests {
    @Test(arguments: ["missing", "stale"])
    func aMissingOrEndedStampNeverReadsTheSDK(_ boundary: String) async throws {
        let w = try await TokenReaderWorld()
        let stamp = try #require(w.auth.session.stamp())
        let probe = TokenSessionProbe(try #require(w.auth.provider.auth.currentSession))
        let reader = SessionAccessTokenReader(session: { await probe.read() }, isCurrent: { w.auth.session.isCurrent($0) })
        if boundary == "stale" { w.auth.session.advance() }

        #expect(await reader.read(for: boundary == "missing" ? nil : stamp) == nil)
        #expect(await probe.reads == 0)
    }

    @Test(arguments: ["different-owner", "same-owner-new-generation"])
    func anEndedGenerationDuringTheSDKAwaitRejectsEvenAnOldOwnersValidSession(_ transition: String) async throws {
        let w = try await TokenReaderWorld(), started = Gate(), release = Gate()
        defer { release.open() }
        let stamp = try #require(w.auth.session.stamp())
        let probe = TokenSessionProbe(try #require(w.auth.provider.auth.currentSession), started: started, release: release)
        let reader = SessionAccessTokenReader(session: { await probe.read() }, isCurrent: { w.auth.session.isCurrent($0) })
        let run = Task { await reader.read(for: stamp) }
        await started.wait()
        if transition == "different-owner" { w.auth.session.follow(userID: FakeSupabase.other) }
        else { w.auth.session.advance() }
        release.open()

        #expect(await run.value == nil)
        #expect(await probe.reads == 1)
    }

    @Test func anSDKOwnerMismatchIsRejectedEvenBeforeItsEventChangesTheLocalStamp() async throws {
        let w = try await TokenReaderWorld()
        let stamp = try #require(w.auth.session.stamp())
        let email = "other@example.com"
        await w.fake.addPasswordAccount(email: email, secret: PW.secret(email: email, password: PW.good), userID: FakeSupabase.other)
        await w.fake.setUserEmail(email)
        _ = try await w.auth.provider.auth.signIn(email: email, password: PW.secret(email: email, password: PW.good))
        try #require(w.auth.session.isCurrent(stamp))
        let current = try #require(w.auth.provider.auth.currentSession)
        try #require(current.user.id.uuidString.lowercased() == FakeSupabase.other)
        let reader = SessionAccessTokenReader(provider: w.auth.provider, isCurrent: { w.auth.session.isCurrent($0) })

        #expect(await reader.read(for: stamp) == nil)
        #expect(w.auth.provider.auth.currentSession?.accessToken == current.accessToken)
    }

    @Test(arguments: [false, true])
    func theCurrentOwnerIncludingARefreshedSessionReturnsItsActualToken(_ refresh: Bool) async throws {
        let w = try await TokenReaderWorld()
        let stamp = try #require(w.auth.session.stamp())
        let first = try #require(w.auth.provider.auth.currentSession)
        if refresh { _ = try await w.auth.provider.auth.refreshSession() }
        let current = try #require(w.auth.provider.auth.currentSession)
        let reader = SessionAccessTokenReader(provider: w.auth.provider, isCurrent: { w.auth.session.isCurrent($0) })

        #expect(await reader.read(for: stamp) == current.accessToken)
        if refresh { #expect(current.accessToken != first.accessToken) }
        #expect(w.auth.session.isCurrent(stamp))
        #expect(await w.fake.userID(forAccessToken: current.accessToken) == stamp.userID)
    }
}
