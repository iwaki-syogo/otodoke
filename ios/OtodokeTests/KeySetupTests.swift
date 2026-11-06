import CryptoKit
import Foundation
import Testing
@testable import Otodoke

/// [password-login] The key after a password sign-in (docs/api/keys.md "Order", integrate/password-v1 3449af0),
/// against FakeKeysServer (the Web's endpoints) writing into FakeSupabase (read back through PostgREST):
///  - no key in use: register (expectedCurrentKeyId null, exactly keys.md's fields, Bearer = the session's access
///    token) → the pending row read back by key_id and opened → the challenge opened → activate → in memory and
///    kept with Face ID;
///  - a key in use: opened with the KEK of the sign-in's master, no register; in memory and kept with Face ID;
///  - 409 key_in_use_changed (another device made it first): the key in use is read and opened;
///  - every other result code ends in its words with nothing in memory; nothing is activated when the read-back
///    row or the challenge does not open;
///  - two runs at once make one key; a sign-out (or another account, or the background) meanwhile keeps nothing;
///  - no request carries the password, master or auth_secret.
@Suite("Password login: the key after sign-in (password-login)")
@MainActor
struct KeySetupTests {
    /// A world signed in as `me` through supabase-swift itself (not the app's new code).
    struct World {
        let fake: FakeSupabase
        let server: FakeKeysServer
        let auth: AuthService
        let keychain: FakeKeychain
        let biometrics: FakeBiometrics
        let policy: KeyStorePolicy
        let vault: KeyVault
        let store: OpenKeyStore
        let setup: KeySetup
        let master: Data

        static let service = "com.iwakisyogo.otodoke.auth"

        @MainActor
        init(availability: BiometricAvailability = .available(.faceID)) async throws {
            fake = FakeSupabase.make()
            server = FakeKeysServer.make(supabase: fake)
            await fake.addPasswordAccount(email: FakeSupabase.email, secret: "s")
            auth = PW.auth(fake)
            try await auth.provider.auth.signIn(email: FakeSupabase.email, password: "s")
            await auth.start()
            keychain = FakeKeychain()
            biometrics = FakeBiometrics(availability)
            policy = KeyStorePolicy(defaults: scratchDefaults())
            vault = KeyVault(keychain: keychain, biometrics: biometrics, policy: policy, service: Self.service)
            store = OpenKeyStore(session: auth.session, vault: vault)
            let reader = MailKeyReader(provider: auth.provider)
            let provider = auth.provider
            setup = KeySetup(
                store: store,
                keys: reader,
                pending: reader,
                api: KeyAPIClient(baseURL: server.baseURL, session: server.urlSession),
                vault: vault,
                policy: policy,
                accessToken: { try? await provider.auth.session.accessToken }
            )
            master = Data((0..<32).map { UInt8($0 &* 7 &+ 3) })
        }

        var signIn: PasswordSignIn { PasswordSignIn(userID: FakeSupabase.me, email: FakeSupabase.email, master: master) }

        var vaultCount: Int { keychain.count(service: Self.service) }

        /// A key in use for `me`, wrapped with the KEK of `master` (made with the vectors-pinned KeyGeneration).
        func plantKeyInUse(master: Data? = nil) async throws -> String {
            let made = try KeyGeneration.generate(master: master ?? self.master, userID: FakeSupabase.me)
            let row = made.row
            await fake.insert("user_keys", [[
                    "user_id": .string(FakeSupabase.me),
                    "key_id": .string(row.keyID),
                    "public_key": .string(row.publicKey),
                    "wrapped_private_key": .string(row.wrappedPrivateKey),
                    "wrap_iv": .string(row.wrapIv),
                    "kdf_salt": .string(row.kdfSalt),
                    "kdf_iterations": 600_000,
                    "activated_at": "2026-11-06T00:00:00.000000+00:00",
                    "retired_at": nil,
                ]])
            return row.keyID
        }

        func keysInUse() async -> [Row] {
            await fake.rows("user_keys").filter { isSet($0["activated_at"]) && !isSet($0["retired_at"]) }
        }
    }

    // MARK: the first key

