import Foundation
import Testing
@testable import Otodoke

/// A signed-in person whose stored session can be made unreadable or impossible to remove.
@MainActor
struct MarkWorld {
    static let otherAddress = "other@example.com"

    let fake: FakeSupabase
    let storage: StallFlakyStorage
    let marks: TestDefaults
    let provider: SupabaseProvider
    let auth: AuthService
    let firstRefresh: String

    /// The one place an AuthService is built; it is given the test's own UserDefaults.
    static func makeAuth(_ provider: SupabaseProvider, _ marks: TestDefaults) -> AuthService {
        AuthService(provider: provider, deriver: PW.fastDeriver(), userDefaults: marks.defaults)
    }

    static func make(signedIn: Bool = true) async throws -> MarkWorld {
        let fake = FakeSupabase.make()
        let storage = StallFlakyStorage()
        let marks = TestDefaults()
        let provider = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: storage)
        if signedIn { _ = try await provider.auth.verifyOTP(email: FakeSupabase.email, token: FakeSupabase.goodCode, type: .email) }
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        await fake.addPasswordAccount(email: otherAddress, secret: PW.secret(email: otherAddress, password: PW.good), userID: FakeSupabase.other)
        let auth = makeAuth(provider, marks)
        await auth.start()
        guard signedIn else { return MarkWorld(fake: fake, storage: storage, marks: marks, provider: provider, auth: auth, firstRefresh: "") }
        #expect(auth.state == .signedIn(userID: FakeSupabase.me))
        let first = try #require(provider.auth.currentSession).refreshToken
        return MarkWorld(fake: fake, storage: storage, marks: marks, provider: provider, auth: auth, firstRefresh: first)
    }

    /// Signs out while the stored session cannot be read or removed, then lets storage work again.
    func signOutWhileStorageFails(_ mode: StallFlakyStorage.Mode) async {
        storage.setMode(mode)
        storage.setRemoveFails(true)
        await auth.signOut()
        storage.setMode(.reads)
        storage.setRemoveFails(false)
        #expect(auth.state == .signedOut)
        #expect(!storage.isEmpty)
    }

    /// A new launch: a new client and a new service on the same storage and the same UserDefaults.
    func restart() async -> AuthService {
        let again = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: storage)
        let service = Self.makeAuth(again, marks)
        await service.start()
        return service
    }

    /// The client signs in by itself, outside AuthService (an event the service did not ask for).
    func strayLogin() async throws {
        _ = try await provider.auth.verifyOTP(email: FakeSupabase.email, token: FakeSupabase.goodCode, type: .email)
    }
}

@Suite("Signed-out mark")
@MainActor
struct SignedOutMarkTests {
    // MARK: 1. a sign-out whose clear failed stays signed out

    @Test(arguments: stallFailingModes)
    func aRestartAfterAFailedClearStaysSignedOut(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)

        let restarted = await w.restart()

