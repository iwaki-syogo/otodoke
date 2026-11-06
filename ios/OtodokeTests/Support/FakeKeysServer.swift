import CryptoKit
import Foundation
@testable import Otodoke

/// [password-login] The Web's key endpoints (docs/api/keys.md, integrate/password-v1 3449af0) as a stub server
/// on its own made-up host, writing the user_keys rows into a FakeSupabase (so the app reads them back through
/// PostgREST as it does from the real database). It checks what the real one checks:
///  - POST only, `Content-Type: application/json`, `Authorization: Bearer <a token FakeSupabase issued>` (else
///    401 unauthorized);
///  - exactly the fields keys.md lists (a missing or extra field is 400 invalid_input), kdfIterations 600000,
///    base64 lengths (publicKey 65 bytes, wrapIv 12, kdfSalt 16);
///  - register: a pending row (a newer registration replaces an older pending one), a 32-byte challenge sealed
///    to the new public key with the AAD `otodoke/key-challenge/v1|<user_id>|<key_id>` (sealed here with the
///    test's own CryptoKit code, not the app's);
///  - activate: the pending row (else 409 key_not_pending), the challenge bytes (else 422 key_challenge_failed),
///    the key in use is expectedCurrentKeyId (else 409 key_in_use_changed); the old key retired, this one activated.
/// Answers can be forced per endpoint and nth request, held on a Gate, or preceded by a change of the data.
actor FakeKeysServer {
    nonisolated let host: String
    nonisolated let baseURL: URL
    nonisolated let urlSession: URLSession
    let supabase: FakeSupabase

    enum Forced: Sendable {
        case answer(status: Int, code: String)
        case transport(URLError.Code)
    }

    private(set) var requests: [StubRequest] = []
    private var forced: [String: [Int: Forced]] = [:]
    private var gates: [String: Gate] = [:]
    private var hooks: [String: @Sendable () async -> Void] = [:]
    private var challenges: [String: Data] = [:]
    /// The challenge is sealed to another key (the app must not activate).
    private var sealToAnotherKey = false

    static let registerFields: Set<String> = ["publicKey", "wrappedPrivateKey", "wrapIv", "kdfSalt", "kdfIterations", "expectedCurrentKeyId"]
    static let activateFields: Set<String> = ["keyId", "challenge", "expectedCurrentKeyId"]

    private init(supabase: FakeSupabase) {
        self.supabase = supabase
        host = "\(UUID().uuidString.lowercased()).web.test"
        baseURL = URL(string: "https://\(host)")!
        urlSession = StubURLProtocol.makeSession()
    }

    static func make(supabase: FakeSupabase) -> FakeKeysServer {
        let server = FakeKeysServer(supabase: supabase)
        StubURLProtocol.register(host: server.host) { [weak server] request in
            guard let server else { return .failure(.cancelled) }
            return await server.handle(request)
        }
        return server
    }

    deinit {
        StubURLProtocol.unregister(host: host)
    }

    // MARK: settings

    /// The nth (1-based) request to `endpoint` ("register", "activate") gets `answer` (nothing is applied).
    func force(_ endpoint: String, nth: Int = 1, _ answer: Forced) {
        forced[endpoint, default: [:]][nth] = answer
    }

    /// Every request to `endpoint` waits for the gate before it is handled.
    func hold(_ endpoint: String, on gate: Gate) { gates[endpoint] = gate }

    /// Runs once, just before the next request to `endpoint` is handled.
    func before(_ endpoint: String, _ action: @escaping @Sendable () async -> Void) { hooks[endpoint] = action }

    func sealChallengeToAnotherKey() { sealToAnotherKey = true }

    func requests(_ endpoint: String) -> [StubRequest] { requests.filter { $0.url.lastPathComponent == endpoint } }
    func count(_ endpoint: String) -> Int { requests(endpoint).count }

    // MARK: handling

    private func handle(_ request: StubRequest) async -> StubReply {
        requests.append(request)
        let endpoint = request.url.lastPathComponent
        let nth = requests.filter { $0.url.lastPathComponent == endpoint }.count
        if let gate = gates[endpoint] { await gate.wait() }
        if let hook = hooks.removeValue(forKey: endpoint) { await hook() }
        if let f = forced[endpoint]?[nth] {
            switch f {
            case let .answer(status, code): return Self.failure(status, code)
            case let .transport(code): return .failure(code)
            }
        }
        guard request.method == "POST", request.url.path.hasPrefix("/api/keys/") else { return .json(405, ["ok": false]) }
        guard (request.header("content-type") ?? "").hasPrefix("application/json") else { return Self.failure(400, "invalid_input") }
        guard let auth = request.header("authorization"), auth.hasPrefix("Bearer "),
              await supabase.isAccessToken(String(auth.dropFirst("Bearer ".count)))
        else { return Self.failure(401, "unauthorized") }
        guard let body = request.jsonDictionary else { return Self.failure(400, "invalid_input") }
        switch endpoint {
        case "register": return await register(body)
        case "activate": return await activate(body)
        default: return .json(404, ["ok": false])
        }
    }

    static func failure(_ status: Int, _ code: String) -> StubReply {
        .json(status, ["ok": false, "code": code], headers: ["Cache-Control": "no-store"])
    }

    private static func bytes(_ value: Any?, count: Int? = nil) -> Data? {
        guard let text = value as? String, let data = Data(base64Encoded: text), data.base64EncodedString() == text else { return nil }
        if let count, data.count != count { return nil }
        return data
    }

    private static func keyID(_ value: Any?) -> String?? {
        if value is NSNull { return .some(nil) }
        guard let text = value as? String, text.wholeMatch(of: /[0-9a-f]{32}/) != nil else { return nil }
        return .some(text)
    }

    /// The key in use now (activated, not retired).
    private func keyInUse() async -> String? {
        await supabase.rows("user_keys").first { isSet($0["activated_at"]) && !isSet($0["retired_at"]) }?["key_id"]?.text
    }

    private func register(_ body: [String: Any]) async -> StubReply {
        guard Set(body.keys) == Self.registerFields,
              let publicKey = Self.bytes(body["publicKey"], count: 65), publicKey.first == 0x04,
              let wrapped = Self.bytes(body["wrappedPrivateKey"]), wrapped.count > 16,
              Self.bytes(body["wrapIv"], count: 12) != nil,
              Self.bytes(body["kdfSalt"], count: 16) != nil,
              (body["kdfIterations"] as? Int) == 600_000,
              let expected = Self.keyID(body["expectedCurrentKeyId"])
        else { return Self.failure(400, "invalid_input") }
        guard await keyInUse() == expected else { return Self.failure(409, "key_in_use_changed") }
        let keyID = TestSeal.keyID(publicKey)
        let me = FakeSupabase.me
        let publicText = body["publicKey"] as? String ?? ""
        let wrappedText = body["wrappedPrivateKey"] as? String ?? ""
        let ivText = body["wrapIv"] as? String ?? ""
        let saltText = body["kdfSalt"] as? String ?? ""
        await supabase.mutate { tables in
            tables["user_keys", default: []].removeAll { $0["user_id"] == .string(me) && !isSet($0["activated_at"]) }
            tables["user_keys", default: []].append([
                "user_id": .string(me),
                "key_id": .string(keyID),
                "public_key": .string(publicText),
                "wrapped_private_key": .string(wrappedText),
                "wrap_iv": .string(ivText),
                "kdf_salt": .string(saltText),
                "kdf_iterations": 600_000,
                "activated_at": nil,
                "retired_at": nil,
            ])
        }
        let challenge = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        challenges[keyID] = challenge
        let sealTo = sealToAnotherKey ? AgreementPrivate().publicKey.x963Representation : publicKey
        let envelope = TestSeal.seal(challenge, to: sealTo, kid: keyID, aad: "otodoke/key-challenge/v1|\(me)|\(keyID)")
        return .json(200, ["ok": true, "keyId": keyID, "challenge": envelope], headers: ["Cache-Control": "no-store"])
    }

    private func activate(_ body: [String: Any]) async -> StubReply {
        guard Set(body.keys) == Self.activateFields,
              let keyIDValue = Self.keyID(body["keyId"]), let keyID = keyIDValue,
              let answer = Self.bytes(body["challenge"], count: 32),
              let expected = Self.keyID(body["expectedCurrentKeyId"])
        else { return Self.failure(400, "invalid_input") }
        let pending = await supabase.rows("user_keys").contains { $0["key_id"] == .string(keyID) && !isSet($0["activated_at"]) }
        guard pending, let challenge = challenges[keyID] else { return Self.failure(409, "key_not_pending") }
        guard answer == challenge else { return Self.failure(422, "key_challenge_failed") }
        guard await keyInUse() == expected else { return Self.failure(409, "key_in_use_changed") }
        await supabase.mutate { tables in
            var rows = tables["user_keys", default: []]
            for i in rows.indices {
                if rows[i]["key_id"] == .string(keyID) {
                    rows[i]["activated_at"] = JSONValue.string("2026-11-07T00:00:00.000000+00:00")
                } else if isSet(rows[i]["activated_at"]), !isSet(rows[i]["retired_at"]) {
                    rows[i]["retired_at"] = JSONValue.string("2026-11-07T00:00:00.000000+00:00")
                }
            }
            tables["user_keys"] = rows
        }
        challenges[keyID] = nil
        return .json(200, ["ok": true, "keyId": keyID], headers: ["Cache-Control": "no-store"])
    }
}

