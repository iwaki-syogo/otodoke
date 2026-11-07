import Foundation
import ObjectiveC
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

    /// captchaFailed: GoTrue's 400 captcha_failed (CAPTCHA on, the token missing or refused).
    /// cloudflareDown: the captcha check itself failed (500, no error code), as GoTrue answers then.
    enum OTPMode: Sendable { case ok, rateLimited, captchaFailed, cloudflareDown }
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
        /// Something in front of PostgREST answers with this status and a body that is not PostgREST's
        /// (Cloudflare's 520/522/524 page, an HTML 503). `applied`: the request reached the database first.
        case gateway(Int, body: String, contentType: String, applied: Bool)
        /// Waits until the gate opens, then fails as `kind` (a read held and then lost, say).
        case holdThen(Gate, FakeFault)
        /// Handled now (the data as it is now), the answer delivered only when the gate opens: a slow
        /// answer that is older than writes made meanwhile.
        case delay(Gate)
        /// The device gives up now (`code`, e.g. a timeout) while the request is held at the server:
        /// it is handled only when `gate` opens, on the data as it is then, and `handled` opens after.
        case lostThenLate(Gate, URLError.Code, handled: Gate)
    }

    /// The faults `holdThen` can end in (no nesting).
    enum FakeFault: Sendable {
        case http(Int)
        case transport(URLError.Code)
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
    /// [password-v1] Accounts by address (as Supabase keeps it): the password Supabase was given (auth_secret)
    /// and whether the address was confirmed.
    private var passwordAccounts: [String: (secret: String, confirmed: Bool)] = [:]
    /// [password-v1] Answers forced on signup / token?grant_type=password / resend: (status, error code or nil).
    private var forcedAuth: [String: (status: Int, code: String?)] = [:]
    /// [password-v1] The address in the user object (Supabase's own form of it).
    private var userEmail = FakeSupabase.email
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

    // MARK: password-v1 accounts

    /// An account that signs in with `secret` (the auth_secret Supabase keeps as the password).
    func addPasswordAccount(email: String, secret: String, confirmed: Bool = true) {
        passwordAccounts[email] = (secret, confirmed)
    }

    /// The account of `email` as signUp left it (nil when none).
    func passwordAccount(_ email: String) -> (secret: String, confirmed: Bool)? { passwordAccounts[email] }

    /// The next answers of `endpoint` ("signup", "password" for token?grant_type=password, "resend") are this
    /// status with GoTrue's error `code` (nil: no code, e.g. a bare 429 or Cloudflare's 500).
    func forceAuth(_ endpoint: String, status: Int, code: String?) { forcedAuth[endpoint] = (status, code) }

    /// What the user object of a sign-up answer says about `identities` (the real GoTrue's: one identity for a new or unconfirmed
    /// account, [] for a confirmed one; `.auto` picks by the address's account).
    enum SignUpIdentities: Sendable { case auto, empty, one, absent }
    private var signUpIdentities = SignUpIdentities.auto
    func setSignUpIdentities(_ mode: SignUpIdentities) { signUpIdentities = mode }
    /// Confirmations off: the sign-up answers a session (as GoTrue does when the address needs no mail).
    private var signUpAnswersWithSession = false
    func setSignUpAnswersWithSession(_ on: Bool) { signUpAnswersWithSession = on }

    /// Ends `forceAuth` for `endpoint`: the next answers are the fake's own again.
    func clearForcedAuth(_ endpoint: String) { forcedAuth[endpoint] = nil }

    /// The address Supabase answers in user.email (its own form of the address).
    func setUserEmail(_ email: String) { userEmail = email }

    /// An access token this fake issued (for a fake web endpoint that checks the Bearer).
    func isAccessToken(_ token: String) -> Bool { accessTokens.contains(token) }

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

    /// Another writer (the Web's key endpoints) changes the tables directly.
    func mutate(_ change: @Sendable (inout [String: [Row]]) -> Void) {
        change(&tables)
    }

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
            case let .gateway(status, body, contentType, applied):
                if applied { _ = route(request) }
                return .http(status: status, headers: ["Content-Type": contentType], body: Data(body.utf8))
            case let .delay(gate):
                let reply = route(request)
                await gate.wait()
                return reply
            case let .lostThenLate(gate, code, handled):
                Task { [self] in
                    await gate.wait()
                    await self.handleLate(request)
                    handled.open()
                }
                return .failure(code)
            case let .holdThen(gate, fault):
                await gate.wait()
                switch fault {
                case let .http(status):
                    return .json(status, ["code": "XX000", "message": "injected failure", "details": NSNull(), "hint": NSNull()])
                case let .transport(code):
                    return .failure(code)
                }
            }
        }
        return route(request)
    }

    private func handleLate(_ request: StubRequest) {
        _ = route(request)
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
            case .rateLimited: return Self.gotrueError(request, 429, "over_email_send_rate_limit", "email rate limit exceeded")
            case .captchaFailed: return Self.gotrueError(request, 400, "captcha_failed", "captcha protection: request disallowed")
            case .cloudflareDown: return .json(500, ["code": 500, "msg": "Internal Server Error"])
            }
        case ("POST", "verify"):
            if verifyMode == .rateLimited {
                return Self.gotrueError(request, 429, "over_request_rate_limit", "Request rate limit reached")
            }
            let token = request.jsonDictionary?["token"] as? String
            if verifyMode == .rejected || token != Self.goodCode {
                return Self.gotrueError(request, 403, "otp_expired", "Token has expired or is invalid")
            }
            return .json(200, newSession())
        case ("POST", "token") where request.query("grant_type").first == "password":
            if let forced = forcedAuth["password"] { return forcedReply(request, forced) }
            let body = request.jsonDictionary ?? [:]
            guard let address = body["email"] as? String, let secret = body["password"] as? String,
                  let account = passwordAccounts[address], account.secret == secret
            else {
                return Self.gotrueError(request, 400, "invalid_credentials", "Invalid login credentials")
            }
            guard account.confirmed else { return Self.gotrueError(request, 400, "email_not_confirmed", "Email not confirmed") }
            return .json(200, newSession())
        case ("POST", "token"):
            let refresh = request.jsonDictionary?["refresh_token"] as? String
            guard request.query("grant_type").first == "refresh_token", refreshMode == .ok, let refresh, refreshTokens.contains(refresh) else {
                return Self.gotrueError(request, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found")
            }
            return .json(200, newSession())
        case ("POST", "signup"):
            if let forced = forcedAuth["signup"] { return forcedReply(request, forced) }
            let body = request.jsonDictionary ?? [:]
            guard let address = body["email"] as? String, let secret = body["password"] as? String else {
                return Self.gotrueError(request, 400, "validation_failed", "missing email or password")
            }
            if signUpAnswersWithSession { return .json(200, newSession()) }
            let hadAccount = passwordAccounts[address] != nil
            let confirmedAccount = passwordAccounts[address]?.confirmed == true
            if !hadAccount { passwordAccounts[address] = (secret, false) }
            // Confirm email is on: the user object only, no session (also for an address that has an account).
            var u = user()
            u["email"] = address
            u["email_confirmed_at"] = NSNull()
            u["confirmed_at"] = NSNull()
            // GoTrue: a new account, and an unconfirmed one (its mail is sent again), has its email identity; an address with a confirmed account gets identities: [].
            let identity: [String: Any] = [
                "id": Self.me, "identity_id": "00000000-0000-4000-8000-0000000000a1", "user_id": Self.me,
                "identity_data": ["email": address], "provider": "email",
                "created_at": "2026-11-01T00:00:00.000000Z", "last_sign_in_at": "2026-11-01T00:00:00.000000Z",
                "updated_at": "2026-11-01T00:00:00.000000Z",
            ]
            switch signUpIdentities {
            case .auto: u["identities"] = confirmedAccount ? [Any]() : [identity]
            case .empty: u["identities"] = [Any]()
            case .one: u["identities"] = [identity]
            case .absent: u["identities"] = nil
            }
            return .json(200, u)
        case ("POST", "resend"):
            if let forced = forcedAuth["resend"] { return forcedReply(request, forced) }
            return .json(200, [String: Any]())
        case ("POST", "logout"):
            return .empty(204)
        case ("GET", "user"):
            guard bearerIsValid(request) else {
                return Self.gotrueError(request, 401, "bad_jwt", "invalid JWT")
            }
            return .json(200, user())
        default:
            return Self.gotrueError(request, 404, "not_found", "not found")
        }
    }

    /// GoTrue's error body. A client that sends `X-Supabase-Api-Version: 2024-01-01` (supabase-swift
    /// does) gets the newer shape {"code": "<error code>", "msg"} and the version header back, as the
    /// real server answers; other clients get the older {"code": <status>, "error_code", "msg"}.
    private static func gotrueError(_ request: StubRequest, _ status: Int, _ errorCode: String, _ msg: String) -> StubReply {
        if request.header("x-supabase-api-version") == "2024-01-01" {
            return .json(status, ["code": errorCode, "msg": msg], headers: ["X-Supabase-Api-Version": "2024-01-01"])
        }
        return .json(status, ["code": status, "error_code": errorCode, "msg": msg])
    }

    private func forcedReply(_ request: StubRequest, _ forced: (status: Int, code: String?)) -> StubReply {
        guard let code = forced.code else { return .json(forced.status, ["code": forced.status, "msg": "error"]) }
        return Self.gotrueError(request, forced.status, code, "error")
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
            "user": user(),
        ]
    }

    /// The user object with the address of setUserEmail.
    private func user() -> [String: Any] {
        var u = Self.user()
        u["email"] = userEmail
        return u
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
            if !Self.test(Self.value(row, name), expression) { return false }
        }
        return true
    }

    /// A column, or `column->>key` (a JSON object's value as text, null when absent), as PostgREST reads it.
    static func value(_ row: Row, _ name: String) -> JSONValue {
        guard let arrow = name.range(of: "->>") else { return row[name] ?? .null }
        let column = String(name[..<arrow.lowerBound])
        let key = String(name[arrow.upperBound...])
        guard case let .object(object)? = row[column], let inner = object[key] else { return .null }
        switch inner {
        case .null: return .null
        case .string: return inner
        default: return inner.text.map(JSONValue.string) ?? .null
        }
    }

    /// One PostgREST filter, with SQL's null semantics (a null value matches only `is.null`).
    static func test(_ value: JSONValue, _ expression: String) -> Bool {
        guard let dot = expression.firstIndex(of: ".") else { return false }
        let op = String(expression[..<dot])
        let arg = String(expression[expression.index(after: dot)...])
        // not.<op>.<arg>: SQL's NOT, so a null value still matches neither side (except not.is.null).
        if op == "not" {
            if arg.hasPrefix("is.") { return !test(value, arg) }
            guard value != .null else { return false }
            return !test(value, arg)
        }
        switch op {
        case "like", "ilike":
            guard case let .string(s) = value else { return false }
            return likeMatches(s, arg, caseInsensitive: op == "ilike")
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

    /// LIKE with % (or PostgREST's *) for any run and _ for one character.
    static func likeMatches(_ s: String, _ pattern: String, caseInsensitive: Bool) -> Bool {
        var regex = "^"
        for ch in pattern {
            switch ch {
            case "%", "*": regex += ".*"
            case "_": regex += "."
            default: regex += NSRegularExpression.escapedPattern(for: String(ch))
            }
        }
        regex += "$"
        let options: String.CompareOptions = caseInsensitive ? [.regularExpression, .caseInsensitive] : [.regularExpression]
        return s.range(of: regex, options: options) != nil
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
    private nonisolated(unsafe) static let keptFakeKey = UnsafeRawPointer(UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1))

    static func signedIn(_ fake: FakeSupabase, storage: InMemorySessionStorage = InMemorySessionStorage()) async throws -> (provider: SupabaseProvider, auth: AuthService) {
        let provider = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: storage)
        // The provider keeps its fake alive: a test that lets go of the fake but keeps a writer or a
        // model made from this provider still reaches it (the fake's deinit unregisters its host).
        objc_setAssociatedObject(provider, keptFakeKey, fake, .OBJC_ASSOCIATION_RETAIN)
        // Signed in through supabase-swift itself (the fake's code endpoint; the app has no code login any more),
        // then the app's AuthService reads the session.
        _ = try await provider.auth.verifyOTP(email: FakeSupabase.email, token: FakeSupabase.goodCode, type: .email)
        let auth = AuthService(provider: provider)
        await auth.checkSession()
        return (provider, auth)
    }
}