    @Test func noKeyMakesOneRegistersReadsItBackAndActivates() async throws {
        let w = try await World()
        let outcome = await w.setup.run(w.signIn)
        #expect(await w.server.count("register") == 1)
        #expect(await w.server.count("activate") == 1)
        let inUse = await w.keysInUse()
        #expect(inUse.count == 1)
        let keyID = try #require(inUse.first?["key_id"]?.text)
        #expect(outcome == .created(keyID: keyID))
        #expect(w.store.key?.keyID == keyID)
        #expect(w.vaultCount == 1)
        // The pending row was read back before activation (keys.md Order 5).
        let reads = await w.fake.requests("GET", "user_keys").map(\.url.absoluteString)
        #expect(reads.contains { $0.contains("key_id=eq.\(keyID)") && $0.contains("activated_at=is.null") && $0.contains("user_id=eq.\(FakeSupabase.me)") })
    }

    @Test func registerAndActivateCarryExactlyKeysMdsFields() async throws {
        let w = try await World()
        await w.setup.run(w.signIn)
        let register = try #require(await w.server.requests("register").first)
        let body = try #require(register.jsonDictionary)
        #expect(Set(body.keys) == FakeKeysServer.registerFields)
        #expect(body["kdfIterations"] as? Int == 600_000)
        #expect(body["expectedCurrentKeyId"] is NSNull)
        #expect(register.method == "POST")
        #expect(register.url.path == "/api/keys/register")
        let token = try await w.auth.provider.auth.session.accessToken
        #expect(register.header("authorization") == "Bearer \(token)")
        #expect(register.header("content-type")?.hasPrefix("application/json") == true)
        let activate = try #require(await w.server.requests("activate").first)
        let a = try #require(activate.jsonDictionary)
        #expect(Set(a.keys) == FakeKeysServer.activateFields)
        #expect(a["expectedCurrentKeyId"] is NSNull)
        #expect(Data(base64Encoded: a["challenge"] as? String ?? "")?.count == 32)
        #expect(activate.url.path == "/api/keys/activate")
    }

    @Test func theKeyMadeOpensWithTheKEKOfTheSignInsMaster() async throws {
        let w = try await World()
        await w.setup.run(w.signIn)
        let row = try #require(await w.keysInUse().first)
        let stored = StoredKeyRow(
            keyId: row["key_id"]?.text ?? "",
            publicKey: row["public_key"]?.text ?? "",
            wrappedPrivateKey: row["wrapped_private_key"]?.text ?? "",
            wrapIv: row["wrap_iv"]?.text ?? "",
            kdfSalt: row["kdf_salt"]?.text ?? "",
            kdfIterations: 600_000,
            activatedAt: row["activated_at"]?.text,
            retiredAt: nil
        )
        let opened = try PasswordV1.openStoredKey(stored, master: w.master, userID: FakeSupabase.me)
        #expect(opened.keyID == stored.keyId)
    }

    @Test func noRequestCarriesThePasswordMasterOrTheSecret() async throws {
        let w = try await World()
        await w.setup.run(w.signIn)
        let all = PW.text(await w.server.requests) + PW.text(await w.fake.requests())
        #expect(!all.contains(CryptoBytes.toHex(w.master)))
        #expect(!all.contains(w.master.base64EncodedString()))
        #expect(!all.contains(PasswordV1.authSecret(master: w.master)))
        #expect(await w.server.count("register") == 1)
    }

    // MARK: a key in use

