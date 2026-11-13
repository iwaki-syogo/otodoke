import Foundation
import Testing
@testable import Otodoke

/// A session storage whose reads can fail or come back empty without any auth event.
final class StallFlakyStorage: SessionStorage, @unchecked Sendable {
    enum Mode: String, Sendable, CaseIterable {
        case reads
        case throwsOnRead
        case hidden
    }

    private let lock = NSLock()
    private let inner = InMemorySessionStorage()
    private var mode = Mode.reads
    private var removeFails = false
    private var removes = 0

    func setMode(_ new: Mode) { lock.withLock { mode = new } }
    func store(key: String, value: Data) throws { try inner.store(key: key, value: value) }
    func setRemoveFails(_ on: Bool) { lock.withLock { removeFails = on } }
    var removeCalls: Int { lock.withLock { removes } }
    var isEmpty: Bool { inner.isEmpty }

    func remove(key: String) throws {
        let fails: Bool = lock.withLock { removes += 1; return removeFails }
        if fails { throw URLError(.cannotRemoveFile) }
        try inner.remove(key: key)
    }

    func retrieve(key: String) throws -> Data? {
        switch lock.withLock({ mode }) {
        case .reads: return try inner.retrieve(key: key)
        case .throwsOnRead: throw URLError(.cannotOpenFile)
        case .hidden: return nil
        }
    }
}

/// A signed-in person whose settings model was made for the current generation.
@MainActor
struct StallWorld {
    let fake: FakeSupabase
    let storage: StallFlakyStorage
    let auth: AuthService
    let model: SettingsModel
    let stamp: SessionStamp

    static func make(changes: DataChanges? = nil) async throws -> StallWorld {
        let fake = FakeSupabase.make()
        let storage = StallFlakyStorage()
        let provider = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: storage)
        _ = try await provider.auth.verifyOTP(email: FakeSupabase.email, token: FakeSupabase.goodCode, type: .email)
        let auth = AuthService(provider: provider, userDefaults: TestDefaults.fresh())
        await auth.checkSession()
        let stamp = try #require(auth.session.stamp())
        let model = SettingsModel.live(auth: auth, changes: changes)
        return StallWorld(fake: fake, storage: storage, auth: auth, model: model, stamp: stamp)
    }

    /// The first load happens while the stored session cannot be read, with no auth event.
    func loadWhileStorageFails(_ mode: StallFlakyStorage.Mode) async {
        storage.setMode(mode)
        await model.load()
    }

    func requestCount() async -> Int { await fake.requests().count }
    func readCount() async -> Int { await fake.restRequests().count }
}

let stallFailingModes: [StallFlakyStorage.Mode] = [.throwsOnRead, .hidden]

@Suite("Settings identity stall")
@MainActor
struct SettingsIdentityStallTests {
    @Test(arguments: stallFailingModes)
    func aCurrentGenerationWithUnreadableStorageShowsTheFailedPanel(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await StallWorld.make()
        let before = await w.requestCount()

        await w.loadWhileStorageFails(mode)

        #expect(w.auth.session.isCurrent(w.stamp))
        #expect(w.model.keyPanel == .failed)
        #expect(await w.requestCount() == before)
        #expect(w.model.address == nil && w.model.unread == nil)
        #expect(w.model.unreadReasons == nil && w.model.dropped == nil)
    }

