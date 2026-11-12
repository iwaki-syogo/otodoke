import Foundation
import Testing
@testable import Otodoke

private actor DemoOwnerProbe {
    private(set) var requests: [StubRequest] = []
    func answer(_ request: StubRequest) -> Data {
        requests.append(request)
        return Data((request.path == "/api/demo/load" ? #"{"ok":true,"processed":5,"busy":true}"# : #"{"ok":true}"#).utf8)
    }
}

/// Installed on one session only. A route header isolates these fixed-origin requests from other tests.
private final class DemoOwnerURLProtocol: URLProtocol, @unchecked Sendable {
    private final class Registry: @unchecked Sendable {
        private let lock = NSLock()
        private var probes: [String: DemoOwnerProbe] = [:]
        func set(_ id: String, _ probe: DemoOwnerProbe?) { lock.withLock { probes[id] = probe } }
        func get(_ request: URLRequest) -> DemoOwnerProbe? {
            guard request.httpMethod == "POST", request.url?.host == AppConfig.webBase.host,
                  ["/api/demo/load", "/api/demo/clear"].contains(request.url?.path ?? ""),
                  let id = request.value(forHTTPHeaderField: "X-Test-Route") else { return nil }
            return lock.withLock { probes[id] }
        }
    }
    private static let registry = Registry()
    static func register(_ id: String, probe: DemoOwnerProbe) { registry.set(id, probe) }
    static func unregister(_ id: String) { registry.set(id, nil) }
    override class func canInit(with request: URLRequest) -> Bool { registry.get(request) != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private var work: Task<Void, Never>?

    override func startLoading() {
        let request = self.request
        guard let url = request.url, let probe = Self.registry.get(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL)); return
        }
        let headers = Dictionary((request.allHTTPHeaderFields ?? [:]).map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { _, last in last })
        let sent = StubRequest(method: request.httpMethod ?? "GET", url: url, headers: headers, body: Self.body(of: request), timeoutInterval: request.timeoutInterval)
        nonisolated(unsafe) let client = self.client
        nonisolated(unsafe) let loader: URLProtocol = self
        work = Task {
            let body = await probe.answer(sent)
            guard !Task.isCancelled else { return }
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(loader, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(loader, didLoad: body)
            client?.urlProtocolDidFinishLoading(loader)
        }
    }
    override func stopLoading() { work?.cancel() }
    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open(); defer { stream.close() }
        var body = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            body.append(buffer, count: count)
        }
        return body
    }
}

@MainActor
private struct DemoOwnerWorld {
    static let otherEmail = "other@example.com"
    let fake: FakeSupabase
    let storage: InMemorySessionStorage
    let auth: AuthService
    let screens: MainScreens
    let demo: DemoModel
    let probe: DemoOwnerProbe
    let route: String

    init(startEvents: Bool, refreshGate: Gate? = nil) async throws {
        let fake = FakeSupabase.make(), storage = InMemorySessionStorage(), probe = DemoOwnerProbe()
        let route = UUID().uuidString
        DemoOwnerURLProtocol.register(route, probe: probe)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DemoOwnerURLProtocol.self, StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Test-Route": route]
        let session = URLSession(configuration: configuration)
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: session, storage: storage), deriver: PW.fastDeriver())
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        await fake.addPasswordAccount(email: Self.otherEmail, secret: PW.secret(email: Self.otherEmail, password: PW.good), userID: FakeSupabase.other)
        if let refreshGate {
            await fake.setSessionLifetime(1)
            await fake.fail(where: { $0.method == "POST" && $0.path == "/auth/v1/token" && $0.query("grant_type") == ["refresh_token"] }, with: .delay(refreshGate))
        }
        auth.makeSignedIn = { MainScreens.live(auth: $0, readingConsent: .allowedForTests(), withKeys: false) }
        do {
            if startEvents { await auth.start() }
            try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        } catch {
            DemoOwnerURLProtocol.unregister(route); session.invalidateAndCancel(); throw error
        }
        let screens = try require_(auth.signedInObject() as? MainScreens)
        let demo = try require_(screens.settings.demo)
        self.fake = fake; self.storage = storage; self.auth = auth; self.screens = screens
        self.demo = demo; self.probe = probe; self.route = route
    }

    func switchToB(throughAuthService: Bool) async throws {
        await fake.setSessionLifetime(3600)
        await fake.setUserEmail(Self.otherEmail)
        if throughAuthService { try await auth.signIn(email: Self.otherEmail, password: PW.good, captchaToken: nil) }
        else { _ = try await auth.provider.auth.signIn(email: Self.otherEmail, password: PW.secret(email: Self.otherEmail, password: PW.good)) }
    }
    func storedSession() throws -> Data? { try storage.retrieve(key: SupabaseProvider.storageKey(for: fake.config)) }
    func close() { DemoOwnerURLProtocol.unregister(route); auth.provider.urlSession.invalidateAndCancel() }
}

