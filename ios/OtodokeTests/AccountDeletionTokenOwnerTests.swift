import Foundation
import Testing
@testable import Otodoke

/// Only the provider session carrying this test's route header reaches this probe.
private actor DeletionOwnerProbe {
    private(set) var requests: [StubRequest] = []
    private var status = 503
    private var gate: Gate?

    func configure(status: Int, gate: Gate) { self.status = status; self.gate = gate }

    func answer(_ request: StubRequest) async -> (Int, Data) {
        requests.append(request)
        let status = status
        if let gate { await gate.wait() }
        let body = status == 200 ? #"{"ok":true}"# :
            (status == 401 ? #"{"ok":false,"code":"unauthorized"}"# : #"{"ok":false,"code":"unavailable"}"#)
        return (status, Data(body.utf8))
    }
}

/// This class is installed on one URLSession, never in URLProtocol's global registry.
private final class DeletionOwnerURLProtocol: URLProtocol, @unchecked Sendable {
    private final class Registry: @unchecked Sendable {
        private let lock = NSLock()
        private var probes: [String: DeletionOwnerProbe] = [:]

        func set(_ id: String, _ probe: DeletionOwnerProbe?) { lock.withLock { probes[id] = probe } }
        func get(_ request: URLRequest) -> DeletionOwnerProbe? {
            guard request.httpMethod == "POST", request.url?.host == AppConfig.webBase.host,
                  request.url?.path == "/api/account/delete",
                  let id = request.value(forHTTPHeaderField: "X-Test-Route") else { return nil }
            return lock.withLock { probes[id] }
        }
    }

    private static let registry = Registry()
    static func register(_ id: String, probe: DeletionOwnerProbe) { registry.set(id, probe) }
    static func unregister(_ id: String) { registry.set(id, nil) }

    override class func canInit(with request: URLRequest) -> Bool { registry.get(request) != nil }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    private var work: Task<Void, Never>?

    override func startLoading() {
        let request = self.request
        guard let url = request.url, let probe = Self.registry.get(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let headers = Dictionary((request.allHTTPHeaderFields ?? [:]).map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { _, last in last })
        let sent = StubRequest(method: request.httpMethod ?? "GET", url: url, headers: headers,
                               body: Self.body(of: request), timeoutInterval: request.timeoutInterval)
        nonisolated(unsafe) let client = self.client
        nonisolated(unsafe) let loader: URLProtocol = self
        work = Task {
            let (status, body) = await probe.answer(sent)
            guard !Task.isCancelled else { return }
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                           headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(loader, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(loader, didLoad: body)
            client?.urlProtocolDidFinishLoading(loader)
        }
    }

    override func stopLoading() { work?.cancel() }

    private static func body(of request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
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
private final class DeletionOwnerCleanup: SignOutCleanup {
    var steps: [String] = []
    var clearedScreens = 0
    func cancelWork() { steps.append("cancel") }
    func dropMemory() { steps.append("memory") }
    func deleteKeychainKey() { steps.append("keychain") }
}

@MainActor
private struct DeletionOwnerWorld {
    // Keeping the fake here keeps its unique auth host registered for this world's lifetime.
    let fake: FakeSupabase
    let provider: SupabaseProvider
    let auth: AuthService
    let settings: SettingsModel
    let deletion: AccountDeletionModel
    let storage: InMemorySessionStorage
    let probe: DeletionOwnerProbe
    let cleanup: DeletionOwnerCleanup
    let route: String

    init() async throws {
        let fake = FakeSupabase.make(), probe = DeletionOwnerProbe()
        let route = UUID().uuidString
        DeletionOwnerURLProtocol.register(route, probe: probe)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeletionOwnerURLProtocol.self, StubURLProtocol.self]
        configuration.httpAdditionalHeaders = ["X-Test-Route": route]
        let urlSession = URLSession(configuration: configuration)
        let storage = InMemorySessionStorage()
        let provider = SupabaseProvider(config: fake.config, urlSession: urlSession, storage: storage)
        do {
            // The same real-SDK setup as TestSession, with this world's own URLSession.
            _ = try await provider.auth.verifyOTP(email: FakeSupabase.email, token: FakeSupabase.goodCode, type: .email)
        } catch {
            DeletionOwnerURLProtocol.unregister(route)
            urlSession.invalidateAndCancel()
            throw error
        }
        let auth = AuthService(provider: provider)
        // Do not start the event listener: SDK storage may move before AuthService consumes its event.
        await auth.checkSession()
        let cleanup = DeletionOwnerCleanup()
        auth.cleanup = cleanup
        auth.clearLoadedData = { cleanup.clearedScreens += 1 }
        let settings = SettingsModel.live(auth: auth, changes: nil)
        self.fake = fake; self.provider = provider; self.auth = auth; self.settings = settings
        self.deletion = settings.accountDeletion
        self.storage = storage; self.probe = probe; self.cleanup = cleanup; self.route = route
    }

    func close() {
        DeletionOwnerURLProtocol.unregister(route)
        provider.urlSession.invalidateAndCancel()
    }

    func storedSession() throws -> Data? { try storage.retrieve(key: SupabaseProvider.storageKey(for: fake.config)) }

    func switchSDKToB() async throws {
        let email = "other@example.com", secret = "test-other-auth-secret"
        await fake.addPasswordAccount(email: email, secret: secret, userID: FakeSupabase.other)
        await fake.setUserEmail(email)
        _ = try await provider.auth.signIn(email: email, password: secret)
    }
}

@Suite("Account deletion token owner")
@MainActor
struct AccountDeletionTokenOwnerTests {
    private func jwtSubject(_ token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let bytes = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { return nil }
        return object["sub"] as? String
    }

    private func expectNoCleanup(_ w: DeletionOwnerWorld) {
        #expect(w.cleanup.steps.isEmpty)
        #expect(w.cleanup.clearedScreens == 0)
    }

    private func expectConfirmedPOST(_ request: StubRequest, token: String, route: String) {
        #expect(request.method == "POST" && request.path == "/api/account/delete")
        #expect(request.url.host == AppConfig.webBase.host)
        #expect(request.header("x-test-route") == route)
        #expect(request.header("authorization") == "Bearer \(token)")
        #expect(request.jsonDictionary as? [String: String] == ["confirm": "delete-account"])
    }

    @Test(arguments: [false, true])
    func theRealSettingsClosureSendsTheCurrentOwnersTokenIncludingAfterRefresh(refresh: Bool) async throws {
        let w = try await DeletionOwnerWorld()
        defer { w.close() }
        let stamp = try #require(w.auth.session.stamp())
        let first = try #require(w.provider.auth.currentSession)
        w.deletion.showConfirmation()
        if refresh { _ = try await w.provider.auth.refreshSession() }
        let current = try #require(w.provider.auth.currentSession)
        #expect(current.user.id.uuidString.lowercased() == FakeSupabase.me)
        #expect(jwtSubject(current.accessToken) == FakeSupabase.me)
        if refresh { #expect(current.accessToken != first.accessToken) }
        let bytes = try #require(try w.storedSession())
        #expect(w.auth.session.isCurrent(stamp))

        await w.deletion.deleteAccount()

        let sent = await w.probe.requests
        #expect(sent.count == 1)
        expectConfirmedPOST(try #require(sent.first), token: current.accessToken, route: w.route)
        #expect(w.deletion.message == AccountDeletionText.failed)
        #expect(w.auth.session.isCurrent(stamp))
        #expect(w.provider.auth.currentSession?.accessToken == current.accessToken)
        #expect(try w.storedSession() == bytes)
        expectNoCleanup(w)
    }

    @Test func anOldConfirmationCannotSendTheSDKsNewOwnersTokenBeforeItsEventIsConsumed() async throws {
        let w = try await DeletionOwnerWorld()
        defer { w.close() }
        let stamp = try #require(w.auth.session.stamp())
        w.deletion.showConfirmation()
        try await w.switchSDKToB()
        let current = try #require(w.provider.auth.currentSession)
        let bytes = try #require(try w.storedSession())
        try #require(w.auth.state == .signedIn(userID: FakeSupabase.me) && w.auth.session.isCurrent(stamp))
        try #require(current.user.id.uuidString.lowercased() == FakeSupabase.other)
        try #require(jwtSubject(current.accessToken) == FakeSupabase.other)
        #expect(await w.fake.userID(forAccessToken: current.accessToken) == FakeSupabase.other)

        await w.deletion.deleteAccount()

        #expect(await w.probe.requests.isEmpty)
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.auth.session.isCurrent(stamp))
        #expect(w.provider.auth.currentSession?.user.id == current.user.id)
        #expect(w.provider.auth.currentSession?.accessToken == current.accessToken)
        #expect(try w.storedSession() == bytes)
        expectNoCleanup(w)
    }

    @Test(arguments: ["missing-token", "new-generation"])
    func aMissingSDKTokenOrAnEndedGenerationCannotSend(_ boundary: String) async throws {
        let w = try await DeletionOwnerWorld()
        defer { w.close() }
        let stamp = try #require(w.auth.session.stamp())
        w.deletion.showConfirmation()
        if boundary == "missing-token" { try await w.provider.auth.signOut(scope: .local) }
        else { w.auth.session.advance() }
        let token = w.provider.auth.currentSession?.accessToken
        let bytes = try w.storedSession()
        if boundary == "missing-token" {
            #expect(token == nil && bytes == nil)
            #expect(w.auth.session.isCurrent(stamp))
        } else { #expect(!w.auth.session.isCurrent(stamp)) }

        await w.deletion.deleteAccount()

        #expect(await w.probe.requests.isEmpty)
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.provider.auth.currentSession?.accessToken == token)
        #expect(try w.storedSession() == bytes)
        expectNoCleanup(w)
    }

    @Test(arguments: [200, 401])
    func anOldDeletionReplyCannotClearAnSDKReplacementBeforeItsEventIsConsumed(status: Int) async throws {
        let w = try await DeletionOwnerWorld(), release = Gate()
        defer { release.open(); w.close() }
        let stamp = try #require(w.auth.session.stamp())
        let original = try #require(w.provider.auth.currentSession)
        await w.probe.configure(status: status, gate: release)
        w.deletion.showConfirmation()
        let run = Task { await w.deletion.deleteAccount() }
        let reached = await waitFor { await w.probe.requests.count == 1 }
        try #require(reached)
        expectConfirmedPOST(try #require(await w.probe.requests.first), token: original.accessToken, route: w.route)
        try await w.switchSDKToB()
        let current = try #require(w.provider.auth.currentSession)
        let bytes = try #require(try w.storedSession())
        try #require(w.auth.state == .signedIn(userID: FakeSupabase.me) && w.auth.session.isCurrent(stamp))
        try #require(current.user.id.uuidString.lowercased() == FakeSupabase.other)
        try #require(jwtSubject(current.accessToken) == FakeSupabase.other)
        release.open()
        await run.value

        #expect(await w.probe.requests.count == 1)
        #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.auth.session.isCurrent(stamp))
        #expect(w.provider.auth.currentSession?.accessToken == current.accessToken)
        #expect(try w.storedSession() == bytes)
        expectNoCleanup(w)
    }

    @Test(arguments: ["same-owner-refresh", "missing-sdk-session"], [200, 401])
    func aConfirmedDeletionReplyStillCleansTheSameOwnerOrAnAlreadyMissingSDKSession(_ boundary: String, status: Int) async throws {
        let w = try await DeletionOwnerWorld(), release = Gate()
        defer { release.open(); w.close() }
        await w.probe.configure(status: status, gate: release)
        w.deletion.showConfirmation()
        let run = Task { await w.deletion.deleteAccount() }
        let reached = await waitFor { await w.probe.requests.count == 1 }
        try #require(reached)
        if boundary == "same-owner-refresh" { _ = try await w.provider.auth.refreshSession() }
        else { try await w.provider.auth.signOut(scope: .local) }
        release.open()
        await run.value

        #expect(await w.probe.requests.count == 1)
        #expect(w.auth.state == .signedOut)
        #expect(w.provider.auth.currentSession == nil && w.storage.isEmpty)
        #expect(w.cleanup.steps == ["cancel", "memory", "keychain"])
        #expect(w.cleanup.clearedScreens == 1)
    }
}
