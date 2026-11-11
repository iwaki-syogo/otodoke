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

@Suite("Native account deletion")
@MainActor
struct AccountDeletionTests {
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
        let screens = MainScreens.live(auth: auth, withKeys: false)
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