    @Test func aKeyInUseIsOpenedWithoutRegistering() async throws {
        let w = try await World()
        let keyID = try await w.plantKeyInUse()
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .opened(keyID: keyID))
        #expect(await w.server.count("register") == 0)
        #expect(w.store.key?.keyID == keyID)
        #expect(w.vaultCount == 1)
    }

    @Test func aKeyInUseThatDoesNotOpenKeepsNothingAndRegistersNothing() async throws {
        let w = try await World()
        _ = try await w.plantKeyInUse(master: Data(repeating: 9, count: 32))
        let outcome = await w.setup.run(w.signIn)
        // The key in use was read (and did not open): no new key over it.
        #expect(await w.fake.count("GET", "user_keys") >= 1)
        #expect(await w.server.count("register") == 0)
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
        if case .failed = outcome {} else { Issue.record("expected .failed, got \(outcome)") }
    }

    @Test func turnedOffItIsInMemoryButNotKept() async throws {
        let w = try await World()
        w.policy.turnOff()
        let outcome = await w.setup.run(w.signIn)
        if case .created = outcome {} else { Issue.record("expected .created, got \(outcome)") }
        #expect(w.store.key != nil)
        #expect(w.vaultCount == 0)
    }

    @Test func aDeviceWithoutFaceIDGoesOnInMemory() async throws {
        let w = try await World(availability: .notEnrolled)
        let outcome = await w.setup.run(w.signIn)
        if case .created = outcome {} else { Issue.record("expected .created, got \(outcome)") }
        #expect(w.store.key != nil)
        #expect(w.vaultCount == 0)
    }

    @Test func aKeyRowThatCannotBeReadMakesNoKey() async throws {
        let w = try await World()
        await w.fake.fail("GET", "user_keys", with: .http(500))
        let outcome = await w.setup.run(w.signIn)
        // A failed read is not "no key": nothing is registered over a key that may be in use.
        #expect(await w.fake.count("GET", "user_keys") == 1)
        #expect(await w.server.count("register") == 0)
        #expect(w.store.key == nil)
        if case .failed = outcome {} else { Issue.record("expected .failed, got \(outcome)") }
    }

    // MARK: another device first

    @Test func keyInUseChangedAtRegisterOpensTheKeyInUse() async throws {
        let w = try await World()
        // Another device puts a key in use (wrapped with the same password) just before this register.
        let other = try KeyGeneration.generate(master: w.master, userID: FakeSupabase.me).row
        let fake = w.fake
        await w.server.before("register") {
            await fake.insert("user_keys", [[
                "user_id": .string(FakeSupabase.me), "key_id": .string(other.keyID), "public_key": .string(other.publicKey),
                "wrapped_private_key": .string(other.wrappedPrivateKey), "wrap_iv": .string(other.wrapIv), "kdf_salt": .string(other.kdfSalt),
                "kdf_iterations": 600_000, "activated_at": "2026-11-06T00:00:00.000000+00:00", "retired_at": nil,
            ]])
        }
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .opened(keyID: other.keyID))
        #expect(await w.server.count("activate") == 0)
        #expect(w.store.key?.keyID == other.keyID)
    }

    @Test func keyInUseChangedAtActivateOpensTheKeyInUse() async throws {
        let w = try await World()
        let other = try KeyGeneration.generate(master: w.master, userID: FakeSupabase.me).row
        let fake = w.fake
        await w.server.before("activate") {
            await fake.insert("user_keys", [[
                "user_id": .string(FakeSupabase.me), "key_id": .string(other.keyID), "public_key": .string(other.publicKey),
                "wrapped_private_key": .string(other.wrappedPrivateKey), "wrap_iv": .string(other.wrapIv), "kdf_salt": .string(other.kdfSalt),
                "kdf_iterations": 600_000, "activated_at": "2026-11-06T00:00:00.000000+00:00", "retired_at": nil,
            ]])
        }
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .opened(keyID: other.keyID))
        #expect(w.store.key?.keyID == other.keyID)
        #expect(await w.keysInUse().count == 1)
    }

    // MARK: the result codes

    @Test(arguments: [
        ("register", 403, "stale_session", LoginText.staleSession),
        ("activate", 403, "stale_session", LoginText.staleSession),
        ("register", 401, "unauthorized", LoginText.signedOut),
        ("register", 400, "invalid_input", LoginText.invalidInput),
        ("activate", 409, "key_not_pending", LoginText.keyNotPending),
        ("activate", 422, "key_challenge_failed", LoginText.keyChallengeFailed),
        ("register", 500, "key_failed", LoginText.keyFailed),
        ("register", 503, "unavailable", LoginText.network),
    ])
    func eachResultCodeHasItsWordsAndKeepsNothing(endpoint: String, status: Int, code: String, words: String) async throws {
        let w = try await World()
        await w.server.force(endpoint, .answer(status: status, code: code))
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .failed(message: words))
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
        #expect(w.setup.lastOutcome == outcome)
    }

    @Test func noAnswerIsTheNetworkWords() async throws {
        let w = try await World()
        await w.server.force("register", .transport(.notConnectedToInternet))
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .failed(message: LoginText.network))
        #expect(await w.server.count("register") == 1)
    }

    @Test func eachCodeHasTheWebsWords() {
        #expect(KeyAPIFailure.staleSession.message == "続けるには、もう一度ログインしてください。")
        #expect(KeyAPIFailure.unauthorized.message == "ログインし直してください。")
        #expect(KeyAPIFailure.keyNotPending.message == "もう一度、最初からお試しください。")
        #expect(KeyAPIFailure.keyChallengeFailed.message == "鍵を確かめられませんでした。もう一度お試しください。")
        #expect(KeyAPIFailure.keyFailed.message == "保存できませんでした。もう一度お試しください。")
        #expect(KeyAPIFailure.unavailable.message == LoginText.network)
        #expect(KeyAPIFailure.network.message == LoginText.network)
        for failure in KeyAPIFailure.allCases {
            #expect(!failure.message.isEmpty, "\(failure)")
        }
    }

    // MARK: proving the new key before activating it

    @Test func aChallengeThatDoesNotOpenIsNotActivated() async throws {
        let w = try await World()
        await w.server.sealChallengeToAnotherKey()
        let outcome = await w.setup.run(w.signIn)
        #expect(await w.server.count("register") == 1)
        #expect(await w.server.count("activate") == 0)
        #expect(w.store.key == nil)
        if case .failed = outcome {} else { Issue.record("expected .failed, got \(outcome)") }
    }

    @Test func aStoredWrapThatDoesNotOpenIsNotActivated() async throws {
        let w = try await World()
        // The row read back is not the wrap the app sent (keys.md Order 5 proves it before activation).
        await w.fake.before("GET", "user_keys", nth: 2) { tables in
            var rows = tables["user_keys", default: []]
            for i in rows.indices where !isSet(rows[i]["activated_at"]) {
                rows[i]["wrapped_private_key"] = .string(Data(repeating: 1, count: 154).base64EncodedString())
            }
            tables["user_keys"] = rows
        }
        let outcome = await w.setup.run(w.signIn)
        #expect(await w.server.count("register") == 1)
        #expect(await w.server.count("activate") == 0)
        #expect(w.store.key == nil)
        if case .failed = outcome {} else { Issue.record("expected .failed, got \(outcome)") }
    }

    @Test func theChallengeAADIsTheWebs() {
        #expect(KeyChallenge.aad(userID: FakeSupabase.me, keyID: "0123456789abcdef0123456789abcdef")
            == "otodoke/key-challenge/v1|\(FakeSupabase.me)|0123456789abcdef0123456789abcdef")
    }

    // MARK: one at a time, and the session

    @Test func twoRunsAtOnceMakeOneKey() async throws {
        let w = try await World()
        let gate = Gate()
        await w.server.hold("register", on: gate)
        let first = Task { await w.setup.run(w.signIn) }
        #expect(await waitFor(.seconds(3)) { await w.server.count("register") == 1 })
        let second = Task { await w.setup.run(w.signIn) }
        try? await Task.sleep(for: .milliseconds(100))
        gate.open()
        let a = await first.value
        let b = await second.value
        #expect(a == b)
        #expect(await w.server.count("register") == 1)
        #expect(await w.keysInUse().count == 1)
    }

    @Test func aSignOutDuringRegisterKeepsNothing() async throws {
        let w = try await World()
        let gate = Gate()
        await w.server.hold("register", on: gate)
        let run = Task { await w.setup.run(w.signIn) }
        #expect(await waitFor(.seconds(3)) { await w.server.count("register") == 1 })
        await w.auth.signOut()
        gate.open()
        let outcome = await run.value
        #expect(outcome == .stale)
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
        #expect(await w.server.count("activate") == 0)
    }

    @Test func theBackgroundDuringActivateKeepsNothing() async throws {
        let w = try await World()
        let gate = Gate()
        await w.server.hold("activate", on: gate)
        let run = Task { await w.setup.run(w.signIn) }
        #expect(await waitFor(.seconds(3)) { await w.server.count("activate") == 1 })
        w.store.wentToBackground()
        gate.open()
        let outcome = await run.value
        #expect(outcome == .stale)
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
    }

    @Test func aSignInOfAnotherUserIsNotUsed() async throws {
        let w = try await World()
        let other = PasswordSignIn(userID: FakeSupabase.other, email: "b@example.com", master: w.master)
        let outcome = await w.setup.run(other)
        #expect(outcome == .stale)
        #expect(await w.server.requests.isEmpty)
        #expect(await w.fake.count("GET", "user_keys") == 0)
    }

    @Test func signedOutDoesNothing() async throws {
        let w = try await World()
        await w.auth.signOut()
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .stale)
        #expect(await w.server.requests.isEmpty)
    }
}
