import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 16, CX2] The signed-in generation (Codex-001), sign-out's four steps in order, and the
/// opened key that lives in memory only while the app is in front.
@Suite("Session generation and the opened key (batch 2, task 16)")
@MainActor
struct SessionGenerationTests {
    static let me = FakeSupabase.me
    static let other = FakeSupabase.other

    // MARK: SessionGeneration

    @Test func movesOnWhenTheUserChangesOrSignsOut() {
        let s = SessionGeneration()
        #expect(s.stamp() == nil)
        s.update(userID: Self.me)
        let a = try? require_(s.stamp())
        #expect(a?.userID == Self.me)
        s.update(userID: Self.me)
        #expect(s.stamp() == a)
        #expect(a.map(s.isCurrent) == true)

        s.update(userID: Self.other)
        let b = s.stamp()
        #expect(b?.userID == Self.other)
        #expect(b?.generation != a?.generation)
        #expect(a.map(s.isCurrent) == false)

        s.advance()
        #expect(b.map(s.isCurrent) == false)
        s.update(userID: nil)
        #expect(s.stamp() == nil)
        // Back to the first user: a new generation, the old stamp stays stale.
        s.update(userID: Self.me)
        #expect(a.map(s.isCurrent) == false)
        #expect(s.stamp()?.userID == Self.me)
    }

    // MARK: AuthService

    @Test func signingInSetsTheSession() async throws {
        let fake = FakeSupabase.make()
        let (_, auth) = try await TestSession.signedIn(fake)
        #expect(auth.session.stamp()?.userID == Self.me)
    }

    @Test func signOutRunsTheFourStepsInOrder() async throws {
        let fake = FakeSupabase.make()
        let (_, auth) = try await TestSession.signedIn(fake)
        let before = try #require(auth.session.stamp())
        let steps = SignOutSteps(session: auth.session)
        auth.cleanup = steps
        await auth.signOut()
        // ① first: every step already sees the new generation.
        #expect(steps.steps == ["cancel", "drop", "keychain"])
        #expect(steps.generations.allSatisfy { $0 != before.generation })
        #expect(!auth.session.isCurrent(before))
        #expect(auth.session.stamp() == nil)
        #expect(auth.state == .signedOut)
    }

    @Test func signingInAgainIsAnotherGeneration() async throws {
        let fake = FakeSupabase.make()
        let (_, auth) = try await TestSession.signedIn(fake)
        let first = try #require(auth.session.stamp())
        await auth.signOut()
        // password-v1: signed in again with the password.
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        try await AuthService(provider: auth.provider, deriver: PW.fastDeriver()).signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        await auth.checkSession()
        let second = try #require(auth.session.stamp())
        #expect(second.userID == Self.me)
        #expect(second.generation != first.generation)
        #expect(!auth.session.isCurrent(first))
    }

    @Test func afterSignOutNoKeyItemIsLeft() async throws {
        let fake = FakeSupabase.make()
        let (_, auth) = try await TestSession.signedIn(fake)
        let w = try UnlockWorld(session: auth.session)
        auth.cleanup = w.store
        w.plantVaultKey()
        try w.putKeyInMemory()
        #expect(w.store.key != nil)
        await auth.signOut()
        #expect(w.vaultCount == 0)
        #expect(w.store.key == nil)
    }

    // MARK: OpenKeyStore

    @Test func aKeyIsPutOnlyForTheStampNow() throws {
        let w = try UnlockWorld()
        let stamp = try #require(w.store.stamp())
        let key = OpenedKey(userID: Self.me, recipient: try w.v.testRecipient())
        #expect(w.store.put(key, stamp: stamp))
        #expect(w.store.key == key)
        // Another user's key under this stamp is refused.
        let theirs = OpenedKey(userID: Self.other, recipient: try w.v.testRecipient())
        #expect(!w.store.put(theirs, stamp: stamp))
    }

    @Test func goingToTheBackgroundDropsTheKeyAndMovesThePeriod() throws {
        let w = try UnlockWorld()
        try w.putKeyInMemory()
        let stamp = try #require(w.store.stamp())
        let period = w.store.period
        w.store.wentToBackground()
        #expect(w.store.key == nil)
        #expect(w.store.period != period)
        #expect(!w.store.isCurrent(stamp))
        // A put with the stamp from before the background is refused.
        #expect(!w.store.put(OpenedKey(userID: Self.me, recipient: try w.v.testRecipient()), stamp: stamp))
        #expect(w.store.key == nil)
        // The device item is not touched by the background.
        w.plantVaultKey()
        w.store.wentToBackground()
        #expect(w.vaultCount == 1)
    }

    @Test func goingToTheBackgroundCancelsWorkAndDropsOpenedMail() async throws {
        let w = try UnlockWorld()
        let probe = PlaintextProbe()
        w.store.hold(probe)
        let started = Gate()
        let task = Task {
            started.open()
            try? await Task.sleep(for: .seconds(30))
        }
        w.store.track(task)
        await started.wait()
        w.store.wentToBackground()
        #expect(await waitFor { task.isCancelled })
        #expect(probe.drops == 1)
        task.cancel()
    }

    @Test func theKeyIsOnlyTheSessionsNow() throws {
        let w = try UnlockWorld()
        try w.putKeyInMemory()
        #expect(w.store.key != nil)
        w.session.update(userID: Self.other)
        #expect(w.store.key == nil)
        #expect(w.store.stamp()?.session.userID == Self.other)
    }

    @Test func signOutStepsOfTheStore() throws {
        let w = try UnlockWorld()
        let probe = PlaintextProbe()
        w.store.hold(probe)
        try w.putKeyInMemory()
        w.plantVaultKey()
        w.store.cancelWork()
        w.store.dropMemory()
        #expect(w.store.key == nil)
        #expect(probe.drops == 1)
        #expect(w.vaultCount == 1)
        w.store.deleteKeychainKey()
        #expect(w.vaultCount == 0)
    }
}
