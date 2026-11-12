import CryptoKit
import Foundation
import SwiftUI
import Testing
@testable import Otodoke

/// [M2+password-v1 review fix 1] The key step's owner and its orders:
///  - A3-1 / M1: supabase-swift emits .signedIn before signIn returns; the key step runs (once) whichever comes
///    first: the screens made at that event, or the sign-in's hand-off.
///  - B1-1 / S1 / SEC-S1: the screens (and the opened key's store) live as long as the signed-in generation; a
///    MainTabView made again keeps AuthService.cleanup on the store shown, and sign-out empties that store.
///  - S2: the background stops only the last step (keep), not the steps with the server.
///  - S3: key_not_pending or no answer: once more from register with a new key; the failure shows in settings.
///  - S5: a run of another sign-in waits for the one in flight, then runs.
///  - SEC-N1 / SEC-N2: activate's keyId is the one sent; `ok` is JSON true only; a redirect is not followed.
///  - keys.md (integrate/password-v1 c9ca941): the sizes sent; invalid_input is not sent again.
///  - A2-1 / A2-2: Face ID's ask is shared within its stamp only; a key opened during a read of the key row stays.
///  - N1 / N4 / N6: no status is network; an address mismatch says so without 「ログインし直す」; a changed
///    address drops the resend.
@Suite("Review fix 1 (M2+password-v1): the key step's owner and orders")
@MainActor
struct KeyOwnerAndOrderTests {
    static let password = PW.good

    /// FakeSupabase with a confirmed password account for FakeSupabase.email and, when `keyInUse`, a key in use
    /// wrapped with the master of (email, password): the key step after the sign-in opens it.
    struct SignInWorld {
        let fake: FakeSupabase
        let auth: AuthService
        let master: Data
        let plantedKeyID: String?

        /// The Web's origin (AppConfig.webBase, which MainScreens.live's KeySetup posts to) answered here with a
        /// 404 page (the key endpoints not deployed): nothing of these tests leaves the machine.
        static let webOrigin: Void = {
            StubURLProtocol.register(host: AppConfig.webBase.host() ?? "otodoke.app") { _ in
                .http(status: 404, headers: ["Content-Type": "text/html"], body: Data("<html>404</html>".utf8))
            }
        }()

