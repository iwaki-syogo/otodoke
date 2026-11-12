#if DEBUG
import Foundation
import Observation
import SwiftUI

/// Real category screens, reader and writer, with an in-process PostgREST/GoTrue transport.
/// Nothing reaches a network or the Keychain. Only the server's first write/read is faulted.
struct CategorySavingPreview: View {
    enum Scenario: String, Sendable {
        case spendConflict = "spend-conflict"
        case spendUnknown = "spend-unknown"
        case spendReadFailed = "spend-read-failed"
        case spendSuccess = "spend-success"
        case spendAppliedUnknown = "spend-applied-unknown"
        case spendFilteredConflict = "spend-filtered-conflict"
        case detailAutomaticUnknown = "detail-automatic-unknown"
    }

    let scenario: Scenario
    @State private var runtime: CategoryPreviewRuntime?
    @State private var failed = false

    init?(arguments: [String]) {
        guard let index = arguments.firstIndex(of: "-otodoke-category-preview"), arguments.indices.contains(index + 1),
              let scenario = Scenario(rawValue: arguments[index + 1]) else { return nil }
        self.scenario = scenario
    }

    var body: some View {
        Group {
            if let runtime {
                Group {
                    if scenario == .detailAutomaticUnknown {
                        NavigationStack { ParcelDetailView(model: runtime.detail) }
                    } else {
                        SpendView(model: runtime.spend) { _ in ParcelDetailView(model: runtime.detail) }
                    }
                }
                .background(alignment: .bottomLeading) {
                    // Tiny, noninteractive probes cannot cover a chip or change a hit target.
                    Color.clear.frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityIdentifier("category-preview.patch-count")
                        .accessibilityValue(String(runtime.probe.patches))
                        .allowsHitTesting(false)
                    Color.clear.frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityIdentifier("category-preview.stored")
                        .accessibilityValue(runtime.probe.stored)
                        .allowsHitTesting(false)
                    Color.clear.frame(width: 1, height: 1)
                        .accessibilityElement()
                        .accessibilityIdentifier("category-preview.request-trace")
                        .accessibilityValue(runtime.probe.requestTrace)
                        .allowsHitTesting(false)
                }
            } else if failed {
                Text("読み込めませんでした")
            } else {
                ProgressView()
            }
        }
        .task {
            guard runtime == nil, !failed else { return }
            do { runtime = try await CategoryPreviewRuntime.make(scenario: scenario) }
            catch { failed = true }
        }
    }
}

@MainActor
@Observable
private final class CategoryPreviewProbe {
    var patches = 0
    var stored = "food|auto"
    var requestTrace = ""

    func record(patches: Int, row: ParcelRow, trace: [String]) {
        self.patches = patches
        stored = "\(row.category ?? "nil")|\(row.categorySource ?? "nil")"
        requestTrace = trace.joined(separator: ",")
    }
}

@MainActor
private final class CategoryPreviewRuntime {
    let spend: SpendModel
    let detail: ParcelDetailModel
    let probe: CategoryPreviewProbe
    // Keeps the local transport alive for the complete screen's lifetime.
    let server: CategoryPreviewServer

    private init(provider: SupabaseProvider, probe: CategoryPreviewProbe, server: CategoryPreviewServer) {
        let reader = ParcelReader(provider: provider), writer = ParcelWriter(provider: provider)
        self.probe = probe
        self.server = server
        spend = SpendModel(reader: reader, writer: writer, changes: nil, today: { "2026-11-12" })
        detail = ParcelDetailModel(id: CategoryPreviewServer.parcelID, reader: reader, writer: writer, today: { "2026-11-12" })
    }

    static func make(scenario: CategorySavingPreview.Scenario) async throws -> CategoryPreviewRuntime {
        let probe = CategoryPreviewProbe()
        let server = CategoryPreviewServer(scenario: scenario, probe: probe)
        CategoryPreviewURLProtocol.install(server)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.protocolClasses = [CategoryPreviewURLProtocol.self]
        let provider = SupabaseProvider(
            config: AppConfig(supabaseURL: URL(string: "https://category-preview.invalid")!, anonKey: "preview", inboundDomain: "preview.invalid"),
            urlSession: URLSession(configuration: configuration), storage: CategoryPreviewStorage()
        )
        // The SDK obtains an ordinary session from our local GoTrue reply, just as the unit FakeSupabase does.
        _ = try await provider.auth.signIn(email: "category@example.test", password: "category-preview-password")
        return CategoryPreviewRuntime(provider: provider, probe: probe, server: server)
    }
}

