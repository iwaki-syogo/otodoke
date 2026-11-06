import CryptoKit
import Foundation
@testable import Otodoke

/// [Batch 2, task 13/14] The crypto vectors scripts/ios-fixtures.ts writes outside git, into
/// ios/OtodokeTests/Fixtures/crypto/ (bundled as Fixtures/crypto/ in the test bundle):
///   envelope-v1.json   fixtures/crypto/envelope-v1.json, byte for byte
///   negative-v1.json   envelopes sealed by the Web whose plaintext is wrong (missing_key, version_2, bad_utf8)
/// A missing file is an error (the suites fail; they never skip). Run `npm run ios:fixtures` first.
enum CryptoVectorFiles {
    struct Missing: Error, CustomStringConvertible {
        let name: String
        var description: String { "Fixtures/crypto/\(name) is missing: run `npm run ios:fixtures` (scripts/ios-fixtures.ts)" }
    }

    static func url(_ name: String) -> URL? {
        let bundle = Bundle(for: FixtureBundleToken.self)
        let base = (name as NSString).deletingPathExtension
        if let u = bundle.url(forResource: base, withExtension: "json", subdirectory: "Fixtures/crypto") { return u }
        let local = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/crypto/\(name)")
        return FileManager.default.fileExists(atPath: local.path) ? local : nil
    }

    static func data(_ name: String) throws -> Data {
        guard let u = url(name) else { throw Missing(name: name) }
        return try Data(contentsOf: u)
    }

    static func object(_ name: String) throws -> [String: Any] {
        guard let o = try JSONSerialization.jsonObject(with: data(name)) as? [String: Any] else { throw Missing(name: name) }
        return o
    }
}

/// envelope-v1.json, read field by field.
struct EnvelopeVector {
    let root: [String: Any]

    init() throws {
        root = try CryptoVectorFiles.object("envelope-v1.json")
    }

    var envelopeSection: [String: Any] { root["envelope"] as? [String: Any] ?? [:] }
    var wrapSection: [String: Any] { root["key_wrap"] as? [String: Any] ?? [:] }
    var recipient: [String: Any] { envelopeSection["recipient"] as? [String: Any] ?? [:] }
    var ephemeral: [String: Any] { envelopeSection["ephemeral"] as? [String: Any] ?? [:] }

    func s(_ section: [String: Any], _ key: String) -> String { section[key] as? String ?? "" }
    /// Base64 decoded by Foundation (the test's own decoder, not the app's).
    func b(_ section: [String: Any], _ key: String) -> Data { Data(base64Encoded: s(section, key)) ?? Data() }

    var userID: String { s(envelopeSection, "user_id") }
    var emailID: String { s(envelopeSection, "email_id") }
    var aad: String { s(envelopeSection, "aad") }
    var keyID: String { s(recipient, "key_id") }
    var recipientPublic: Data { b(recipient, "public_key") }
    var recipientPKCS8: Data { b(recipient, "private_key_pkcs8") }
    var recipientD: Data { b(recipient, "private_key_d") }
    var ephemeralPublic: Data { b(ephemeral, "public_key") }
    var ephemeralD: Data { b(ephemeral, "private_key_d") }
    var z: Data { b(envelopeSection, "shared_secret_z") }
    var hkdfInfo: Data { b(envelopeSection, "hkdf_info") }
    var aesKey: Data { b(envelopeSection, "aes_key") }
    var plaintextJSON: String { s(envelopeSection, "plaintext_json") }
    var plaintext: MailPlaintext {
        let o = envelopeSection["plaintext_object"] as? [String: Any] ?? [:]
        return MailPlaintext(subject: o["subject"] as? String, fromName: o["from_name"] as? String, fromAddress: o["from_address"] as? String, text: o["text"] as? String, html: o["html"] as? String)
    }

    /// The envelope object as stored in body_envelope.
    var envelopeObject: [String: Any] { envelopeSection["envelope"] as? [String: Any] ?? [:] }
    var envelopeJSON: Data { (try? JSONSerialization.data(withJSONObject: envelopeObject)) ?? Data() }