        @MainActor
        init(keyInUse: Bool = true) async throws {
            _ = Self.webOrigin
            fake = FakeSupabase.make()
            await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: KeyOwnerAndOrderTests.password))
            master = PW.master(email: FakeSupabase.email, password: KeyOwnerAndOrderTests.password)
            if keyInUse {
                let row = try KeyGeneration.generate(master: master, userID: FakeSupabase.me).row
                await fake.insert("user_keys", [[
                    "user_id": .string(FakeSupabase.me), "key_id": .string(row.keyID), "public_key": .string(row.publicKey),
                    "wrapped_private_key": .string(row.wrappedPrivateKey), "wrap_iv": .string(row.wrapIv), "kdf_salt": .string(row.kdfSalt),
                    "kdf_iterations": 600_000, "activated_at": "2026-11-06T00:00:00.000000+00:00", "retired_at": nil,
                ]])
                plantedKeyID = row.keyID
            } else {
                plantedKeyID = nil
            }
            auth = PW.auth(fake)
            await auth.start()
        }

        func signIn() async throws {
            try await auth.signIn(email: FakeSupabase.email, password: KeyOwnerAndOrderTests.password, captchaToken: nil)
        }

        /// The reads of the key in use (the key step reads it once).
        func keyInUseReads() async -> Int {
            await fake.requests("GET", "user_keys").filter { $0.url.absoluteString.contains("retired_at=is.null") }.count
        }
    }

    // MARK: A3-1 / M1: the order of .signedIn and the hand-off

    @Test func theScreensMadeAtTheFirstSignedInStillRunTheKeyStep() async throws {
        let w = try await SignInWorld()
        let auth = w.auth
        let made = Box<MainScreens>()
        // The client's .signedIn was handled before signIn returned: the screens come up then (the bad order).
        auth.afterSignInAnswer = {
            _ = await waitFor(.seconds(3)) { await MainActor.run { auth.session.stamp()?.userID == FakeSupabase.me } }
            made.value = MainScreens.live(auth: auth, readingConsent: .allowedForTests())
        }
        try await w.signIn()
        let screens = try #require(made.value)
        let keys = try #require(screens.keys)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { keys.key?.keyID == w.plantedKeyID } })
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await w.keyInUseReads() == 1)
        #expect(auth.takeSignInSecret() == nil)
    }

    @Test func theGenerationsScreensAreMadeOnceAndRunTheKeyStepOnce() async throws {
        let w = try await SignInWorld()
        let auth = w.auth
        let counter = Box<Int>()
        counter.value = 0
        auth.makeSignedIn = { a in
            counter.value = (counter.value ?? 0) + 1
            return MainScreens.live(auth: a, readingConsent: .allowedForTests())
        }
        try await w.signIn()
        _ = MainTabView(auth: auth)
        _ = MainTabView(auth: auth)
        let screens = MainScreens.of(auth)
        #expect(counter.value == 1)
        let keys = try #require(screens.keys)
        #expect(auth.cleanup === keys)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { keys.key?.keyID == w.plantedKeyID } })
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await w.keyInUseReads() == 1)
    }

    // MARK: B1-1 / SEC-S1: one store per generation

    @Test func aTabViewMadeAgainKeepsTheCleanupOnTheFirstScreensStore() async throws {
        let w = try await SignInWorld(keyInUse: false)
        try await w.signIn()
        let shown = MainScreens.of(w.auth)
        _ = MainTabView(auth: w.auth)
        let first = try #require(w.auth.cleanup)
        _ = MainTabView(auth: w.auth)
        #expect(w.auth.cleanup === first)
        #expect(w.auth.cleanup === shown.keys)
        #expect(MainScreens.of(w.auth) === shown)
    }

    @Test func signOutEmptiesTheStoreShownAfterTheViewWasMadeAgain() async throws {
        let w = try await SignInWorld(keyInUse: false)
        try await w.signIn()
        let shown = MainScreens.of(w.auth)
        let keys = try #require(shown.keys)
        let probe = PlaintextProbe()
        keys.hold(probe)
        let work = Task<Void, Never> { try? await Task.sleep(for: .seconds(30)) }
        keys.track(work)
        // RootView reads scenePhase: back in front, MainTabView(auth:) is made again.
        _ = MainTabView(auth: w.auth)
        _ = MainTabView(auth: w.auth)
        await w.auth.signOut()
        #expect(probe.drops == 1)
        #expect(work.isCancelled)
        #expect(keys.key == nil)
    }

    @Test func aNewGenerationGetsNewScreens() async throws {
        let w = try await SignInWorld(keyInUse: false)
        try await w.signIn()
        let first = MainScreens.of(w.auth)
        await w.auth.signOut()
        try await w.signIn()
        let second = MainScreens.of(w.auth)
        #expect(first !== second)
        #expect(w.auth.cleanup === second.keys)
    }

    // MARK: N4: the address the session has is not the one typed

    @Test func anAddressMismatchSaysSoWithoutSignInAgain() async throws {
        let w = try await SignInWorld(keyInUse: false)
        await w.fake.setUserEmail("other@example.com")
        try await w.signIn()
        #expect(w.auth.takeSignInSecret() == nil)
        let screens = MainScreens.live(auth: w.auth, readingConsent: .allowedForTests())
        let setup = try #require(screens.keySetup)
        #expect(setup.lastOutcome == .addressMismatch)
        let unlock = try #require(screens.unlock)
        #expect(await unlock.submit(password: Self.password) == false)
        #expect(unlock.message == LoginText.addressMismatch)
        #expect(unlock.shownHelp == nil)
        #expect(await w.fake.count("GET", "user_keys") >= 1)
        await screens.settings.onAppear()
        #expect(screens.settings.keyStepFailure?.message == LoginText.addressMismatch)
        #expect(screens.settings.keyStepFailure?.signInAgain == false)
    }

    @Test func theAddressMismatchWordsAreTheWebs() {
        #expect(LoginText.addressMismatch == "このアカウントでは、メールの鍵を作れませんでした。")
    }

    // MARK: S3 (b): the key step's failure on the settings card

    @Test func aKeyStepThatFailedShowsOnTheSettingsCardWithSignInAgain() async throws {
        let w = try await SignInWorld(keyInUse: false)
        try await w.signIn()
        // The Web's key endpoints are not answered here (as before they are in production): no answer, twice.
        let screens = MainScreens.live(auth: w.auth, readingConsent: .allowedForTests())
        let setup = try #require(screens.keySetup)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { setup.lastOutcome != nil } })
        #expect(setup.lastOutcome == .failed(message: LoginText.network))
        await screens.settings.onAppear()
        #expect(screens.settings.keyStepFailure?.message == LoginText.network)
        #expect(screens.settings.keyStepFailure?.signInAgain == true)
    }

    // MARK: S2: the background stops only keep

    @Test func theBackgroundDuringRegisterStillPutsTheKeyInUseButKeepsNothing() async throws {
        let w = try await KeySetupTests.World()
        let gate = Gate()
        await w.server.hold("register", on: gate)
        let run = Task { await w.setup.run(w.signIn) }
        #expect(await waitFor(.seconds(3)) { await w.server.count("register") == 1 })
        w.store.wentToBackground()
        gate.open()
        let outcome = await run.value
        #expect(await w.server.count("activate") == 1)
        #expect(await w.keysInUse().count == 1)
        // CX2: nothing in memory or the Keychain for a period that ended.
        #expect(outcome == .stale)
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
    }

    // MARK: S3 (a): once more from register, with a new key

    @Test(arguments: [
        ("activate", KeyOwnerAndOrderTests.ForcedFailure.keyNotPending),
        ("register", KeyOwnerAndOrderTests.ForcedFailure.noAnswer),
        ("activate", KeyOwnerAndOrderTests.ForcedFailure.noAnswer),
    ])
    func aKeyNotPendingOrNoAnswerIsTriedOnceMoreWithANewKey(endpoint: String, failure: ForcedFailure) async throws {
        let w = try await KeySetupTests.World()
        await w.server.force(endpoint, nth: 1, failure.forced)
        let outcome = await w.setup.run(w.signIn)
        let registers = await w.server.requests("register")
        #expect(registers.count == 2)
        let keys = registers.compactMap { $0.jsonDictionary?["publicKey"] as? String }
        #expect(keys.count == 2)
        #expect(Set(keys).count == 2)
        let inUse = await w.keysInUse()
        #expect(inUse.count == 1)
        let keyID = try #require(inUse.first?["key_id"]?.text)
        #expect(outcome == .created(keyID: keyID))
        // The key in memory is the second one (the first is not kept anywhere).
        let second = try #require(keys.last.flatMap { Data(base64Encoded: $0) })
        #expect(w.store.key?.keyID == KeyWrap.keyIDOf(second))
        let first = try #require(keys.first.flatMap { Data(base64Encoded: $0) })
        #expect(w.store.key?.keyID != KeyWrap.keyIDOf(first))
        #expect(w.vaultCount == 1)
    }

    enum ForcedFailure: Sendable, CustomStringConvertible {
        case keyNotPending, noAnswer
        var forced: FakeKeysServer.Forced {
            switch self {
            case .keyNotPending: .answer(status: 409, code: "key_not_pending")
            case .noAnswer: .transport(.notConnectedToInternet)
            }
        }

        var description: String { self == .keyNotPending ? "key_not_pending" : "no answer" }
    }

    @Test(arguments: ["stale_session", "invalid_input", "key_challenge_failed", "key_failed"])
    func otherCodesAreNotTriedAgain(code: String) async throws {
        let w = try await KeySetupTests.World()
        let status = ["stale_session": 403, "invalid_input": 400, "key_challenge_failed": 422, "key_failed": 500][code] ?? 500
        await w.server.force(code == "key_challenge_failed" ? "activate" : "register", .answer(status: status, code: code))
        let outcome = await w.setup.run(w.signIn)
        #expect(await w.server.count("register") == 1)
        if case .failed = outcome {} else { Issue.record("expected .failed, got \(outcome)") }
    }

    // MARK: S5: another sign-in's run

    @Test func aRunOfANewSessionWaitsForTheOldOneAndRuns() async throws {
        let w = try await KeySetupTests.World()
        let gate = Gate()
        await w.server.hold("register", on: gate)
        let old = Task { await w.setup.run(w.signIn) }
        #expect(await waitFor(.seconds(3)) { await w.server.count("register") == 1 })
        // Signed out and in again meanwhile (the same user, a new session generation).
        await w.auth.signOut()
        _ = try await w.auth.provider.auth.signIn(email: FakeSupabase.email, password: "s")
        let auth = w.auth
        #expect(await waitFor(.seconds(3)) { await MainActor.run { auth.session.stamp() != nil } })
        let new = Task { await w.setup.run(w.signIn) }
        try? await Task.sleep(for: .milliseconds(100))
        gate.open()
        #expect(await old.value == .stale)
        let outcome = await new.value
        if case .created = outcome {} else { Issue.record("expected .created, got \(outcome)") }
        #expect(w.store.key != nil)
        #expect(await w.keysInUse().count == 1)
    }

    // MARK: keys.md (c9ca941): what is sent

    @Test func theValuesSentAreTheSizesKeysMdTakes() async throws {
        let w = try await KeySetupTests.World()
        await w.setup.run(w.signIn)
        let register = try #require(await w.server.requests("register").first?.jsonDictionary)
        func bytes(_ key: String) -> Data? { (register[key] as? String).flatMap { Data(base64Encoded: $0) } }
        let publicKey = try #require(bytes("publicKey"))
        #expect(publicKey.count == 65)
        #expect(publicKey.first == 0x04)
        #expect((try? P256.KeyAgreement.PublicKey(x963Representation: publicKey)) != nil)
        let wrapped = try #require(bytes("wrappedPrivateKey"))
        #expect((64...512).contains(wrapped.count))
        #expect(bytes("wrapIv")?.count == 12)
        #expect(bytes("kdfSalt")?.count == 16)
        #expect(register["kdfIterations"] as? Int == 600_000)
        let activate = try #require(await w.server.requests("activate").first?.jsonDictionary)
        #expect((activate["challenge"] as? String).flatMap { Data(base64Encoded: $0) }?.count == 32)
        #expect(Envelope.isKid(activate["keyId"] as? String ?? ""))
    }

    // MARK: SEC-N1 / SEC-N2: the client

    /// A KeyAPIClient against its own stub host answering `reply`.
    static func client(_ reply: @escaping @Sendable (StubRequest) -> StubReply) -> (KeyAPIClient, String) {
        let host = "\(UUID().uuidString.lowercased()).keys.test"
        StubURLProtocol.register(host: host) { request in reply(request) }
        return (KeyAPIClient(baseURL: URL(string: "https://\(host)")!, session: StubURLProtocol.makeSession()), host)
    }

    nonisolated static let kid = "0123456789abcdef0123456789abcdef"
    nonisolated static let otherKid = "fedcba9876543210fedcba9876543210"

    @Test func activateAnsweringAnotherKeyIsNotTaken() async throws {
        let (client, host) = Self.client { _ in .json(200, ["ok": true, "keyId": KeyOwnerAndOrderTests.otherKid]) }
        defer { StubURLProtocol.unregister(host: host) }
        await #expect(throws: KeyAPIFailure.network) {
            try await client.activate(keyID: Self.kid, challenge: Data(count: 32), expectedCurrentKeyID: nil, accessToken: "t")
        }
        // Control: the key sent is taken.
        let (same, sameHost) = Self.client { _ in .json(200, ["ok": true, "keyId": KeyOwnerAndOrderTests.kid]) }
        defer { StubURLProtocol.unregister(host: sameHost) }
        #expect(try await same.activate(keyID: Self.kid, challenge: Data(count: 32), expectedCurrentKeyID: nil, accessToken: "t") == Self.kid)
    }

    @Test func okIsJSONTrueOnly() async throws {
        let body = #"{"ok":1,"keyId":"0123456789abcdef0123456789abcdef"}"#
        let (client, host) = Self.client { _ in .http(status: 200, headers: ["Content-Type": "application/json"], body: Data(body.utf8)) }
        defer { StubURLProtocol.unregister(host: host) }
        await #expect(throws: KeyAPIFailure.network) {
            try await client.activate(keyID: Self.kid, challenge: Data(count: 32), expectedCurrentKeyID: nil, accessToken: "t")
        }
        #expect(KeyAPIClient.isJSONTrue(true as NSNumber))
        #expect(!KeyAPIClient.isJSONTrue(1 as NSNumber))
        #expect(!KeyAPIClient.isJSONTrue("true"))
        #expect(!KeyAPIClient.isJSONTrue(nil))
    }

    @Test func aRedirectIsNotFollowed() async throws {
        RedirectingProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RedirectingProtocol.self]
        let session = URLSession(configuration: config)
        let client = KeyAPIClient(baseURL: URL(string: "https://\(RedirectingProtocol.host)")!, session: session)
        await #expect(throws: KeyAPIFailure.network) {
            try await client.activate(keyID: Self.kid, challenge: Data(count: 32), expectedCurrentKeyID: nil, accessToken: "t")
        }
        #expect(RedirectingProtocol.paths.contains("/api/keys/activate"))
        #expect(!RedirectingProtocol.paths.contains("/landing"))
    }

    @Test func aRedirectingStubIsFollowedWithoutTheClientsDelegate() async throws {
        // Positive control of the stub: a plain URLSession follows its redirect to /landing.
        RedirectingProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RedirectingProtocol.self]
        let session = URLSession(configuration: config)
        let (_, response) = try await session.data(from: URL(string: "https://\(RedirectingProtocol.host)/api/keys/activate")!)
        #expect((response as? HTTPURLResponse)?.statusCode == 200)
        #expect(RedirectingProtocol.paths.contains("/landing"))
    }

    // MARK: A2-2: a key opened while the key row is read again

    @Test func aKeyOpenedDuringTheReadAgainIsNotDeleted() async throws {
        let w = try UnlockWorld()
        let gated = GatedKeyReads(row: w.v.row())
        let model = UnlockModel(store: w.store, keys: gated, vault: w.vault, policy: w.policy, deriver: w.deriver)
        // An older key A in memory; the key in use (and the mail's kid) is the vector's.
        let older = P256.KeyAgreement.PrivateKey()
        let olderKey = OpenedKey(userID: FakeSupabase.me, recipient: PrivateRecipient(keyID: KeyWrap.keyIDOf(older.publicKey.x963Representation), publicKey: older.publicKey.x963Representation, privateKey: older))
        let stamp = try #require(w.store.stamp())
        w.store.put(olderKey, stamp: stamp)
        let gate = Gate()
        gated.holdNext(on: gate)
        let opening = Task { await model.recipient(forKid: w.v.keyID) }
        #expect(await waitFor(.seconds(3)) { gated.reads == 1 })
        // Meanwhile the password opens the key in use (memory and the Keychain).
        #expect(await model.submit(password: w.v.passphrase, email: UnlockWorld.email))
        #expect(w.store.key?.keyID == w.v.keyID)
        #expect(w.vaultCount == 1)
        gate.open()
        let outcome = await opening.value
        #expect(outcome == .key(try #require(w.store.key)))
        #expect(w.store.key?.keyID == w.v.keyID)
        #expect(w.vaultCount == 1)
    }

    // MARK: A2-1: Face ID's ask of an ended front period

    @Test func aKeyOfALaterFrontPeriodAsksFaceIDAgain() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        let gate = Gate()
        w.keychain.holdReads(on: gate)
        let first = Task { await w.model.key() }
        #expect(await waitFor(.seconds(3)) { await MainActor.run { w.model.phase == .askingBiometrics } })
        // The background, then back in front: a new period. Its key() asks Face ID itself.
        w.store.wentToBackground()
        let second = Task { await w.model.key() }
        try? await Task.sleep(for: .milliseconds(100))
        gate.open()
        #expect(await first.value == nil)
        let key = await second.value
        #expect(key?.keyID == w.v.keyID)
        #expect(w.store.key?.keyID == w.v.keyID)
    }

    // MARK: S4 / N5: the words

    @Test func theOldKeyAndWrongPasswordWordsAreTheWebs() {
        #expect(UnlockModel.oldKeyText == "前の鍵で暗号化したメールです。開けません。")
        #expect(SettingsModel.oldKeyText(2) == "前の鍵で暗号化したメールが 2 通あります。開けませんが、荷物は残っています。")
        #expect(UnlockModel.wrongPassphraseText == "パスワードが違います。")
        #expect(!UnlockModel.oldKeyText.contains("開けます"))
        #expect(!SettingsModel.oldKeyText(2).contains("開けます。"))
    }

    // MARK: N1: no status is network

    @Test func aSignInAnswerThatIsNotSupabasesIsTheNetworkWords() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: Self.password))
        await fake.fail(where: { $0.url.path.hasSuffix("/token") }, with: .gateway(200, body: "<html>maintenance</html>", contentType: "text/html", applied: false))
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.network) {
            try await auth.signIn(email: FakeSupabase.email, password: Self.password, captchaToken: nil)
        }
    }

    // MARK: N6: the resend is for the address it was offered for

    @Test func changingTheAddressDropsTheResend() async {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: Self.password), confirmed: false)
        let model = LoginModel(auth: PW.auth(fake), launch: LaunchOptions(arguments: ["Otodoke"]))
        model.email = FakeSupabase.email
        model.password = Self.password
        await model.submit()
        #expect(model.canResendConfirmation)
        // The same address as typed differently (email_norm) keeps it.
        model.email = "  " + FakeSupabase.email.uppercased()
        #expect(model.canResendConfirmation)
        model.email = "someone.else@example.com"
        #expect(!model.canResendConfirmation)
        await model.resendConfirmation()
        #expect(await fake.count("POST", "resend") == 0)
    }
}