    @Test(arguments: stallFailingModes)
    func theNextAppearanceReadsAgainOnceAndDoesNotSpin(_ mode: StallFlakyStorage.Mode) async throws {
        let changes = DataChanges()
        let w = try await StallWorld.make(changes: changes)
        await w.loadWhileStorageFails(mode)
        #expect(w.model.keyPanel == .failed)

        // Nothing moved: no read starts by itself, however long we wait.
        let started = w.model.debugLoadsStarted
        for _ in 0..<5 { await Task.yield() }
        #expect(w.model.debugLoadsStarted == started)

        // An appearance, a pull and a DataChanges publish each start exactly one read.
        await w.model.onAppear()
        #expect(w.model.debugLoadsStarted == started + 1)
        await w.model.load()
        #expect(w.model.debugLoadsStarted == started + 2)
        changes.publish()
        for _ in 0..<5 { await Task.yield() }
        #expect(w.model.debugLoadsStarted == started + 2)
        await w.model.onAppear()
        #expect(w.model.debugLoadsStarted == started + 3)
        for _ in 0..<5 { await Task.yield() }
        #expect(w.model.debugLoadsStarted == started + 3)

        // Still unreadable: one appearance ends with the failed panel and reads nothing by itself.
        let before = await w.requestCount()
        await w.model.onAppear()
        #expect(w.model.keyPanel == .failed)
        try await Task.sleep(for: .milliseconds(200))
        #expect(await w.requestCount() == before)

        // Readable again: the next appearance reads, once.
        w.storage.setMode(.reads)
        let readsBefore = await w.readCount()
        await w.model.onAppear()
        let panel = try #require(w.model.keyPanel)
        #expect(panel != .failed)
        let readsPerLoad = await w.readCount() - readsBefore
        #expect(readsPerLoad > 0)

        // A shown tab does not read again until something moves.
        await w.model.onAppear()
        try await Task.sleep(for: .milliseconds(200))
        #expect(await w.readCount() == readsBefore + readsPerLoad)
    }

    @Test(arguments: stallFailingModes)
    func pullingToRefreshRecoversOnceTheStorageReadsAgain(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await StallWorld.make()
        await w.loadWhileStorageFails(mode)
        #expect(w.model.keyPanel == .failed)

        w.storage.setMode(.reads)
        await w.model.load()

        let panel = try #require(w.model.keyPanel)
        #expect(panel != .failed)
        #expect(w.model.unread != nil)
    }

    @Test(arguments: stallFailingModes)
    func deletingTheAccountAndStoppingReadingFromTheFailedPanelSendNothing(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await StallWorld.make()
        await w.loadWhileStorageFails(mode)
        #expect(w.model.keyPanel == .failed)
        let before = await w.requestCount()

        w.model.accountDeletion.showConfirmation()
        await w.model.accountDeletion.deleteAccount()
        let stopped = await w.model.chooseReadingConsent(false)

        #expect(w.model.accountDeletion.message == LoginText.signedOut)
        #expect(!w.model.accountDeletion.isDeleting)
        #expect(!stopped)
        #expect(w.model.readingConsent.message == AIReadingConsentText.saveFailed)
        #expect(await w.requestCount() == before)
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.auth.session.isCurrent(w.stamp))
        #expect(w.model.keyPanel == .failed)
    }

    @Test(arguments: stallFailingModes)
    func signingOutFromTheFailedPanelEndsTheGeneration(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await StallWorld.make()
        await w.loadWhileStorageFails(mode)
        #expect(w.model.keyPanel == .failed)

        await w.model.signOut()

        #expect(w.auth.state == .signedOut)
        #expect(RootScreen.of(w.auth.state) == .login)
        #expect(!w.auth.session.isCurrent(w.stamp) && w.auth.session.stamp() == nil)
        #expect(!w.model.isSigningOut)
    }

    @Test(arguments: StallFlakyStorage.Mode.allCases)
    func anOldModelAfterSignOutStaysEmptyWhateverTheStorageSays(_ mode: StallFlakyStorage.Mode) async throws {
        let w = try await StallWorld.make()
        await w.auth.signOut()
        #expect(!w.auth.session.isCurrent(w.stamp))
        w.storage.setMode(mode)
        let before = await w.requestCount()

        await w.model.load()
        await w.model.onAppear()

        #expect(w.model.keyPanel == nil)
        #expect(w.model.address == nil && w.model.unread == nil)
        #expect(await w.requestCount() == before)
    }
}