    /// The envelope with one field replaced (or removed with nil), as JSON bytes.
    func envelopeJSON(replacing key: String, with value: Any?) -> Data {
        var o = envelopeObject
        o[key] = value
        return (try? JSONSerialization.data(withJSONObject: o)) ?? Data()
    }

    /// Base64 text of `key` with one bit of byte `at` flipped (Foundation's encoder).
    func flipped(_ key: String, at: Int) -> String {
        var bytes = Data(base64Encoded: envelopeObject[key] as? String ?? "") ?? Data()
        if at < bytes.count { bytes[bytes.startIndex + at] ^= 0x01 }
        return bytes.base64EncodedString()
    }

    // key wrap
    var passphrase: String { s(wrapSection, "passphrase") }
    var passphraseNFKC: String { s(wrapSection, "passphrase_nfkc") }
    var passphraseNFKCUTF8: Data { b(wrapSection, "passphrase_nfkc_utf8") }
    var kek: Data { b(wrapSection, "kek") }
    var salt: Data { b(wrapSection, "kdf_salt") }
    var iterations: Int { wrapSection["kdf_iterations"] as? Int ?? 0 }
    var wrapAAD: String { s(wrapSection, "aad") }

    /// The user_keys row this vector stands for (the key in use).
    func row(iterations: Int? = nil, salt: String? = nil, wrapIv: String? = nil, wrapped: String? = nil, keyID: String? = nil, publicKey: String? = nil) -> StoredKeyRow {
        StoredKeyRow(
            keyId: keyID ?? self.keyID,
            publicKey: publicKey ?? s(recipient, "public_key"),
            wrappedPrivateKey: wrapped ?? s(wrapSection, "wrapped_private_key"),
            wrapIv: wrapIv ?? s(wrapSection, "wrap_iv"),
            kdfSalt: salt ?? s(wrapSection, "kdf_salt"),
            kdfIterations: iterations ?? self.iterations,
            activatedAt: "2026-11-06T00:00:00+00:00",
            retiredAt: nil
        )
    }

    /// The vector's recipient, made by the test (CryptoKit from d), not by the code under test.
    func testRecipient() throws -> PrivateRecipient {
        let key = try P256.KeyAgreement.PrivateKey(rawRepresentation: recipientD)
        return PrivateRecipient(keyID: keyID, publicKey: recipientPublic, privateKey: key)
    }

    /// The user_keys row in the database's JSON shape (for FakeSupabase).
    func keyRow(userID: String, activated: Bool = true) -> Row {
        [
            "id": .string(UUID().uuidString.lowercased()),
            "user_id": .string(userID),
            "key_id": .string(keyID),
            "public_key": .string(s(recipient, "public_key")),
            "wrapped_private_key": .string(s(wrapSection, "wrapped_private_key")),
            "wrap_iv": .string(s(wrapSection, "wrap_iv")),
            "kdf_salt": .string(s(wrapSection, "kdf_salt")),
            "kdf_iterations": .int(iterations),
            "activated_at": activated ? "2026-11-06T00:00:00+00:00" : nil,
            "retired_at": nil,
            "created_at": "2026-11-06T00:00:00+00:00",
        ]
    }
}

/// negative-v1.json: each entry's name, ids, AAD and envelope (as JSON bytes).
struct NegativeVectors {
    struct Mail {
        let name: String
        let userID: String
        let emailID: String
        let aad: String
        let envelopeJSON: Data
    }

    let mail: [Mail]

    init() throws {
        let root = try CryptoVectorFiles.object("negative-v1.json")
        let list = root["mail"] as? [[String: Any]] ?? []
        mail = list.map { m in
            Mail(
                name: m["name"] as? String ?? "",
                userID: m["user_id"] as? String ?? "",
                emailID: m["email_id"] as? String ?? "",
                aad: m["aad"] as? String ?? "",
                envelopeJSON: (try? JSONSerialization.data(withJSONObject: m["envelope"] ?? [:])) ?? Data()
            )
        }
    }

    func named(_ name: String) -> Mail? { mail.first { $0.name == name } }
}