/// A value set from a closure (MainActor tests only).
@MainActor
final class Box<T> {
    var value: T?
}

/// MailKeyReading whose next key read can be held on a Gate; every read answers `row`.
final class GatedKeyReads: MailKeyReading, @unchecked Sendable {
    private let lock = NSLock()
    private let row: StoredKeyRow
    private var gate: Gate?
    private var count = 0

    init(row: StoredKeyRow) { self.row = row }

    func holdNext(on gate: Gate) { lock.withLock { self.gate = gate } }
    var reads: Int { lock.withLock { count } }

    func currentKey() async -> LoadResult<StoredKeyRow?> {
        let waitOn: Gate? = lock.withLock {
            count += 1
            defer { gate = nil }
            return gate
        }
        if let waitOn { await waitOn.wait() }
        return .loaded(row)
    }

    func envelope(emailID: String) async -> LoadResult<Data?> { .loaded(nil) }
}

/// A host whose /api/keys/* answers a 302 to /landing (which answers ok), recording the paths asked.
final class RedirectingProtocol: URLProtocol, @unchecked Sendable {
    static let host = "redirect.keys.test"
    nonisolated(unsafe) private static var asked: [String] = []
    private static let lock = NSLock()

    static func reset() { lock.withLock { asked = [] } }
    static var paths: [String] { lock.withLock { asked } }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == host }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url else { return }
        Self.lock.withLock { Self.asked.append(url.path) }
        if url.path.hasPrefix("/api/keys/") {
            let target = URL(string: "https://\(Self.host)/landing")!
            let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: "HTTP/1.1", headerFields: ["Location": target.absoluteString])!
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data())
            client?.urlProtocolDidFinishLoading(self)
        } else {
            let body = Data(#"{"ok":true,"keyId":"0123456789abcdef0123456789abcdef"}"#.utf8)
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        }
    }

    override func stopLoading() {}
}
