import CryptoKit
import Foundation
@testable import Otodoke

/// [password-v1] fixtures/crypto/password-v1.json, which scripts/ios-fixtures.ts copies byte for byte into
/// ios/OtodokeTests/Fixtures/crypto/ (outside git; `npm run ios:fixtures`). A missing file fails the suites
/// (never skips). Every value is read with the test's own decoders (hex, Foundation base64), never the app's.
struct PasswordV1Vectors {
    struct Case {
        let name: String
        /// As typed (JSON's \u escapes decoded; Swift keeps the code points as they are).
        let email: String
        let password: String
        let emailNorm: String
        let passwordNorm: String
        let saltPW: Data
        let passwordNormUTF8: Data
        let master: Data
        let authSecret: String
        let userID: String
        let kdfSalt: Data
        let kek: Data
        let aad: String
        let wrapIV: Data
        let wrapCiphertext: Data
        let wrapTag: Data
        /// user_keys_row exactly as stored (the JSON object).
        let rowObject: [String: Any]

        func rowString(_ key: String) -> String { rowObject[key] as? String ?? "" }

        /// user_keys_row as the app reads it, with fields replaced on request.
        func row(iterations: Int? = nil, salt: String? = nil, wrapIv: String? = nil, wrapped: String? = nil, keyID: String? = nil, publicKey: String? = nil) -> StoredKeyRow {
            StoredKeyRow(
                keyId: keyID ?? rowString("key_id"),
                publicKey: publicKey ?? rowString("public_key"),
                wrappedPrivateKey: wrapped ?? rowString("wrapped_private_key"),
                wrapIv: wrapIv ?? rowString("wrap_iv"),
                kdfSalt: salt ?? rowString("kdf_salt"),
                kdfIterations: iterations ?? (rowObject["kdf_iterations"] as? Int ?? 0),
                activatedAt: "2026-11-06T00:00:00+00:00",
                retiredAt: nil
            )
        }
    }

    static let fileName = "password-v1.json"

    let root: [String: Any]
    let cases: [Case]
    let d: Data
    let pkcs8: Data
    let publicKey: Data
    let keyID: String
    let constants: [String: Any]

    init() throws {
        root = try CryptoVectorFiles.object(Self.fileName)
        let key = root["private_key"] as? [String: Any] ?? [:]
        d = hexData(key["d_hex"] as? String ?? "")
        pkcs8 = hexData(key["pkcs8_hex"] as? String ?? "")
        publicKey = hexData(key["public_key_hex"] as? String ?? "")
        keyID = key["key_id"] as? String ?? ""
        constants = root["constants"] as? [String: Any] ?? [:]
        let list = root["cases"] as? [[String: Any]] ?? []
        cases = list.map { c in
            func s(_ k: String) -> String { c[k] as? String ?? "" }
            return Case(
                name: s("name"),
                email: s("email"),
                password: s("password"),
                emailNorm: s("email_norm"),
                passwordNorm: s("password_norm"),
                saltPW: hexData(s("salt_pw_hex")),
                passwordNormUTF8: hexData(s("password_norm_utf8_hex")),
                master: hexData(s("master_hex")),
                authSecret: s("auth_secret"),
                userID: s("user_id"),
                kdfSalt: hexData(s("kdf_salt_hex")),
                kek: hexData(s("kek_hex")),
                aad: s("aad"),
                wrapIV: hexData(s("wrap_iv_hex")),
                wrapCiphertext: hexData(s("wrap_ciphertext_hex")),
                wrapTag: hexData(s("wrap_tag_hex")),
                rowObject: c["user_keys_row"] as? [String: Any] ?? [:]
            )
        }
    }

    func named(_ name: String) -> Case? { cases.first { $0.name == name } }

    /// The vector's private key, made by the test (CryptoKit from d), not by the code under test.
    func testPrivateKey() throws -> P256.KeyAgreement.PrivateKey {
        try P256.KeyAgreement.PrivateKey(rawRepresentation: d)
    }
}

/// Lowercase or uppercase hex to bytes (the test's own decoder). An odd length or a non-hex digit gives the
/// bytes read so far plus 0xEE, so a broken field never equals a real value.
func hexData(_ hex: String) -> Data {
    var out = Data()
    var high: UInt8?
    for c in hex.utf8 {
        let v: UInt8
        switch c {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): v = c - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): v = c - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): v = c - UInt8(ascii: "A") + 10
        default:
            out.append(0xEE)
            return out
        }
        if let h = high {
            out.append(h << 4 | v)
            high = nil
        } else {
            high = v
        }
    }
    if high != nil { out.append(0xEE) }
    return out
}

/// A UUID with uppercase letters. The vectors' user_id values are digits only, so their uppercased() is the
/// same text and proves nothing; this one's lowercase form would be a valid AAD id, and it must be refused (.badID).
let upperUUID = "00000000-0000-4000-8000-0000000000AB"

/// The UTF-8 bytes of a String (what every comparison of text here uses: Swift's == is canonical equivalence).
func utf8Bytes(_ s: String) -> [UInt8] { Array(s.utf8) }

/// PBKDF2 for password-v1, recorded: what it was called with, how often, on which thread, how many at once.
/// Delegates to `inner` (the app's PasswordV1.pbkdf2 by default); can be slowed down to see overlap.
final class PasswordKDFRecorder: @unchecked Sendable {
    struct Call: Equatable {
        let password: Data
        let salt: Data
        let iterations: Int
        let onMainThread: Bool
    }

    private let lock = NSLock()
    private var log: [Call] = []
    private var running = 0
    private var most = 0
    private let delay: TimeInterval
    private let inner: PasswordV1.KDF

    init(delay: TimeInterval = 0, inner: @escaping PasswordV1.KDF = PasswordV1.pbkdf2) {
        self.delay = delay
        self.inner = inner
    }

    var calls: [Call] { lock.withLock { log } }
    var maxAtOnce: Int { lock.withLock { most } }

    var kdf: PasswordV1.KDF {
        { [self] (password: Data, salt: Data, iterations: Int) throws(CryptoError) -> Data in
            lock.withLock {
                log.append(Call(password: password, salt: salt, iterations: iterations, onMainThread: Thread.isMainThread))
                running += 1
                most = max(most, running)
            }
            defer { lock.withLock { running -= 1 } }
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            return try inner(password, salt, iterations)
        }
    }
}

extension NewKeyRow {
    /// As the app would read the row back.
    var stored: StoredKeyRow {
        StoredKeyRow(keyId: keyID, publicKey: publicKey, wrappedPrivateKey: wrappedPrivateKey, wrapIv: wrapIv, kdfSalt: kdfSalt, kdfIterations: kdfIterations, activatedAt: nil, retiredAt: nil)
    }
}
