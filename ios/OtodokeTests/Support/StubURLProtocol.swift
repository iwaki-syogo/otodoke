import Foundation

/// A request as the stub server saw it.
struct StubRequest: Sendable {
    let method: String
    let url: URL
    /// Header names lowercased.
    let headers: [String: String]
    let body: Data

    var path: String { url.path }

    func header(_ name: String) -> String? { headers[name.lowercased()] }

    /// Query pairs decoded the way PostgREST and GoTrue decode them: "+" is a space, then
    /// percent-decoding. So a "+00:00" sent without encoding arrives as " 00:00", as on the real server.
    var queryPairs: [(name: String, value: String)] {
        guard let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery, !raw.isEmpty else { return [] }
        return raw.split(separator: "&", omittingEmptySubsequences: true).map { part in
            let s = String(part)
            guard let eq = s.firstIndex(of: "=") else { return (Self.decode(s), "") }
            return (Self.decode(String(s[..<eq])), Self.decode(String(s[s.index(after: eq)...])))
        }
    }

    static func decode(_ s: String) -> String {
        let spaced = s.replacingOccurrences(of: "+", with: " ")
        return spaced.removingPercentEncoding ?? spaced
    }

    /// Every value given for `name`, in order.
    func query(_ name: String) -> [String] { queryPairs.filter { $0.name == name }.map(\.value) }

    var jsonObject: Any? { body.isEmpty ? nil : try? JSONSerialization.jsonObject(with: body) }
    var jsonDictionary: [String: Any]? { jsonObject as? [String: Any] }
}

enum StubReply: Sendable {
    case http(status: Int, headers: [String: String], body: Data)
    /// The request never gets an answer: the client sees this URLError.
    case failure(URLError.Code)

    static func json(_ status: Int, _ object: Any, headers: [String: String] = [:]) -> StubReply {
        let data = (try? JSONSerialization.data(withJSONObject: object, options: [.fragmentsAllowed])) ?? Data()
        var h = headers
        h["Content-Type"] = h["Content-Type"] ?? "application/json; charset=utf-8"
        return .http(status: status, headers: h, body: data)
    }

    static func empty(_ status: Int, headers: [String: String] = [:]) -> StubReply {
        .http(status: status, headers: headers, body: Data())
    }
}

/// Routes every request for a registered host to its handler. Each test registers its own made-up
/// host (see FakeSupabase), so tests running in parallel never see each other's requests. Nothing
/// leaves the machine: a host that is not registered is not handled here, and *.supabase.test does
/// not resolve.
final class StubURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (StubRequest) async -> StubReply

    private final class Registry: @unchecked Sendable {
        private let lock = NSLock()
        private var handlers: [String: Handler] = [:]

        func set(_ host: String, _ handler: Handler?) {
            lock.lock()
            defer { lock.unlock() }
            handlers[host.lowercased()] = handler
        }

        func get(_ host: String?) -> Handler? {
            guard let host else { return nil }
            lock.lock()
            defer { lock.unlock() }
            return handlers[host.lowercased()]
        }
    }

    private static let registry = Registry()

    /// Also routes URLSession.shared, in case a client ignores the session it was given.
    private static let installedGlobally: Bool = {
        URLProtocol.registerClass(StubURLProtocol.self)
        return true
    }()

    static func register(host: String, _ handler: @escaping Handler) {
        _ = installedGlobally
        registry.set(host, handler)
    }

    static func unregister(host: String) {
        registry.set(host, nil)
    }

    static func makeSession() -> URLSession {
        _ = installedGlobally
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubURLProtocol.self] + (configuration.protocolClasses ?? [])
        configuration.timeoutIntervalForRequest = 10
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool {
        registry.get(request.url?.host) != nil
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    private var work: Task<Void, Never>?

    override func startLoading() {
        let request = self.request
        guard let url = request.url, let handler = Self.registry.get(url.host) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unsupportedURL))
            return
        }
        var headers: [String: String] = [:]
        for (name, value) in request.allHTTPHeaderFields ?? [:] {
            headers[name.lowercased()] = value
        }
        let stub = StubRequest(method: request.httpMethod ?? "GET", url: url, headers: headers, body: Self.body(of: request))
        // URLProtocol and its client are not Sendable; URLSession expects the answer from any thread.
        nonisolated(unsafe) let client = self.client
        nonisolated(unsafe) let loader: URLProtocol = self
        work = Task {
            let reply = await handler(stub)
            switch reply {
            case let .http(status, replyHeaders, data):
                let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: replyHeaders)!
                client?.urlProtocol(loader, didReceive: response, cacheStoragePolicy: .notAllowed)
                if !data.isEmpty {
                    client?.urlProtocol(loader, didLoad: data)
                }
                client?.urlProtocolDidFinishLoading(loader)
            case let .failure(code):
                client?.urlProtocol(loader, didFailWithError: URLError(code))
            }
        }
    }

    override func stopLoading() {
        work?.cancel()
    }

    private static func body(of request: URLRequest) -> Data {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return data
    }
}