/// A column that holds a value (neither absent nor JSON null).
func isSet(_ value: JSONValue?) -> Bool {
    guard let value else { return false }
    return value != .null
}

/// Envelope v1 sealing, written with CryptoKit for the tests (the app only opens): an ephemeral P-256 key,
/// Z = ECDH x, key = HKDF-SHA256(Z, salt "otodoke/mail/v1", info epk || recipient public), AES-256-GCM(iv 12, aad).
enum TestSeal {
    static func keyID(_ publicKey: Data) -> String {
        SHA256.hash(data: publicKey).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    static func seal(_ plaintext: Data, to recipientPublic: Data, kid: String, aad: String) -> [String: Any] {
        let ephemeral = P256.KeyAgreement.PrivateKey()
        let epk = ephemeral.publicKey.x963Representation
        let peer = try! P256.KeyAgreement.PublicKey(x963Representation: recipientPublic)
        let z = try! ephemeral.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: z), salt: Data("otodoke/mail/v1".utf8), info: epk + recipientPublic, outputByteCount: 32)
        let iv = Data((0..<12).map { _ in UInt8.random(in: 0...255) })
        let box = try! AES.GCM.seal(plaintext, using: key, nonce: AES.GCM.Nonce(data: iv), authenticating: Data(aad.utf8))
        return [
            "v": 1,
            "alg": "P256-HKDF-SHA256-A256GCM",
            "kid": kid,
            "epk": epk.base64EncodedString(),
            "iv": iv.base64EncodedString(),
            "ct": (box.ciphertext + box.tag).base64EncodedString(),
        ]
    }
}
