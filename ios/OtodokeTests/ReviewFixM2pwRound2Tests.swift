import CryptoKit
import Foundation
import Testing
@testable import Otodoke

/// [M2+password-v1 review fix 2] What the second look (codex-review-fix1-m2pw, review-fix1-m2pw,
/// verify-fix1-m2pw) found:
///  - Codex new 2 / N-3 (CX2): a sign-in that ends while the app is in the background puts the key in use on
///    the server, but keeps it neither in memory nor in the Keychain; back in front, the password opens it.
///  - Codex new 1: a change of the client's session held during a sign-in is not thrown away: the sign-in's
///    user is published only when the client's session is still that user's.
///  - N-1: the screens asked for while signing out do not take AuthService.cleanup over.
///  - N-6: invalid_input shows its words without 「ログインし直す」.
///  - A2-2: a key row read before a key was opened, answered late, does not delete that key.
///  - Should (verify): the unit tests' host app starts nothing (no Keychain, no Supabase).
///  - Nice (verify): a test session answers a host nobody registered with a failure, on the machine.
///  - Nice (verify): stale_session at activate and unauthorized at register are not tried again (S3).
@Suite("Review fix 2 (M2+password-v1)")
@MainActor
struct ReviewFixM2pwRound2Tests {
    static let password = PW.good
    static let service = "com.iwakisyogo.otodoke.auth.round2"

    /// A password account on FakeSupabase (no key in use unless planted), the Web's key endpoints on
    /// FakeKeysServer, and the app's own makeSignedIn with fake Keychain and Face ID.
    @MainActor
    struct AppWorld {
        let fake: FakeSupabase
        let server: FakeKeysServer
        let auth: AuthService
        let keychain: FakeKeychain
        let made: Box<MainScreens>