private actor CategoryPreviewServer {
    static let userID = "00000000-0000-4000-8000-000000049000"
    static let parcelID = "00000000-0000-4000-8000-000000049001"
    private let scenario: CategorySavingPreview.Scenario
    private let probe: CategoryPreviewProbe
    private var row: ParcelRow
    private var patches = 0
    private var revision = 0
    private var failedRead = false
    private var accessToken = ""
    private var requestTrace: [String] = []

    init(scenario: CategorySavingPreview.Scenario, probe: CategoryPreviewProbe) {
        self.scenario = scenario
        self.probe = probe
        var row = ListPreview.row(49_001, shop: "架空の店", title: "架空の分類変更の本", status: "ordered", date: nil)
        row.userId = Self.userID
        row.category = "food"
        row.categorySource = "auto"
        row.orderedAt = "2026-11-12"
        row.totalAmount = 1200
        row.updatedAt = "2026-11-12T01:00:00.123456+00:00"
        self.row = row
    }

    func handle(_ request: URLRequest, body: Data) async -> CategoryPreviewReply {
        guard let url = request.url, url.host == "category-preview.invalid" else { return .failure(.unsupportedURL) }
        let method = request.httpMethod ?? "GET"
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        if url.path == "/auth/v1/token", method == "POST", value("grant_type") == "password" { return session() }
        guard request.value(forHTTPHeaderField: "Authorization") == "Bearer \(accessToken)", !accessToken.isEmpty else {
            return .json(401, ["code": "PGRST301", "message": "No local session"])
        }
        guard value("user_id") == "eq.\(Self.userID)" else {
            return .json(400, ["code": "PGRST100", "message": "Missing user condition"])
        }
        if method == "GET", ["/rest/v1/parcel_items", "/rest/v1/extractions"].contains(url.path) {
            return .http(200, Data("[]".utf8))
        }
        guard url.path == "/rest/v1/parcels" else { return .failure(.unsupportedURL) }
        if method == "GET" {
            if scenario == .spendReadFailed, patches > 0, !failedRead {
                failedRead = true
                requestTrace.append("GET.failed")
                await publish()
                return .json(503, ["code": "PGRST000", "message": "Local read failure"])
            }
            guard value("id") == nil || value("id") == "eq.\(row.id)" else { return .http(200, Data("[]".utf8)) }
            requestTrace.append("GET.ok")
            await publish()
            return .http(200, (try? JSONEncoder().encode([row])) ?? Data())
        }
        guard method == "PATCH", value("id") == "eq.\(row.id)",
              let columns = try? JSONDecoder().decode([String: String].self, from: body),
              let category = columns["category"], ParcelCategory(rawValue: category) != nil,
              columns["category_source"] == "user" else {
            return .json(400, ["code": "PGRST100", "message": "Invalid local update"])
        }
        patches += 1
        requestTrace.append("PATCH.\(patches)")
        if patches == 1 {
            switch scenario {
            case .spendConflict, .spendFilteredConflict:
                // Another writer changes the row after this screen's GET. The real OCC predicate now misses.
                advanceVersion()
                if scenario == .spendFilteredConflict { row.category = "beauty"; row.categorySource = "user" }
            case .spendUnknown, .spendReadFailed, .detailAutomaticUnknown:
                await publish()
                // No application; the transport cannot tell the real writer whether it happened.
                return .failure(.networkConnectionLost)
            case .spendAppliedUnknown, .spendSuccess:
                break
            }
        }
        guard value("updated_at") == "eq.\(row.updatedAt)" else {
            await publish()
            return .http(200, Data("[]".utf8))
        }
        row.category = category
        row.categorySource = "user"
        advanceVersion()
        await publish()
        if patches == 1, scenario == .spendAppliedUnknown { return .failure(.networkConnectionLost) }
        return .http(200, (try? JSONEncoder().encode([row])) ?? Data())
    }

    private func advanceVersion() {
        revision += 1
        row.updatedAt = String(format: "2026-11-12T01:00:%02d.123456+00:00", revision)
    }

    private func publish() async { await probe.record(patches: patches, row: row, trace: requestTrace) }

    private func session() -> CategoryPreviewReply {
        let now = Int(Date().timeIntervalSince1970)
        func part(_ object: [String: Any]) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
            return data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        accessToken = "\(part(["alg": "HS256", "typ": "JWT"])).\(part(["sub": Self.userID, "exp": now + 3600, "iat": now, "role": "authenticated", "aud": "authenticated"])).cHJldmlldw"
        return .json(200, [
            "access_token": accessToken, "token_type": "bearer", "expires_in": 3600,
            "expires_at": now + 3600, "refresh_token": "preview-refresh",
            "user": ["id": Self.userID, "aud": "authenticated", "role": "authenticated", "email": "category@example.test",
                     "app_metadata": ["provider": "email", "providers": ["email"]], "user_metadata": [String: String](),
                     "identities": [String](), "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z", "is_anonymous": false]
        ])
    }
}

private enum CategoryPreviewReply: Sendable {
    case http(Int, Data)
    case failure(URLError.Code)

    static func json(_ status: Int, _ value: [String: Any]) -> Self {
        .http(status, (try? JSONSerialization.data(withJSONObject: value)) ?? Data())
    }
}

private final class CategoryPreviewURLProtocol: URLProtocol, @unchecked Sendable {
    private final class Registry: @unchecked Sendable {
        private let lock = NSLock()
        private var server: CategoryPreviewServer?
        func install(_ server: CategoryPreviewServer) { lock.withLock { self.server = server } }
        func current() -> CategoryPreviewServer? { lock.withLock { server } }
    }
    private static let registry = Registry()
    private var work: Task<Void, Never>?

    static func install(_ server: CategoryPreviewServer) { registry.install(server) }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let server = Self.registry.current(), let url = request.url else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        let request = request, body = Self.body(request)
        nonisolated(unsafe) let client = self.client
        nonisolated(unsafe) let loader: URLProtocol = self
        work = Task {
            switch await server.handle(request, body: body) {
            case let .http(status, data):
                let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
                client?.urlProtocol(loader, didReceive: response, cacheStoragePolicy: .notAllowed)
                client?.urlProtocol(loader, didLoad: data)
                client?.urlProtocolDidFinishLoading(loader)
            case let .failure(code): client?.urlProtocol(loader, didFailWithError: URLError(code))
            }
        }
    }
    override func stopLoading() { work?.cancel() }

    private static func body(_ request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data(), buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

private final class CategoryPreviewStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    func store(key: String, value: Data) throws { lock.withLock { items[key] = value } }
    func retrieve(key: String) throws -> Data? { lock.withLock { items[key] } }
    func remove(key: String) throws { lock.withLock { _ = items.removeValue(forKey: key) } }
}
#endif