        #expect(restarted.state == .signedOut)
        #expect(RootScreen.of(restarted.state) == .login)
        #expect(w.storage.isEmpty)
    }

    @Test(arguments: stallFailingModes)
    func checkingTheSessionAfterAFailedClearStaysSignedOut(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)

        await w.auth.checkSession()

        #expect(w.auth.state == .signedOut)
        #expect(RootScreen.of(w.auth.state) == .login)
        #expect(w.storage.isEmpty)
    }

    @Test(arguments: stallFailingModes, ["refresh", "login"])
    func aLaterClientEventAfterAFailedClearStaysSignedOut(_ mode: StallFlakyStorage.Mode, _ event: String) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)

        if event == "refresh" { _ = try await w.provider.auth.refreshSession() } else { try await w.strayLogin() }
        let storage = w.storage, auth = w.auth
        _ = await waitFor(.seconds(2)) { await auth.state != .signedOut || storage.isEmpty }

        #expect(w.auth.state == .signedOut)
        #expect(RootScreen.of(w.auth.state) == .login)
        #expect(w.storage.isEmpty)
    }

    @Test(arguments: stallFailingModes)
    func theMarkHoldsOneFlagAndNothingOfThePerson(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)

        let domain = w.marks.defaults.persistentDomain(forName: w.marks.name) ?? [:]

        #expect(domain.count == 1)
        #expect(domain.values.first as? Bool == true)
        let text = String(describing: domain).lowercased()
        #expect(!text.contains(FakeSupabase.me) && !text.contains("example.com") && !text.contains(w.firstRefresh.lowercased()))
    }

    // MARK: 2 and 3. signing in again after a failed clear

    @Test(arguments: stallFailingModes)
    func theSameAccountCanSignInAgainAndTheOldSessionDoesNotComeBack(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)

        try await w.auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)

        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        let current = try #require(w.provider.auth.currentSession)
        #expect(current.refreshToken != w.firstRefresh)
        await w.auth.checkSession()
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
        #expect(restarted.provider.auth.currentSession?.refreshToken == current.refreshToken)
    }

    @Test(arguments: stallFailingModes)
    func anotherAccountCanSignInAndTheOldSessionDoesNotComeBack(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)

        try await w.auth.signIn(email: MarkWorld.otherAddress, password: PW.good, captchaToken: nil)

        #expect(w.auth.state == .signedIn(userID: FakeSupabase.other))
        let current = try #require(w.provider.auth.currentSession)
        #expect(current.refreshToken != w.firstRefresh)
        await w.auth.checkSession()
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.other))
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.other))
        #expect(restarted.provider.auth.currentSession?.refreshToken == current.refreshToken)
    }

    @Test func aSignOutThatCleared_thenASignInAgain_signsInAndStays() async throws {
        let w = try await MarkWorld.make()
        await w.auth.signOut()
        #expect(w.auth.state == .signedOut)
        #expect(w.storage.isEmpty)

        try await w.auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)

        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
    }

    // MARK: 4. a held event of the previous person

    @Test(arguments: stallFailingModes)
    func aPreviousPersonsEventHeldDuringASignInIsNotPublishedWhenTheSignInFails(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)
        let gate = Gate()
        defer { gate.open() }
        await w.fake.fail("POST", "token", with: .hold(gate))
        await w.fake.forceAuth("password", status: 400, code: "invalid_credentials")
        let auth = w.auth, fake = w.fake
        let signingIn = Task { try? await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
        #expect(await waitFor { await fake.count("POST", "token") == 1 })

        try await w.strayLogin()
        let provider = w.provider, first = w.firstRefresh
        #expect(await waitFor { provider.auth.currentSession?.refreshToken != first })
        for _ in 0..<30 { await Task.yield() }
        gate.open()
        await signingIn.value

        #expect(w.auth.state == .signedOut)
        #expect(RootScreen.of(w.auth.state) == .login)
        #expect(w.storage.isEmpty)
    }

    // MARK: 5. every way a session is made or received

    @Test(arguments: stallFailingModes)
    func signingInFromTheConfirmationScreenAfterAFailedClearSignsInAndStays(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)

        try await w.auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil, fromConfirmation: true)

        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.auth.takeSignInSecret()?.fromConfirmation == true)
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test(arguments: stallFailingModes)
    func theLoginScreenSignsInAfterAFailedClearAndStays(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)
        let model = LoginModel(auth: w.auth, launch: LaunchOptions(arguments: ["Otodoke"]), now: TestClock(Date(timeIntervalSince1970: 1_793_000_000)).function, turnstile: nil, tokenWait: .milliseconds(200))
        model.email = FakeSupabase.email
        model.password = PW.good

        await model.submit()

        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test(arguments: stallFailingModes)
    func aSignUpThatAnswersWithASessionDoesNotLetTheOldSessionIn(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await MarkWorld.make()
        await w.signOutWhileStorageFails(mode)
        await w.fake.setSignUpAnswersWithSession(true)

        try await w.auth.signUp(email: "new@example.com", password: PW.good, captchaToken: nil)
        try await w.strayLogin()
        await w.auth.checkSession()

        #expect(w.auth.state == .signedOut)
        #expect(RootScreen.of(w.auth.state) == .login)
    }

    @Test func aSignUpSessionThatCannotBeRemovedDoesNotLogInLaterAndASignInStillWorks() async throws {
        let w = try await MarkWorld.make(signedIn: false)
        await w.fake.setSignUpAnswersWithSession(true)
        w.storage.setRemoveFails(true)

        try await w.auth.signUp(email: "new@example.com", password: PW.good, captchaToken: nil)
        w.storage.setRemoveFails(false)

        #expect(!w.storage.isEmpty)
        let restarted = await w.restart()
        #expect(restarted.state == .signedOut)
        #expect(w.storage.isEmpty)
        w.storage.setRemoveFails(false)
        try await w.strayLogin()
        await w.auth.checkSession()
        #expect(w.auth.state == .signedOut)

        try await w.auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        let again = await w.restart()
        #expect(again.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test func aSignUpWithoutASessionRaisesNoMark() async throws {
        let w = try await MarkWorld.make(signedIn: false)

        try await w.auth.signUp(email: "new@example.com", password: PW.good, captchaToken: nil)

        #expect((w.marks.defaults.persistentDomain(forName: w.marks.name) ?? [:]).isEmpty)
        try await w.strayLogin()
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test func theKeyRecoveryReauthenticationLeavesTheSignedInSessionAsItWas() async throws {
        let w = try await MarkWorld.make()
        await w.auth.signOut()
        try await w.auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        let before = try #require(w.provider.auth.currentSession).refreshToken

        let token = try await w.auth.authenticateForKeyRecovery(authSecret: PW.secret(email: FakeSupabase.email, password: PW.good), captchaToken: nil)

        #expect(!token.isEmpty)
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.provider.auth.currentSession?.refreshToken == before)
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
    }

    // MARK: sign-out inside a sign-in

    @Test func aSignOutStillInFlightWhenTheSameFlowSignsInEndsSignedIn() async throws {
        let w = try await MarkWorld.make()
        let releaseLogout = Gate(), answered = Gate(), releasePublication = Gate()
        defer { releaseLogout.open(); releasePublication.open() }
        await w.fake.fail("POST", "logout", with: .hold(releaseLogout))
        let auth = w.auth, fake = w.fake
        let signingOut = Task { await auth.signOut() }
        #expect(await waitFor {
            let state = await auth.state
            let requests = await fake.count("POST", "logout")
            return state == .signedOut && requests == 1
        })
        auth.afterSignInAnswer = {
            answered.open()
            await releasePublication.wait()
        }
        let signingIn = Task { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
        await answered.wait()

        releaseLogout.open()
        await signingOut.value
        releasePublication.open()
        try await signingIn.value

        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        await w.auth.checkSession()
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test func theAppComingBackDuringASignInDoesNotClearTheSessionTheClientJustStored() async throws {
        let w = try await MarkWorld.make()
        await w.auth.signOut()
        #expect(w.auth.state == .signedOut)
        let auth = w.auth
        auth.afterSignInAnswer = { await auth.checkSession() }

        try await w.auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)

        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(!w.marks.defaults.bool(forKey: "otodoke.auth.signedOutPending"))
        let current = try #require(w.provider.auth.currentSession)
        #expect(current.refreshToken != w.firstRefresh)
        let restarted = await w.restart()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
        #expect(restarted.provider.auth.currentSession?.refreshToken == current.refreshToken)
    }

    // MARK: 6. controls: no sign-out, nothing changes

    @Test func withoutASignOutALaunchReceivesTheStoredSession() async throws {
        let w = try await MarkWorld.make()

        let restarted = await w.restart()

        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
        await restarted.checkSession()
        #expect(restarted.state == .signedIn(userID: FakeSupabase.me))
    }
}