        init() async {
            fake = FakeSupabase.make()
            server = FakeKeysServer.make(supabase: fake)
            await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: ReviewFixM2pwRound2Tests.password))
            auth = PW.auth(fake)
            let keychain = FakeKeychain()
            self.keychain = keychain
            let parts = MainScreens.KeyParts(
                policy: KeyStorePolicy(defaults: scratchDefaults()),
                keychain: keychain,
                biometrics: FakeBiometrics(.available(.faceID)),
                service: ReviewFixM2pwRound2Tests.service,
                api: KeyAPIClient(baseURL: server.baseURL, session: server.urlSession)
            )
            let made = Box<MainScreens>()
            self.made = made
            auth.makeSignedIn = { a in
                let screens = MainScreens.live(auth: a, readingConsent: .allowedForTests(), keyParts: parts)
                made.value = screens
                return screens
            }
            await auth.start()
        }

        func signIn() async throws {
            try await auth.signIn(email: FakeSupabase.email, password: ReviewFixM2pwRound2Tests.password, captchaToken: nil)
        }

        var vaultCount: Int { keychain.count(service: ReviewFixM2pwRound2Tests.service) }

        func keysInUse() async -> [Row] {
            await fake.rows("user_keys").filter { isSet($0["activated_at"]) && !isSet($0["retired_at"]) }
        }
    }

    // MARK: Codex new 2 / N-3 (CX2): a sign-in that ends in the background

    @Test func aSignInThatEndsInTheBackgroundKeepsNoKeyAndThePasswordOpensItInFront() async throws {
        let w = await AppWorld()
        let gate = Gate()
        await w.fake.fail("POST", "token", with: .hold(gate))
        // Pressed in front; the app goes to the background before Supabase answers (the login screen is shown:
        // no key store exists yet to be told).
        let signIn = Task { try await w.signIn() }
        #expect(await waitFor(.seconds(3)) { await w.fake.count("POST", "token") == 1 })
        w.auth.front.wentToBackground()
        gate.open()
        try await signIn.value
        let screens = try #require(w.made.value)
        let setup = try #require(screens.keySetup)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { setup.lastOutcome != nil } })
        // S2: the steps with the server went on: the key is in use.
        #expect(await w.server.count("activate") == 1)
        let inUse = await w.keysInUse()
        #expect(inUse.count == 1)
        let keyID = try #require(inUse.first?["key_id"]?.text)
        // CX2: nothing in memory, nothing in the Keychain.
        #expect(setup.lastOutcome == .stale)
        #expect(screens.keys?.key == nil)
        #expect(w.vaultCount == 0)
        // Back in front, the password opens it (memory and the Keychain).
        w.auth.front.cameToFront()
        let unlock = try #require(screens.unlock)
        #expect(await unlock.submit(password: Self.password))
        #expect(screens.keys?.key?.keyID == keyID)
        #expect(w.vaultCount == 1)
    }

    @Test func aStoreMadeInTheBackgroundKeepsNothingUntilTheAppIsInFront() throws {
        let session = SessionGeneration()
        session.update(userID: FakeSupabase.me)
        let front = AppFront()
        front.wentToBackground()
        let store = OpenKeyStore(session: session, vault: nil, front: front)
        let stamp = try #require(store.stamp())
        let key = OpenedKey(userID: FakeSupabase.me, recipient: Self.randomRecipient())
        #expect(store.isCurrent(stamp) == false)
        #expect(store.put(key, stamp: stamp) == false)
        #expect(store.key == nil)
        front.cameToFront()
        #expect(store.isCurrent(stamp))
        #expect(store.put(key, stamp: stamp))
        #expect(store.key == key)
    }

    // MARK: Codex new 1: a session change held during the sign-in

    @Test func aSignOutHeldDuringTheSignInIsNotThrownAway() async throws {
        let w = await AppWorld()
        let auth = w.auth
        // The client's session ends while the sign-in is in flight (after Supabase answered it).
        auth.afterSignInAnswer = {
            try? await auth.provider.auth.signOut(scope: .local)
        }
        await #expect(throws: LoginFailure.other) { try await w.signIn() }
        #expect(auth.provider.auth.currentSession == nil)
        #expect(auth.state == .signedOut)
        #expect(auth.takeSignInSecret() == nil)
        #expect(auth.signedInObject() == nil)
        #expect(w.made.value == nil)
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await w.server.requests.isEmpty)
    }

    @Test func aSignInWhoseSessionStaysIsPublished() async throws {
        // Control: nothing changed meanwhile.
        let w = await AppWorld()
        w.auth.afterSignInAnswer = {}
        try await w.signIn()
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.made.value != nil)
    }

    // MARK: N-1: the screens asked for while signing out

    @Test func theScreensAskedForWhileSigningOutDoNotTakeTheCleanupOver() async throws {
        let w = await AppWorld()
        try await w.signIn()
        let shown = MainScreens.of(w.auth)
        let first = try #require(w.auth.cleanup)
        #expect(first === shown.keys)
        let gate = Gate()
        await w.fake.fail("POST", "logout", with: .hold(gate))
        let signOut = Task { await w.auth.signOut() }
        #expect(await waitFor(.seconds(3)) { await w.fake.count("POST", "logout") == 1 })
        // The generation moved on, the screen may still be the tabs: RootView makes MainTabView(auth:) again.
        let during = MainScreens.of(w.auth)
        #expect(w.auth.cleanup === first)
        #expect(during.keys == nil)
        gate.open()
        await signOut.value
        #expect(w.auth.state == .signedOut)
    }

    // MARK: N-6: invalid_input

    @Test func anInvalidInputShowsItsWordsWithoutSignInAgain() async throws {
        let w = await AppWorld()
        await w.server.force("register", nth: 1, .answer(status: 400, code: "invalid_input"))
        try await w.signIn()
        let screens = try #require(w.made.value)
        let setup = try #require(screens.keySetup)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { setup.lastOutcome != nil } })
        #expect(setup.lastOutcome == .failed(message: LoginText.invalidInput))
        #expect(await w.server.count("register") == 1)
        await screens.settings.onAppear()
        #expect(screens.settings.keyStepFailure?.message == LoginText.invalidInput)
        #expect(screens.settings.keyStepFailure?.signInAgain == false)
        let unlock = try #require(screens.unlock)
        #expect(await unlock.submit(password: Self.password) == false)
        #expect(unlock.message == LoginText.invalidInput)
        #expect(unlock.shownHelp == nil)
    }

    @Test func anotherFailureStillOffersSignInAgain() async throws {
        // Control: key_challenge_failed (not worth a retry) keeps 「ログインし直す」.
        let w = await AppWorld()
        await w.server.force("register", nth: 1, .answer(status: 422, code: "key_challenge_failed"))
        try await w.signIn()
        let screens = try #require(w.made.value)
        let setup = try #require(screens.keySetup)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { setup.lastOutcome != nil } })
        await screens.settings.onAppear()
        #expect(screens.settings.keyStepFailure?.message == LoginText.keyChallengeFailed)
        #expect(screens.settings.keyStepFailure?.signInAgain == true)
        let unlock = try #require(screens.unlock)
        #expect(await unlock.submit(password: Self.password) == false)
        #expect(unlock.message == LoginText.noKeyYet)
        #expect(unlock.shownHelp == .signInAgain)
    }

    // MARK: A2-2: an old key row answered late

    @Test func anOldKeyRowAnsweredLateDoesNotDeleteTheKeyOpenedMeanwhile() async throws {
        let w = try UnlockWorld()
        // The device's older key A in memory and in the Keychain; the mail is sealed to the vector's key B.
        let older = P256.KeyAgreement.PrivateKey()
        let olderID = KeyWrap.keyIDOf(older.publicKey.x963Representation)
        let olderKey = OpenedKey(userID: FakeSupabase.me, recipient: PrivateRecipient(keyID: olderID, publicKey: older.publicKey.x963Representation, privateKey: older))
        w.store.put(olderKey, stamp: try #require(w.store.stamp()))
        let newRow = w.v.row()
        let oldRow = StoredKeyRow(keyId: olderID, publicKey: newRow.publicKey, wrappedPrivateKey: newRow.wrappedPrivateKey, wrapIv: newRow.wrapIv, kdfSalt: newRow.kdfSalt, kdfIterations: newRow.kdfIterations)
        // The first read was answered by the database before the Web's change (A still in use), late.
        let reads = ScriptedKeyReads(first: oldRow, then: newRow)
        let gate = Gate()
        reads.holdFirst(on: gate)
        let model = UnlockModel(store: w.store, keys: reads, vault: w.vault, policy: w.policy, deriver: w.deriver)
        let opening = Task { await model.recipient(forKid: w.v.keyID) }
        #expect(await waitFor(.seconds(3)) { reads.count == 1 })
        // Meanwhile the password opens the new key B (memory and the Keychain).
        #expect(await model.submit(password: w.v.passphrase, email: UnlockWorld.email))
        #expect(w.store.key?.keyID == w.v.keyID)
        #expect(w.vaultCount == 1)
        gate.open()
        let outcome = await opening.value
        // The old row does not judge the key opened after it was read: B stays (memory and the Keychain).
        #expect(w.store.key?.keyID == w.v.keyID)
        #expect(w.vaultCount == 1)
        #expect(outcome == .key(try #require(w.store.key)))
    }

    @Test func anOldDeviceKeyIsStillDeletedWhenNothingWasOpenedMeanwhile() async throws {
        // Control: the key row read says another key, and nothing was put during the read: the device key is old.
        let w = try UnlockWorld()
        w.plantVaultKey()
        let older = P256.KeyAgreement.PrivateKey()
        let olderID = KeyWrap.keyIDOf(older.publicKey.x963Representation)
        let olderKey = OpenedKey(userID: FakeSupabase.me, recipient: PrivateRecipient(keyID: olderID, publicKey: older.publicKey.x963Representation, privateKey: older))
        w.store.put(olderKey, stamp: try #require(w.store.stamp()))
        let outcome = await w.model.recipient(forKid: w.v.keyID)
        #expect(outcome == .needsPassphrase)
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
    }

    // MARK: Should (verify): the unit tests' host app starts nothing

    @Test func theUnitTestsHostStartsNothing() {
        // XCTest sets this in the process it injects the test bundle into (this one).
        #expect(ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil)
        let hosted = AppStart.load(info: [:], environment: ["XCTestConfigurationFilePath": "/tmp/Otodoke.xctestconfiguration"])
        guard case .testHost = hosted else {
            Issue.record("the test host started the app")
            return
        }
        // Control: without it, the app reads its settings (here none: misconfigured, before any Keychain).
        guard case .misconfigured = AppStart.load(info: [:], environment: [:], arguments: []) else {
            Issue.record("an app without settings was not misconfigured")
            return
        }
    }

    @Test func theScreenCheckNeedsNoSettingsButAnOrdinaryLaunchStillDoes() {
        // `-otodoke-ui-preview <scenario>` is let in before the settings are checked (no Secrets.xcconfig needed).
        guard case .ready = AppStart.load(info: [:], environment: [:], arguments: ["-otodoke-ui-preview", "list"]) else {
            Issue.record("the screen check was stopped for missing settings")
            return
        }
        // Negative controls: no argument, an argument without a scenario, or an unknown scenario is an ordinary launch.
        for arguments in [[], ["-otodoke-ui-preview"], ["-otodoke-ui-preview", "no-such-scenario"]] as [[String]] {
            guard case .misconfigured = AppStart.load(info: [:], environment: [:], arguments: arguments) else {
                Issue.record("an ordinary launch without settings was not misconfigured: \(arguments)")
                return
            }
        }
    }

    // MARK: Nice (verify): a host nobody registered

    @Test func aHostNobodyRegisteredFailsOnTheMachine() async throws {
        let session = StubURLProtocol.makeSession()
        let url = URL(string: "https://not-registered-\(UUID().uuidString.lowercased()).invalid/")!
        do {
            _ = try await session.data(from: url)
            Issue.record("answered")
        } catch let error as URLError {
            #expect(error.code == .unsupportedURL)
        }
    }

    // MARK: Nice (verify): S3 does not try these again

    @Test(arguments: [
        ("activate", 403, "stale_session", LoginText.staleSession),
        ("register", 401, "unauthorized", LoginText.signedOut),
    ])
    func aRefusalThatIsNotWorthAgainIsNotTriedAgain(endpoint: String, status: Int, code: String, words: String) async throws {
        let w = try await KeySetupTests.World()
        await w.server.force(endpoint, nth: 1, .answer(status: status, code: code))
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .failed(message: words))
        #expect(await w.server.count("register") == 1)
        #expect(await w.server.count("activate") == (endpoint == "activate" ? 1 : 0))
        #expect(await w.keysInUse().isEmpty)
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
    }

    static func randomRecipient() -> PrivateRecipient {
        let key = P256.KeyAgreement.PrivateKey()
        let publicKey = key.publicKey.x963Representation
        return PrivateRecipient(keyID: KeyWrap.keyIDOf(publicKey), publicKey: publicKey, privateKey: key)
    }
}

/// MailKeyReading whose first key read answers `first` (and can be held on a Gate); every later read answers
/// `then`.
final class ScriptedKeyReads: MailKeyReading, @unchecked Sendable {
    private let lock = NSLock()
    private let first: StoredKeyRow
    private let then: StoredKeyRow
    private var gate: Gate?
    private var reads = 0

    init(first: StoredKeyRow, then: StoredKeyRow) {
        self.first = first
        self.then = then
    }

    func holdFirst(on gate: Gate) { lock.withLock { self.gate = gate } }
    var count: Int { lock.withLock { reads } }

    func currentKey() async -> LoadResult<StoredKeyRow?> {
        let (n, waitOn): (Int, Gate?) = lock.withLock {
            reads += 1
            return (reads, reads == 1 ? gate : nil)
        }
        if let waitOn { await waitOn.wait() }
        return .loaded(n == 1 ? first : then)
    }

    func envelope(emailID: String) async -> LoadResult<Data?> { .loaded(nil) }
}
