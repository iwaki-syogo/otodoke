import Foundation
@testable import Otodoke

/// A small stand-in for Supabase that keeps database state, reached through StubURLProtocol.
/// It speaks the wire formats the app's client speaks, not the client's API:
///  - GoTrue: POST /auth/v1/otp, /auth/v1/verify, /auth/v1/token?grant_type=refresh_token, /auth/v1/logout,
///    GET /auth/v1/user. Errors in GoTrue's shape ({"code", "error_code", "msg"}).
///  - PostgREST: GET / HEAD / PATCH / POST on /rest/v1/<table> with column filters (eq, neq, gt, gte,
///    lt, lte, in, is; a column may be filtered more than once), order, limit, offset or a Range
///    header, `Prefer: count=exact` (Content-Range), `Prefer: return=representation`, and the
///    single-object Accept header (406 / PGRST116 unless exactly one row; a PATCH asked for one
///    object that matched another number of rows is rolled back, as PostgREST does).
///    At most 1,000 rows per answer, as Supabase's max-rows.
///    A PATCH sets updated_at to a new value (as the trigger does): "2026-11-04T05:00:00.000001+00:00",
///    with microseconds and a "+", so a value that loses digits or its "+" no longer matches.
///  - Every REST request must carry `apikey: <anon key>` and `Authorization: Bearer <a token this
///    fake issued at sign-in>`, else 401: the user's JWT is used, never the anon key alone.
/// Query values are decoded as PostgREST decodes them ("+" is a space). Faults and hooks are keyed by
/// (method, last path component, nth such request) and let a test fail a request, drop its answer
/// after it was applied, hold it, or change the data just before it is handled.
actor FakeSupabase {
    static let me = "00000000-0000-4000-8000-0000000000aa"
    static let other = "00000000-0000-4000-8000-0000000000bb"
    static let email = "qa@example.com"
    static let anonKey = "test-anon-key"
    static let goodCode = "12345678"
    static let maxRows = 1000

    nonisolated let host: String
    nonisolated let config: AppConfig
    nonisolated let urlSession: URLSession

    enum OTPMode: Sendable { case ok, rateLimited }
    enum VerifyMode: Sendable { case ok, rejected, rateLimited }
    enum RefreshMode: Sendable { case ok, invalidGrant }

    enum FaultKind: Sendable {
        /// The server answers with this status (a PostgREST / GoTrue style error body).
        case http(Int)
        /// No answer, nothing applied.
        case transport(URLError.Code)
        /// Applied, then the answer is lost (Codex-P3).
        case applyThenDrop(URLError.Code)
        /// Waits until the gate opens, then is handled as usual.
        case hold(Gate)
    }

    private struct Fault {
        let method: String
        let resource: String
        let nth: Int
        let kind: FaultKind
    }

    private struct PredicateFault {
        let matches: @Sendable (StubRequest) -> Bool
        let nth: Int
        let kind: FaultKind
    }

    private struct Hook {
        let method: String
        let resource: String
        let nth: Int
        let mutate: @Sendable (inout [String: [Row]]) -> Void
    }

    private var otpMode = OTPMode.ok
    private var verifyMode = VerifyMode.ok
    private var refreshMode = RefreshMode.ok
    private var sessionLifetime = 3600
    private var unreadEmails = 0

    private(set) var requests: [StubRequest] = []
    private var tables: [String: [Row]] = ["parcels": [], "parcel_items": [], "extractions": [], "emails": [], "inbox_addresses": []]
    private let uniqueColumns: [String: [String]] = ["inbox_addresses": ["user_id", "local_part"]]
    private var tick = 0
    private var sessions = 0
    private var accessTokens: Set<String> = []
    private var refreshTokens: Set<String> = []
    private var faults: [Fault] = []
    private var predicateFaults: [PredicateFault] = []
    private var hooks: [Hook] = []

    private init() {
        host = "\(UUID().uuidString.lowercased()).supabase.test"
        config = AppConfig(supabaseURL: URL(string: "https://\(host)")!, anonKey: Self.anonKey, inboundDomain: "in.example.test")
        urlSession = StubURLProtocol.makeSession()
    }

    static func make() -> FakeSupabase {
        let fake = FakeSupabase()
        StubURLProtocol.register(host: fake.host) { [weak fake] request in
            guard let fake else { return .failure(.cancelled) }
            return await fake.handle(request)
        }
        return fake
    }

    deinit {
        StubURLProtocol.unregister(host: host)
    }

    // MARK: settings

    func setOTP(_ mode: OTPMode) { otpMode = mode }
    func setVerify(_ mode: VerifyMode) { verifyMode = mode }
    func setRefresh(_ mode: RefreshMode) { refreshMode = mode }
    /// expires_in of the sessions issued from now on.
    func setSessionLifetime(_ seconds: Int) { sessionLifetime = seconds }
    func setUnreadEmails(_ n: Int) { unreadEmails = n }

    /// The nth (1-based) request of this method to this resource ("parcels", "otp", ...) gets `kind`.
    func fail(_ method: String, _ resource: String, nth: Int = 1, with kind: FaultKind) {
        faults.append(Fault(method: method, resource: resource, nth: nth, kind: kind))
    }

    /// The nth (1-based) request for which `matches` holds gets `kind`. For telling apart requests to one
    /// table, e.g. the list read (no status filter) from the counts (status=eq...).
    func fail(where matches: @escaping @Sendable (StubRequest) -> Bool, nth: Int = 1, with kind: FaultKind) {
        predicateFaults.append(PredicateFault(matches: matches, nth: nth, kind: kind))
    }

    /// Changes the data just before the nth request of this method to this resource is handled.
    func before(_ method: String, _ resource: String, nth: Int = 1, _ mutate: @escaping @Sendable (inout [String: [Row]]) -> Void) {
        hooks.append(Hook(method: method, resource: resource, nth: nth, mutate: mutate))
    }

    // MARK: data

    func insert(_ table: String, _ rows: [Row]) {
        tables[table, default: []].append(contentsOf: rows)
    }

    func rows(_ table: String) -> [Row] { tables[table] ?? [] }

    func row(_ table: String, id: String) -> Row? {
        tables[table]?.first { $0["id"] == .string(id) }
    }

    /// Another writer (a delivery mail, the Web) changes a row: applies `changes` and moves updated_at on.
    @discardableResult
    func touch(_ table: String, id: String, _ changes: Row) -> String? {
        guard var rows = tables[table], let i = rows.firstIndex(where: { $0["id"] == .string(id) }) else { return nil }
        for (k, v) in changes { rows[i][k] = v }
        let stamp = nextTimestamp()
        rows[i]["updated_at"] = .string(stamp)
        tables[table] = rows
        return stamp
    }

    /// The value the next PATCH (or touch) will give updated_at.
    func peekNextTimestamp() -> String { Self.timestamp(tick + 1) }

    // MARK: request log

    func requests(_ method: String? = nil, _ resource: String? = nil) -> [StubRequest] {
        requests.filter { (method == nil || $0.method == method) && (resource == nil || Self.resource(of: $0) == resource) }
    }

    func count(_ method: String, _ resource: String) -> Int { requests(method, resource).count }

    /// REST requests only (reads and writes of tables).
    func restRequests() -> [StubRequest] { requests.filter { $0.path.hasPrefix("/rest/v1/") } }

    // MARK: handling

    static func resource(of request: StubRequest) -> String { request.url.lastPathComponent }

    func handle(_ request: StubRequest) async -> StubReply {
        requests.append(request)
        let resource = Self.resource(of: request)
        let nth = requests.filter { $0.method == request.method && Self.resource(of: $0) == resource }.count
        for hook in hooks where hook.method == request.method && hook.resource == resource && hook.nth == nth {
            hook.mutate(&tables)
        }
        let kind = faults.first(where: { $0.method == request.method && $0.resource == resource && $0.nth == nth })?.kind
            ?? predicateFaults.first(where: { f in f.matches(request) && requests.filter(f.matches).count == f.nth })?.kind
        if let kind {
            switch kind {
            case let .http(status):
                return .json(status, ["code": "XX000", "message": "injected failure", "details": NSNull(), "hint": NSNull()])
            case let .transport(code):
                return .failure(code)
            case let .applyThenDrop(code):
                _ = route(request)
                return .failure(code)
            case let .hold(gate):
                await gate.wait()
                return route(request)
            }
        }
        return route(request)
    }

    private func route(_ request: StubRequest) -> StubReply {
        let path = request.path
        if path.hasPrefix("/auth/v1/") { return auth(request, String(path.dropFirst("/auth/v1/".count))) }
        if path.hasPrefix("/rest/v1/") { return rest(request, String(path.dropFirst("/rest/v1/".count))) }
        return .json(404, ["message": "not found"])
    }

    // MARK: GoTrue

    private func auth(_ request: StubRequest, _ endpoint: String) -> StubReply {
        switch (request.method, endpoint) {
        case ("POST", "otp"):
            switch otpMode {
            case .ok: return .json(200, [String: Any]())
            case .rateLimited: return .json(429, ["code": 429, "error_code": "over_email_send_rate_limit", "msg": "email rate limit exceeded"])
            }
        case ("POST", "verify"):
            if verifyMode == .rateLimited {
                return .json(429, ["code": 429, "error_code": "over_request_rate_limit", "msg": "Request rate limit reached"])
            }
            let token = request.jsonDictionary?["token"] as? String
            if verifyMode == .rejected || token != Self.goodCode {
                return .json(403, ["code": 403, "error_code": "otp_expired", "msg": "Token has expired or is invalid"])
            }
            return .json(200, newSession())
        case ("POST", "token"):
            let refresh = request.jsonDictionary?["refresh_token"] as? String
            guard request.query("grant_type").first == "refresh_token", refreshMode == .ok, let refresh, refreshTokens.contains(refresh) else {
                return .json(400, ["code": 400, "error_code": "refresh_token_not_found", "msg": "Invalid Refresh Token: Refresh Token Not Found"])
            }
            return .json(200, newSession())
        case ("POST", "logout"):
            return .empty(204)
        case ("GET", "user"):
            guard bearerIsValid(request) else {
                return .json(401, ["code": 401, "error_code": "bad_jwt", "msg": "invalid JWT"])
            }
            return .json(200, Self.user())
        default:
            return .json(404, ["code": 404, "error_code": "not_found", "msg": "not found"])
        }
    }

    private func bearerIsValid(_ request: StubRequest) -> Bool {
        guard let auth = request.header("authorization"), auth.hasPrefix("Bearer ") else { return false }
        return accessTokens.contains(String(auth.dropFirst("Bearer ".count)))
    }

    private func newSession() -> [String: Any] {
        sessions += 1
        let now = Int(Date().timeIntervalSince1970)
        let access = Self.jwt(exp: now + sessionLifetime, iat: now, n: sessions)
        let refresh = "refresh-\(sessions)-\(UUID().uuidString.prefix(8).lowercased())"
        accessTokens.insert(access)
        refreshTokens.insert(refresh)
        return [
            "access_token": access,
            "token_type": "bearer",
            "expires_in": sessionLifetime,
            "expires_at": now + sessionLifetime,
            "refresh_token": refresh,
            "user": Self.user(),
        ]
    }

    /// GoTrue's user object. If the client's decoder needs more fields, add them here (a server
    /// answer, not an expectation).
    static func user() -> [String: Any] {
        [
            "id": me,
            "aud": "authenticated",
            "role": "authenticated",
            "email": email,
            "email_confirmed_at": "2026-11-01T00:00:00.000000Z",
            "confirmed_at": "2026-11-01T00:00:00.000000Z",
            "last_sign_in_at": "2026-11-04T00:00:00.000000Z",
            "phone": "",
            "app_metadata": ["provider": "email", "providers": ["email"]],
            "user_metadata": [String: Any](),
            "identities": [Any](),
            "created_at": "2026-11-01T00:00:00.000000Z",
            "updated_at": "2026-11-04T00:00:00.000000Z",
            "is_anonymous": false,
        ]
    }

    private static func jwt(exp: Int, iat: Int, n: Int) -> String {
        func part(_ object: [String: Any]) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
            return data.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let header = part(["alg": "HS256", "typ": "JWT"])
        let payload = part([
            "sub": me, "role": "authenticated", "aud": "authenticated", "email": email,
            "exp": exp, "iat": iat, "session_id": "00000000-0000-4000-8000-\(String(format: "%012d", n))",
        ])
        return "\(header).\(payload).ZmFrZS1zaWduYXR1cmU"
    }

    // MARK: PostgREST

    private static let reserved: Set<String> = ["select", "order", "limit", "offset", "or", "and", "on_conflict", "columns"]

    private func rest(_ request: StubRequest, _ table: String) -> StubReply {
        guard request.header("apikey") == Self.anonKey, bearerIsValid(request) else {
            return .json(401, ["code": "PGRST301", "message": "JWT invalid", "details": NSNull(), "hint": NSNull()])
        }
        switch request.method {
        case "GET", "HEAD": return select(request, table)
        case "PATCH": return update(request, table)
        case "POST": return insertRows(request, table)
        default: return .json(405, ["code": "PGRST117", "message": "method not allowed"])
        }
    }

    private func wantsObject(_ request: StubRequest) -> Bool {
        (request.header("accept") ?? "").contains("vnd.pgrst.object")
    }

    private func prefers(_ request: StubRequest, _ token: String) -> Bool {
        (request.header("prefer") ?? "").contains(token)
    }

    private static func notOne(_ n: Int) -> [String: Any] {
        ["code": "PGRST116", "details": "The result contains \(n) rows", "hint": NSNull(), "message": "JSON object requested, multiple (or no) rows returned"]
    }

    private func select(_ request: StubRequest, _ table: String) -> StubReply {
        let wantsCount = prefers(request, "count=exact")
        if table == "emails", !request.query("or").isEmpty {
            // The unread count. The tests check the `or` text itself against StatusRules.unreadFilter.
            let headers = ["Content-Range": wantsCount ? "*/\(unreadEmails)" : "*/*"]
            return request.method == "HEAD" ? .empty(200, headers: headers) : .json(200, [Any](), headers: headers)
        }
        let matched = (tables[table] ?? []).filter { matches($0, request) }
        let ordered = Self.sorted(matched, by: request.query("order").first)
        var start = 0
        var end = Int.max
        if let offset = request.query("offset").first.flatMap({ Int($0) }) { start = offset }
        if let limit = request.query("limit").first.flatMap({ Int($0) }) { end = start + limit - 1 }
        if let range = request.header("range"), let bounds = Self.parseRange(range) {
            start = bounds.0
            end = bounds.1
        }
        end = min(end, start + Self.maxRows - 1)
        let page: [Row] = (start < ordered.count && end >= start) ? Array(ordered[start...min(end, ordered.count - 1)]) : []
        var headers: [String: String] = [:]
        let total = wantsCount ? String(ordered.count) : "*"
        headers["Content-Range"] = page.isEmpty ? "*/\(total)" : "\(start)-\(start + page.count - 1)/\(total)"
        if request.method == "HEAD" { return .empty(200, headers: headers) }
        if wantsObject(request) {
            guard page.count == 1 else { return .json(406, Self.notOne(page.count)) }
            return .json(200, page[0].anyObject, headers: headers)
        }
        return .json(200, page.map(\.anyObject), headers: headers)
    }

    private func update(_ request: StubRequest, _ table: String) -> StubReply {
        guard let changes = request.jsonDictionary else {
            return .json(400, ["code": "PGRST102", "message": "Empty or invalid json"])
        }
        let before = tables[table] ?? []
        var rows = before
        var changed: [Row] = []
        for i in rows.indices where matches(rows[i], request) {
            for (k, v) in changes { rows[i][k] = JSONValue(any: v) }
            if rows[i]["updated_at"] != nil { rows[i]["updated_at"] = .string(nextTimestamp()) }
            changed.append(rows[i])
        }
        if wantsObject(request), changed.count != 1 {
            tables[table] = before
            return .json(406, Self.notOne(changed.count))
        }
        tables[table] = rows
        guard prefers(request, "return=representation") else { return .empty(204) }
        if wantsObject(request) { return .json(200, changed[0].anyObject) }
        return .json(200, changed.map(\.anyObject))
    }

    private func insertRows(_ request: StubRequest, _ table: String) -> StubReply {
        let objects: [[String: Any]] = (request.jsonObject as? [[String: Any]]) ?? request.jsonDictionary.map { [$0] } ?? []
        var rows = tables[table] ?? []
        var added: [Row] = []
        for object in objects {
            var row = object.mapValues(JSONValue.init(any:))
            if row["id"] == nil { row["id"] = .string(UUID().uuidString.lowercased()) }
            if row["created_at"] == nil { row["created_at"] = .string(nextTimestamp()) }
            for column in uniqueColumns[table] ?? [] {
                if let value = row[column], rows.contains(where: { $0[column] == value }) {
                    return .json(409, [
                        "code": "23505",
                        "details": "Key (\(column))=(\(value.text ?? "")) already exists.",
                        "hint": NSNull(),
                        "message": "duplicate key value violates unique constraint \"\(table)_\(column)_key\"",
                    ])
                }
            }
            rows.append(row)
            added.append(row)
        }
        tables[table] = rows
        guard prefers(request, "return=representation") else { return .empty(201) }
        if wantsObject(request) {
            guard added.count == 1 else { return .json(406, Self.notOne(added.count)) }
            return .json(201, added[0].anyObject)
        }
        return .json(201, added.map(\.anyObject))
    }

    // MARK: filters and order

    private func matches(_ row: Row, _ request: StubRequest) -> Bool {
        for (name, expression) in request.queryPairs where !Self.reserved.contains(name) {
            if !Self.test(row[name] ?? .null, expression) { return false }
        }
        return true
    }

    /// One PostgREST filter, with SQL's null semantics (a null value matches only `is.null`).
    static func test(_ value: JSONValue, _ expression: String) -> Bool {
        guard let dot = expression.firstIndex(of: ".") else { return false }
        let op = String(expression[..<dot])
        let arg = String(expression[expression.index(after: dot)...])
        switch op {
        case "is":
            switch arg {
            case "null": return value == .null
            case "true": return value == .bool(true)
            case "false": return value == .bool(false)
            default: return false
            }
        case "in":
            return parseList(arg).contains { compare(value, $0) == .orderedSame }
        case "eq":
            return compare(value, arg) == .orderedSame
        case "neq":
            guard let c = compare(value, arg) else { return false }
            return c != .orderedSame
        case "gt":
            return compare(value, arg) == .orderedDescending
        case "gte":
            guard let c = compare(value, arg) else { return false }
            return c != .orderedAscending
        case "lt":
            return compare(value, arg) == .orderedAscending
        case "lte":
            guard let c = compare(value, arg) else { return false }
            return c != .orderedDescending
        default:
            return false
        }
    }

    /// Text compares as text: a timestamp must be sent exactly as it was read.
    static func compare(_ value: JSONValue, _ arg: String) -> ComparisonResult? {
        switch value {
        case .null, .array, .object:
            return nil
        case let .string(s):
            return s < arg ? .orderedAscending : (s > arg ? .orderedDescending : .orderedSame)
        case let .int(i):
            guard let a = Int(arg) else { return nil }
            return i < a ? .orderedAscending : (i > a ? .orderedDescending : .orderedSame)
        case let .double(d):
            guard let a = Double(arg) else { return nil }
            return d < a ? .orderedAscending : (d > a ? .orderedDescending : .orderedSame)
        case let .bool(b):
            guard let a = Bool(arg) else { return nil }
            return b == a ? .orderedSame : (b ? .orderedDescending : .orderedAscending)
        }
    }

    static func parseList(_ arg: String) -> [String] {
        var body = arg
        if body.hasPrefix("(") { body.removeFirst() }
        if body.hasSuffix(")") { body.removeLast() }
        var items: [String] = []
        var current = ""
        var quoted = false
        for ch in body {
            if ch == "\"" { quoted.toggle(); continue }
            if ch == ",", !quoted {
                items.append(current)
                current = ""
                continue
            }
            current.append(ch)
        }
        items.append(current)
        return items
    }

    static func parseRange(_ header: String) -> (Int, Int)? {
        let parts = header.split(separator: "-", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
        guard let a = parts.first.flatMap({ Int($0) }) else { return nil }
        let b = parts.count > 1 ? (Int(parts[1]) ?? Int.max) : Int.max
        return (a, b)
    }

    static func sorted(_ rows: [Row], by spec: String?) -> [Row] {
        guard let spec, !spec.isEmpty else { return rows }
        let keys: [(column: String, ascending: Bool, nullsFirst: Bool)] = spec.split(separator: ",").map { part in
            let bits = part.split(separator: ".").map(String.init)
            let ascending = !bits.contains("desc")
            let nullsFirst = bits.contains("nullsfirst") ? true : (bits.contains("nullslast") ? false : !ascending)
            return (bits[0], ascending, nullsFirst)
        }
        return rows.enumerated().sorted { a, b in
            for key in keys {
                let x = a.element[key.column] ?? .null
                let y = b.element[key.column] ?? .null
                if x == y { continue }
                if x == .null { return key.nullsFirst }
                if y == .null { return !key.nullsFirst }
                guard let yText = y.text, let c = compare(x, yText), c != .orderedSame else { continue }
                return key.ascending ? c == .orderedAscending : c == .orderedDescending
            }
            return a.offset < b.offset
        }.map(\.element)
    }

    private func nextTimestamp() -> String {
        tick += 1
        return Self.timestamp(tick)
    }

    private static func timestamp(_ n: Int) -> String {
        "2026-11-04T05:00:00." + String(format: "%06d", n) + "+00:00"
    }
}

/// Holds a request until the test opens it (to see the spinner while a request is in flight).
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            lock.lock()
            if isOpen {
                lock.unlock()
                c.resume()
            } else {
                waiters.append(c)
                lock.unlock()
            }
        }
    }

    func open() {
        lock.lock()
        isOpen = true
        let waiting = waiters
        waiters = []
        lock.unlock()
        waiting.forEach { $0.resume() }
    }
}

/// The app's SessionStorage, in memory.
final class InMemorySessionStorage: SessionStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]

    func store(key: String, value: Data) throws { lock.withLock { items[key] = value } }
    func retrieve(key: String) throws -> Data? { lock.withLock { items[key] } }
    func remove(key: String) throws { lock.withLock { _ = items.removeValue(forKey: key) } }
    var isEmpty: Bool { lock.withLock { items.isEmpty } }
}

/// Signs in through the app's own AuthService against the fake (verify with the good code).
@MainActor
enum TestSession {
    static func signedIn(_ fake: FakeSupabase, storage: InMemorySessionStorage = InMemorySessionStorage()) async throws -> (provider: SupabaseProvider, auth: AuthService) {
        let provider = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: storage)
        let auth = AuthService(provider: provider)
        try await auth.verifyCode(email: FakeSupabase.email, code: FakeSupabase.goodCode)
        return (provider, auth)
    }
}
