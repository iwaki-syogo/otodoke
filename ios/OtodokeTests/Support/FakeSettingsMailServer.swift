import Foundation
@testable import Otodoke

/// Only registered, made-up URLProtocol hosts are used. No request reaches the network.
actor FakeSettingsMailServer {
    enum Answer: Sendable {
        case normal
        case failure(Int, String)
        case transport(URLError.Code)
        case applyThenLose(URLError.Code)
        case integerOK
        case html(Int)
    }

    nonisolated let host: String
    nonisolated let baseURL: URL
    nonisolated let urlSession: URLSession
    private let supabase: FakeSupabase
    private var answer = Answer.normal
    private var gate: Gate?
    private var seen: [StubRequest] = []

    private init(_ supabase: FakeSupabase) {
        self.supabase = supabase
        host = "\(UUID().uuidString.lowercased()).settings.web.test"
        baseURL = URL(string: "https://\(host)")!
        urlSession = StubURLProtocol.makeSession()
    }

    static func make(_ supabase: FakeSupabase) -> FakeSettingsMailServer {
        let server = FakeSettingsMailServer(supabase)
        StubURLProtocol.register(host: server.host) { [weak server] request in
            guard let server else { return .failure(.cancelled) }
            return await server.handle(request)
        }
        return server
    }

    deinit { StubURLProtocol.unregister(host: host) }

    func force(_ answer: Answer) { self.answer = answer }
    func hold(on gate: Gate) { self.gate = gate }
    func requests() -> [StubRequest] { seen }

    private func handle(_ request: StubRequest) async -> StubReply {
        seen.append(request)
        if let gate { await gate.wait() }
        switch answer {
        case let .failure(status, code): return .json(status, ["ok": false, "code": code])
        case let .transport(code): return .failure(code)
        case .integerOK: return .json(200, ["ok": 1])
        case let .html(status): return .http(status: status, headers: ["Content-Type": "text/html"], body: Data("<html>gateway</html>".utf8))
        case .normal, .applyThenLose: break
        }
        guard request.method == "POST", request.header("content-type") == "application/json",
              let bearer = request.header("authorization"), bearer.hasPrefix("Bearer "),
              await supabase.isAccessToken(String(bearer.dropFirst(7))), let body = request.jsonDictionary
        else { return .json(401, ["ok": false, "code": "unauthorized"]) }
        switch request.path {
        case "/api/mail/forget-sender":
            guard Set(body.keys) == ["domain"], let domain = body["domain"] as? String else {
                return .json(400, ["ok": false, "code": "invalid_input"])
            }
            await supabase.mutate { tables in
                for i in (tables["screen_events"] ?? []).indices {
                    if tables["screen_events"]?[i]["user_id"] == .string(FakeSupabase.me),
                       tables["screen_events"]?[i]["from_domain"] == .string(domain) {
                        tables["screen_events"]?[i]["flagged_at"] = .null
                    }
                }
            }
        case "/api/mail/dismiss-intake":
            guard Set(body.keys) == ["limited_at"], let stamp = body["limited_at"] as? String else {
                return .json(400, ["ok": false, "code": "invalid_input"])
            }
            await supabase.mutate { tables in
                tables["mail_intake_notices"]?.removeAll { row in
                    row["user_id"] == .string(FakeSupabase.me) && row["limited_at"] == .string(stamp)
                }
            }
        default: return .json(404, ["ok": false])
        }
        if case let .applyThenLose(code) = answer { return .failure(code) }
        return .json(200, ["ok": true], headers: ["Cache-Control": "no-store"])
    }
}
