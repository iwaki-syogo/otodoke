import Foundation
@testable import Otodoke

/// The Web's mail endpoints (POST /api/mail/mark-parcel and /api/mail/read-waiting) as a stub server on its own
/// made-up host, working on a FakeSupabase the way the Web does (mark-parcel sets flagged_at for `remembered`;
/// read-waiting empties the unread count). Nothing leaves the machine. It checks what the Web checks: POST only,
/// JSON, a Bearer token the fake issued (else 401 unauthorized), exactly the fields listed (else 400 invalid_input).
/// Answers can be forced per endpoint and nth request, or held on a Gate.
actor FakeMailServer {
    nonisolated let host: String
    nonisolated let baseURL: URL
    nonisolated let urlSession: URLSession
    let supabase: FakeSupabase

    enum Forced: Sendable {
        case answer(status: Int, ok: Bool, code: String?)
        case transport(URLError.Code)
    }

    private(set) var requests: [StubRequest] = []
    private var forced: [String: [Int: Forced]] = [:]
    private var gates: [String: Gate] = [:]
    /// What mark-parcel answers for a row that can be marked.
    private var outcome: MarkParcelOutcome = .remembered

    private init(supabase: FakeSupabase) {
        self.supabase = supabase
        host = "\(UUID().uuidString.lowercased()).mail.web.test"
        baseURL = URL(string: "https://\(host)")!
        urlSession = StubURLProtocol.makeSession()
    }

    static func make(supabase: FakeSupabase) -> FakeMailServer {
        let server = FakeMailServer(supabase: supabase)
        StubURLProtocol.register(host: server.host) { [weak server] request in
            guard let server else { return .failure(.cancelled) }
            return await server.handle(request)
        }
        return server
    }

    deinit {
        StubURLProtocol.unregister(host: host)
    }

    func setOutcome(_ outcome: MarkParcelOutcome) { self.outcome = outcome }
    func force(_ endpoint: String, nth: Int = 1, _ answer: Forced) { forced[endpoint, default: [:]][nth] = answer }
    func hold(_ endpoint: String, on gate: Gate) { gates[endpoint] = gate }
    func requests(_ endpoint: String) -> [StubRequest] { requests.filter { $0.url.lastPathComponent == endpoint } }
    func count(_ endpoint: String) -> Int { requests(endpoint).count }

    static func failure(_ status: Int, _ code: String) -> StubReply {
        .json(status, ["ok": false, "code": code], headers: ["Cache-Control": "no-store"])
    }

    private func handle(_ request: StubRequest) async -> StubReply {
        requests.append(request)
        let endpoint = request.url.lastPathComponent
        let nth = requests.filter { $0.url.lastPathComponent == endpoint }.count
        if let gate = gates[endpoint] { await gate.wait() }
        if let f = forced[endpoint]?[nth] {
            switch f {
            case let .answer(status, ok, code):
                var body: [String: Any] = ["ok": ok]
                if let code { body["code"] = code }
                return .json(status, body, headers: ["Cache-Control": "no-store"])
            case let .transport(code): return .failure(code)
            }
        }
        guard request.method == "POST", request.url.path.hasPrefix("/api/mail/") else { return .json(405, ["ok": false]) }
        guard (request.header("content-type") ?? "").hasPrefix("application/json") else { return Self.failure(400, "invalid_input") }
        guard let auth = request.header("authorization"), auth.hasPrefix("Bearer "),
              await supabase.isAccessToken(String(auth.dropFirst("Bearer ".count)))
        else { return Self.failure(401, "unauthorized") }
        guard let body = request.jsonDictionary else { return Self.failure(400, "invalid_input") }
        switch endpoint {
        case "mark-parcel":
            guard Set(body.keys) == ["id"], let id = body["id"] as? String else { return Self.failure(400, "invalid_input") }
            let known = await supabase.rows("screen_events").contains { $0["id"] == .string(id) && $0["decision"] == "dropped" }
            guard known else { return Self.failure(400, "invalid_input") }
            if outcome == .remembered {
                await supabase.mutate { tables in
                    for i in (tables["screen_events"] ?? []).indices where tables["screen_events"]?[i]["id"] == .string(id) {
                        tables["screen_events"]?[i]["flagged_at"] = "2026-11-04T04:00:00+00:00"
                    }
                }
            }
            return .json(200, ["ok": true, "outcome": outcome.rawValue], headers: ["Cache-Control": "no-store"])
        case "read-waiting":
            guard body.isEmpty else { return Self.failure(400, "invalid_input") }
            await supabase.setUnreadEmails(0)
            return .json(200, ["ok": true], headers: ["Cache-Control": "no-store"])
        default:
            return .json(404, ["ok": false])
        }
    }
}
