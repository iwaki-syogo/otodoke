import Foundation
import Testing
@testable import Otodoke

actor DeletionStub: AccountDeleting {
    var calls = 0
    var failure: AccountAPIFailure?
    var gate: Gate?
    func configure(failure: AccountAPIFailure? = nil, gate: Gate? = nil) { self.failure = failure; self.gate = gate }
    func deleteAccount(accessToken: String) async throws(AccountAPIFailure) {
        calls += 1
        if let gate { await gate.wait() }
        if let failure { throw failure }
    }
}

/// The deletion happened, its response was lost, and the same Bearer is refused on the next POST.
private actor LostDeletionReplyServer {
    private(set) var requests: [StubRequest] = []
    private(set) var deletionApplied = false

    func answer(_ request: StubRequest) -> StubReply {
        requests.append(request)
        guard request.method == "POST", request.path == "/api/account/delete",
              request.jsonDictionary as? [String: String] == ["confirm": "delete-account"] else {
            return .json(400, ["ok": false, "code": "invalid_input"])
        }
        if !deletionApplied {
            deletionApplied = true
            return .failure(.networkConnectionLost)
        }
        return .json(401, ["ok": false, "code": "unauthorized"])
    }
}

@Suite("Native account deletion")
@MainActor
struct AccountDeletionTests {
    private struct LocalAccount {
        let auth: AuthService
        let storage: InMemorySessionStorage
        let screens: MainScreens
        let keys: OpenKeyStore
        let keychain: FakeKeychain
        let service: String
    }

    private func localAccount() async throws -> LocalAccount {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped"])])
        let storage = InMemorySessionStorage()
        let (_, auth) = try await TestSession.signedIn(fake, storage: storage)
        #expect(!storage.isEmpty)
        let screens = MainScreens.live(auth: auth, readingConsent: .allowedForTests(), withKeys: false)
        let keychain = FakeKeychain()
        let service = "test.account-delete-retry." + UUID().uuidString
        let policy = KeyStorePolicy(defaults: scratchDefaults())
        let vault = KeyVault(keychain: keychain, biometrics: FakeBiometrics(.available(.faceID)), policy: policy, service: service)
        let keys = OpenKeyStore(session: auth.session, vault: vault)
        let generated = try KeyGeneration.generate(master: Data(repeating: 7, count: 32), userID: FakeSupabase.me)
        let stamp = try #require(keys.stamp())
        #expect(keys.put(OpenedKey(userID: FakeSupabase.me, recipient: generated.recipient), stamp: stamp))
        keychain.plant(KeychainItem(service: service, account: KeyVault.account, accessibility: .whenPasscodeSetThisDeviceOnly,
                                   biometryCurrentSet: true, synchronizable: false, userID: FakeSupabase.me, keyID: generated.row.keyID),
                       secret: generated.recipient.privateKey.rawRepresentation)
        auth.cleanup = keys
        auth.clearLoadedData = { screens.clearForSignOut() }
        await screens.list.load(); await screens.calendar.load(); await screens.spend.load(); await screens.settings.load()
        return LocalAccount(auth: auth, storage: storage, screens: screens, keys: keys, keychain: keychain, service: service)
    }

    private func expectLocalAccountRetained(_ local: LocalAccount) {
        #expect(local.auth.state != .signedOut)
        #expect(local.auth.provider.auth.currentSession != nil)
        #expect(!local.storage.isEmpty)
        #expect(local.keys.key != nil)
        #expect(local.keychain.count(service: local.service) == 1)
        #expect(!local.screens.list.rows.isEmpty)
    }