@Suite("Demo token owner and generation")
@MainActor
struct DemoTokenOwnerTests {
    @Test(arguments: ["load", "clear"], [false, true])
    func theActualFactorySendsTheCurrentOwnersTokenIncludingAfterRefresh(_ action: String, _ refresh: Bool) async throws {
        let w = try await DemoOwnerWorld(startEvents: true)
        defer { w.close() }
        let stamp = try #require(w.auth.session.stamp())
        let first = try #require(w.auth.provider.auth.currentSession)
        if refresh { _ = try await w.auth.provider.auth.refreshSession() }
        let current = try #require(w.auth.provider.auth.currentSession)
        let version = w.screens.changes.version
        let bytes = try #require(try w.storedSession())
        if refresh { #expect(current.accessToken != first.accessToken) }

        if action == "load" { await w.demo.load() }
        else { #expect(await w.demo.clear(confirmed: true)) }

        let sent = await w.probe.requests
        let request = try #require(sent.first)
        #expect(sent.count == 1 && request.method == "POST" && request.path == "/api/demo/\(action)")
        #expect(request.header("authorization") == "Bearer \(current.accessToken)")
        #expect(await w.fake.userID(forAccessToken: current.accessToken) == FakeSupabase.me)
        if action == "load" {
            #expect(request.jsonDictionary?.isEmpty == true)
            #expect(w.demo.loadedCount == 1 && w.demo.clearedCount == 0 && w.demo.showsBusyNote)
            #expect(w.demo.notice == DemoModel.Notice())
        } else {
            #expect(request.jsonDictionary as? [String: String] == ["confirm": "yes"])
            #expect(w.demo.loadedCount == 0 && w.demo.clearedCount == 1 && !w.demo.showsBusyNote)
            #expect(w.demo.notice.cleared == DemoText.cleared && w.demo.notice.error == nil)
        }
        #expect(w.screens.changes.version == version + 1 && w.demo.phase == .idle)
        #expect(w.auth.session.isCurrent(stamp))
        #expect(w.auth.provider.auth.currentSession?.accessToken == current.accessToken)
        #expect(try w.storedSession() == bytes)
    }

    @Test(arguments: ["load", "clear"])
    func theActualSettingsFactoryCannotSendASDKOwnersTokenBeforeItsEventIsConsumed(_ action: String) async throws {
        let w = try await DemoOwnerWorld(startEvents: false)
        defer { w.close() }
        let stamp = try #require(w.auth.session.stamp())
        let version = w.screens.changes.version
        try await w.switchToB(throughAuthService: false)
        let current = try #require(w.auth.provider.auth.currentSession)
        let bytes = try #require(try w.storedSession())
        try #require(w.auth.state == .signedIn(userID: FakeSupabase.me) && w.auth.session.isCurrent(stamp))
        try #require(current.user.id.uuidString.lowercased() == FakeSupabase.other)

        if action == "load" { await w.demo.load() }
        else { #expect(await w.demo.clear(confirmed: true) == false) }

        #expect(await w.probe.requests.isEmpty)
        #expect(w.screens.changes.version == version)
        #expect(w.demo.loadedCount == 0 && w.demo.clearedCount == 0 && !w.demo.showsBusyNote)
        #expect(w.auth.provider.auth.currentSession?.accessToken == current.accessToken)
        #expect(try w.storedSession() == bytes)
    }

    @Test(arguments: ["load", "clear"])
    func aDiscardedRefreshAfterBSignsInCannotWriteAnOldDemoNotice(_ action: String) async throws {
        let release = Gate(), w = try await DemoOwnerWorld(startEvents: true, refreshGate: release)
        defer { release.open(); w.close() }
        let oldStamp = try #require(w.auth.session.stamp())
        let version = w.screens.changes.version
        var didClear = false
        let run = Task {
            if action == "load" { await w.demo.load() }
            else { didClear = await w.demo.clear(confirmed: true) }
        }
        try #require(await waitFor {
            let refreshes = await w.fake.requests("POST", "token").filter { $0.query("grant_type") == ["refresh_token"] }.count
            let phase = await w.demo.phase
            return refreshes == 1 && phase == (action == "load" ? .loading : .clearing)
        })
        #expect(w.demo.phase == (action == "load" ? .loading : .clearing))
        try await w.switchToB(throughAuthService: true)
        let currentStamp = try #require(w.auth.session.stamp())
        let currentSession = try #require(w.auth.provider.auth.currentSession)
        let bytes = try #require(try w.storedSession())
        let currentScreens = try #require(w.auth.signedInObject() as? MainScreens)
        let keys = try UnlockWorld(session: w.auth.session)
        keys.plantVaultKey(user: FakeSupabase.other)
        let opened = OpenedKey(userID: FakeSupabase.other, recipient: try keys.v.testRecipient())
        let keyStamp = try #require(keys.store.stamp())
        #expect(keys.store.put(opened, stamp: keyStamp))
        try #require(currentStamp != oldStamp && currentStamp.userID == FakeSupabase.other)
        try #require(currentSession.user.id.uuidString.lowercased() == FakeSupabase.other)

        release.open()
        await run.value

        // Pinned SDK discards A's stale refresh. The regression is a stale notice, not a B API request.
        #expect(await w.probe.requests.isEmpty)
        #expect(!didClear && w.screens.changes.version == version)
        #expect(w.demo.notice == DemoModel.Notice())
        #expect(w.demo.loadedCount == 0 && w.demo.clearedCount == 0 && !w.demo.showsBusyNote && w.demo.phase == .idle)
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.other) && w.auth.session.isCurrent(currentStamp))
        #expect(w.auth.provider.auth.currentSession?.accessToken == currentSession.accessToken)
        #expect(try w.storedSession() == bytes)
        #expect(w.auth.signedInObject() === currentScreens && keys.store.key?.userID == FakeSupabase.other && keys.vaultCount == 1)
    }
}