    @Test(arguments: [false, true])
    func aLostDeleteReplyThenUnauthorizedClearsTheRealLocalAccount(reopenConfirmation: Bool) async throws {
        let local = try await localAccount()
        let stamp = try #require(local.auth.session.stamp())
        let host = UUID().uuidString.lowercased() + ".supabase.test"
        let server = LostDeletionReplyServer()
        StubURLProtocol.register(host: host) { await server.answer($0) }
        defer { StubURLProtocol.unregister(host: host) }
        let client = AccountAPIClient(baseURL: URL(string: "https://\(host)")!, session: StubURLProtocol.makeSession())
        var completions = 0
        let model = AccountDeletionModel(
            api: client,
            accessToken: { try? await local.auth.provider.auth.session.accessToken },
            isCurrent: { local.auth.session.isCurrent(stamp) },
            completed: { completions += 1; await local.auth.signOut() }
        )
        model.showConfirmation()
        await model.deleteAccount()
        #expect(await server.deletionApplied)
        #expect(await server.requests.count == 1)
        #expect(completions == 0)
        #expect(model.message == AccountDeletionText.failed)
        expectLocalAccountRetained(local)

        if reopenConfirmation {
            model.cancel()
            await model.deleteAccount()
            #expect(await server.requests.count == 1)
            #expect(completions == 0)
            model.showConfirmation()
        }
        await model.deleteAccount()
        let sent = await server.requests
        #expect(sent.count == 2)
        #expect(sent.allSatisfy { $0.method == "POST" && $0.path == "/api/account/delete" })
        #expect(sent.allSatisfy { $0.jsonDictionary as? [String: String] == ["confirm": "delete-account"] })
        #expect(completions == 1)
        #expect(model.message == nil)
        #expect(!model.isDeleting)
        #expect(local.auth.state == .signedOut)
        #expect(local.auth.provider.auth.currentSession == nil)
        #expect(local.storage.isEmpty)
        #expect(local.keys.key == nil)
        #expect(local.keychain.count(service: local.service) == 0)
        #expect(local.screens.list.rows.isEmpty)
        #expect(local.screens.calendar.byDay == nil)
        #expect(local.screens.spend.parcels == nil)
        #expect(local.screens.settings.keyPanel == nil)
        await local.screens.list.load(); await local.screens.spend.load(); await local.screens.settings.load()
        #expect(local.screens.list.rows.isEmpty)
        #expect(local.screens.spend.parcels == nil)
    }

    @Test func anUnauthorizedAPIReplyIsAlreadyAfterTheConfirmedPOST() async throws {
        let host = UUID().uuidString.lowercased() + ".supabase.test"
        actor Requests {
            var values: [StubRequest] = []
            func add(_ request: StubRequest) { values.append(request) }
        }
        let requests = Requests()
        StubURLProtocol.register(host: host) { request in
            await requests.add(request)
            return .json(401, ["ok": false, "code": "unauthorized"])
        }
        defer { StubURLProtocol.unregister(host: host) }
        let api = AccountAPIClient(baseURL: URL(string: "https://\(host)")!, session: StubURLProtocol.makeSession())
        var completions = 0
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, completed: { completions += 1 })
        model.showConfirmation()
        await model.deleteAccount()
        let sent = await requests.values
        let request = try #require(sent.first)
        #expect(sent.count == 1)
        #expect(request.method == "POST")
        #expect(request.path == "/api/account/delete")
        #expect(request.jsonDictionary as? [String: String] == ["confirm": "delete-account"])
        #expect(completions == 1)
        #expect(model.message == nil)
    }

    @Test(arguments: [false, true])
    func anUnconfirmedOrCancelledDeletionNeverReachesAnUnauthorizedAPI(cancel: Bool) async {
        let api = DeletionStub()
        await api.configure(failure: .unauthorized)
        var completed = false
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, completed: { completed = true })
        if cancel { model.showConfirmation(); model.cancel() }
        await model.deleteAccount()
        #expect(await api.calls == 0)
        #expect(!completed)
        #expect(model.message == nil)
    }

    @Test(arguments: [false, true])
    func aMissingTokenNeverCompletesEvenAfterAnEarlierLostReply(sentEarlier: Bool) async {
        let api = DeletionStub()
        var token: String? = "test-token"
        var completed = false
        let model = AccountDeletionModel(api: api, accessToken: { token }, completed: { completed = true })
        model.showConfirmation()
        if sentEarlier {
            await api.configure(failure: .network)
            await model.deleteAccount()
        }
        token = nil
        await api.configure(failure: .unauthorized)
        await model.deleteAccount()
        #expect(await api.calls == (sentEarlier ? 1 : 0))
        #expect(!completed)
        #expect(model.message == LoginText.signedOut)
        #expect(!model.isDeleting)
    }

    @Test(arguments: [AccountAPIFailure.network, .deleteFailed, .unavailable, .invalidInput])
    func aFailureWithoutUnauthorizedKeepsTheRealLocalAccount(_ failure: AccountAPIFailure) async throws {
        let local = try await localAccount()
        let api = DeletionStub()
        await api.configure(failure: failure)
        var completions = 0
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, completed: {
            completions += 1
            await local.auth.signOut()
        })
        model.showConfirmation()
        await model.deleteAccount()
        #expect(await api.calls == 1)
        #expect(completions == 0)
        #expect(model.confirming)
        #expect(model.message == AccountDeletionText.failed)
        expectLocalAccountRetained(local)
    }

    @Test(arguments: [FakeSupabase.me, FakeSupabase.other])
    func aLateUnauthorizedNeverCompletesAfterTheSignInGenerationChanges(_ nextUser: String) async throws {
        let session = SessionGeneration()
        session.follow(userID: FakeSupabase.me)
        let stamp = try #require(session.stamp())
        let api = DeletionStub()
        var completions = 0
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, isCurrent: {
            session.isCurrent(stamp)
        }, completed: { completions += 1 })
        model.showConfirmation()
        await api.configure(failure: .network)
        await model.deleteAccount()
        let gate = Gate()
        await api.configure(failure: .unauthorized, gate: gate)
        let run = Task { await model.deleteAccount() }
        #expect(await waitFor { await api.calls == 2 })
        #expect(model.isDeleting)
        session.advance()
        session.follow(userID: nextUser)
        gate.open()
        await run.value
        #expect(completions == 0)
        #expect(model.message == nil)
        #expect(!model.isDeleting)
        #expect(session.stamp()?.userID == nextUser)
    }

    @Test func aGenerationChangeDuringTokenLookupSendsNothingAndNeverCompletes() async throws {
        let session = SessionGeneration()
        session.follow(userID: FakeSupabase.me)
        let stamp = try #require(session.stamp())
        let gate = Gate(), api = DeletionStub()
        await api.configure(failure: .unauthorized)
        var completed = false
        let model = AccountDeletionModel(api: api, accessToken: {
            await gate.wait()
            return "old-token"
        }, isCurrent: { session.isCurrent(stamp) }, completed: { completed = true })
        model.showConfirmation()
        let run = Task { await model.deleteAccount() }
        #expect(await waitFor { await model.isDeleting })
        session.advance()
        session.follow(userID: FakeSupabase.other)
        gate.open()
        await run.value
        #expect(await api.calls == 0)
        #expect(!completed)
        #expect(!model.isDeleting)
    }

    @Test func noDeletionBeforeConfirmationAndCancelDoesNothing() async {
        let api = DeletionStub()
        var completed = false
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, completed: { completed = true })
        await model.deleteAccount()
        #expect(await api.calls == 0)
        model.showConfirmation(); model.cancel(); await model.deleteAccount()
        #expect(await api.calls == 0)
        #expect(!completed)
    }

    @Test func successClearsTheAccountOnlyAfterTheAPIReturns() async {
        let api = DeletionStub(), gate = Gate()
        await api.configure(gate: gate)
        var completed = false
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, completed: { completed = true })
        model.showConfirmation()
        let run = Task { await model.deleteAccount() }
        for _ in 0..<100 where await api.calls == 0 { await Task.yield() }
        #expect(model.isDeleting); #expect(!completed)
        await model.deleteAccount(); model.cancel()
        #expect(await api.calls == 1)
        #expect(model.confirming)
        gate.open(); await run.value
        #expect(completed); #expect(!model.isDeleting)
    }

    @Test func failurePreservesTheAccountAndShowsTheWebWords() async {
        let api = DeletionStub()
        await api.configure(failure: .deleteFailed)
        var completed = false
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, completed: { completed = true })
        model.showConfirmation(); await model.deleteAccount()
        #expect(!completed)
        #expect(model.confirming)
        #expect(model.message == AccountDeletionText.failed)
    }

    @Test func noSessionSendsNothingAndStaleSuccessDoesNotSignOutAnotherAccount() async {
        let api = DeletionStub()
        let missing = AccountDeletionModel(api: api, accessToken: { nil }, completed: {})
        missing.showConfirmation(); await missing.deleteAccount()
        #expect(await api.calls == 0); #expect(missing.message == LoginText.signedOut)
        let gate = Gate()
        await api.configure(gate: gate)
        var current = true, completed = false
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, isCurrent: { current }, completed: { completed = true })
        model.showConfirmation()
        let run = Task { await model.deleteAccount() }
        for _ in 0..<100 where await api.calls == 0 { await Task.yield() }
        current = false; gate.open(); await run.value
        #expect(!completed)
    }

    @Test func clientSendsOnlyTheConfirmationAndValidatesJSONTrue() async throws {
        let host = UUID().uuidString.lowercased() + ".supabase.test"
        let session = StubURLProtocol.makeSession()
        let client = AccountAPIClient(baseURL: URL(string: "https://\(host)")!, session: session)
        actor Requests { var values: [StubRequest] = []; func add(_ value: StubRequest) { values.append(value) } }
        let requests = Requests()
        StubURLProtocol.register(host: host) { request in await requests.add(request); return .json(200, ["ok": true]) }
        defer { StubURLProtocol.unregister(host: host) }
        try await client.deleteAccount(accessToken: "test-token")
        let request = try #require(await requests.values.first)
        #expect(request.method == "POST"); #expect(request.path == "/api/account/delete")
        #expect(request.header("authorization") == "Bearer test-token")
        #expect(request.jsonDictionary as? [String: String] == ["confirm": "delete-account"])
        StubURLProtocol.register(host: host) { _ in .json(200, ["ok": 1]) }
        await #expect(throws: AccountAPIFailure.network) { try await client.deleteAccount(accessToken: "test-token") }
        #expect(await requests.values.count == 1)
    }

    @Test func successfulDeletionClearsLoadedScreensAndSessionWhileFailureKeepsThem() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped"])])
        let (_, auth) = try await TestSession.signedIn(fake)
        let screens = MainScreens.live(auth: auth, readingConsent: .allowedForTests(), withKeys: false)
        let keychain = FakeKeychain()
        let service = "test.account-delete." + UUID().uuidString
        let policy = KeyStorePolicy(defaults: scratchDefaults())
        let vault = KeyVault(keychain: keychain, biometrics: FakeBiometrics(.available(.faceID)), policy: policy, service: service)
        let keys = OpenKeyStore(session: auth.session, vault: vault)
        let generated = try KeyGeneration.generate(master: Data(repeating: 7, count: 32), userID: FakeSupabase.me)
        let stamp = try #require(keys.stamp())
        #expect(keys.put(OpenedKey(userID: FakeSupabase.me, recipient: generated.recipient), stamp: stamp))
        keychain.plant(KeychainItem(service: service, account: KeyVault.account, accessibility: .whenPasscodeSetThisDeviceOnly, biometryCurrentSet: true, synchronizable: false, userID: FakeSupabase.me, keyID: generated.row.keyID), secret: generated.recipient.privateKey.rawRepresentation)
        auth.cleanup = keys
        // This test owns the screen generation without installing real biometrics/keychain.
        auth.clearLoadedData = { screens.clearForSignOut() }
        await screens.list.load(); await screens.calendar.load(); await screens.spend.load(); await screens.settings.load()
        #expect(!screens.list.rows.isEmpty)
        let api = DeletionStub()
        let model = AccountDeletionModel(api: api, accessToken: { "test-token" }, completed: { await auth.signOut() })
        await api.configure(failure: .deleteFailed)
        model.showConfirmation(); await model.deleteAccount()
        #expect(!screens.list.rows.isEmpty)
        #expect(auth.state != .signedOut)
        #expect(keys.key != nil && keychain.count(service: service) == 1)
        await api.configure()
        await model.deleteAccount()
        #expect(auth.state == .signedOut)
        #expect(auth.provider.auth.currentSession == nil)
        #expect(keys.key == nil && keychain.count(service: service) == 0)
        #expect(screens.list.rows.isEmpty)
        #expect(screens.calendar.byDay == nil)
        #expect(screens.spend.parcels == nil)
        #expect(screens.settings.keyPanel == nil)
        await screens.list.load(); await screens.spend.load(); await screens.settings.load()
        #expect(screens.list.rows.isEmpty); #expect(screens.spend.parcels == nil)
    }
}
