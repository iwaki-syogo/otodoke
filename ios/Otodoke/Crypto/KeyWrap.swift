// Wrapping and opening the stored key with the KEK (password-v1, docs/crypto/password-v1.md step 7; the
// wrap of src/lib/crypto/key-wrap.ts, only the KEK made differently):
//   pkcs8    AES-256-GCM(key = KEK, iv = wrap_iv 12 bytes, aad "otodoke/key/v1|<user_id>", plaintext = PKCS#8)
//            stored as base64(ciphertext || 16-byte tag), the IV on its own
//   then the private key from the PKCS#8 (or from d when CryptoKit cannot read it), its public point equal to
//   public_key, and keyIdOf(public_key) equal to key_id. The KEK comes from PasswordV1 (master and the row's
//   kdf_salt); the row's kdf_iterations is never read here. A refusal of AES-GCM is .wrongPassword.
// Every field of the row is checked before the KEK is made.

import CryptoKit
import Foundation
import Security

/// A user_keys row as the app reads it (the key in use).
struct StoredKeyRow: Decodable, Equatable, Sendable {
    let keyId: String
    let publicKey: String
    let wrappedPrivateKey: String
    let wrapIv: String
    let kdfSalt: String
    let kdfIterations: Int
    var activatedAt: String? = nil
    var retiredAt: String? = nil

    enum CodingKeys: String, CodingKey {
        case keyId = "key_id"
        case publicKey = "public_key"
        case wrappedPrivateKey = "wrapped_private_key"
        case wrapIv = "wrap_iv"
        case kdfSalt = "kdf_salt"
        case kdfIterations = "kdf_iterations"
        case activatedAt = "activated_at"
        case retiredAt = "retired_at"
    }
}

enum KeyWrap {
    /// The row's wrapped key, IV and salt, checked (ids, lengths, base64). kdf_iterations is not looked at.
    struct CheckedWrap {
        let wrapped: Data
        let iv: Data
        let salt: Data
        let aad: String
    }

    static func check(_ row: StoredKeyRow, userID: String) throws(CryptoError) -> CheckedWrap {
        let aad = try CryptoAAD.key(userID: userID)
        let iv: Data
        let salt: Data
        let wrapped: Data
        do {
            iv = try CryptoBytes.fromBase64(row.wrapIv)
            salt = try CryptoBytes.fromBase64(row.kdfSalt)
            wrapped = try CryptoBytes.fromBase64(row.wrappedPrivateKey)
        } catch {
            throw .badKeyRow
        }
        guard iv.count == 12, salt.count == 16, wrapped.count >= 16 else { throw .badKeyRow }
        return CheckedWrap(wrapped: wrapped, iv: iv, salt: salt, aad: aad)
    }

    /// 12 bytes from the system's secure random source.
    static func randomIV() throws(CryptoError) -> Data {
        try randomBytes(12)
    }

    /// `count` bytes from SecRandomCopyBytes; .badKeyRow if the system refuses.
    static func randomBytes(_ count: Int) throws(CryptoError) -> Data {
        var out = Data(repeating: 0, count: count)
        let status = out.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        guard status == errSecSuccess else { throw .badKeyRow }
        return out
    }

    /// A new random 12-byte IV for every call. .badID unless userID is a lowercase UUID; .badKeyRow unless the
    /// KEK is 32 bytes.
    static func wrap(pkcs8: Data, kek: Data, userID: String) throws(CryptoError) -> WrappedPrivateKey {
        try wrap(pkcs8: pkcs8, kek: kek, userID: userID, iv: randomIV())
    }

    /// The same with a given IV (the vectors, and KeyGeneration's row). .badKeyRow unless the IV is 12 bytes.
    static func wrap(pkcs8: Data, kek: Data, userID: String, iv: Data) throws(CryptoError) -> WrappedPrivateKey {
        let aad = try CryptoAAD.key(userID: userID)
        guard kek.count == 32, iv.count == 12 else { throw .badKeyRow }
        do {
            let box = try AES.GCM.seal(pkcs8, using: SymmetricKey(data: kek), nonce: AES.GCM.Nonce(data: iv), authenticating: Data(aad.utf8))
            // ciphertext || tag (not `combined`, which puts the nonce in front).
            return WrappedPrivateKey(iv: iv, sealed: box.ciphertext + box.tag)
        } catch {
            throw .badKeyRow
        }
    }

    /// The PKCS#8 bytes: .badKeyRow / .badBase64 for a bad row (iv 12, salt 16, wrapped ≥ 16 bytes),
    /// .badID for an AAD id that is not a lowercase UUID, .wrongPassword when AES-GCM refuses.
    static func unwrapPrivateKeyBytes(_ row: StoredKeyRow, kek: Data, userID: String) throws(CryptoError) -> Data {
        let w = try check(row, userID: userID)
        guard kek.count == 32 else { throw .wrongPassword }
        return try AESGCM.open(key: kek, iv: w.iv, sealed: w.wrapped, aad: Data(w.aad.utf8), failure: .wrongPassword)
    }

    /// The private key from PKCS#8 (WebCrypto's export); from d inside it when CryptoKit does not read it.
    static func privateKey(pkcs8: Data) throws(CryptoError) -> AgreementPrivate {
        if let key = try? AgreementPrivate(derRepresentation: pkcs8) { return key }
        guard let d = scalarInPKCS8(pkcs8), let key = try? AgreementPrivate(rawRepresentation: d) else { throw .keyMismatch }
        return key
    }

    /// d of the ECPrivateKey inside a PKCS#8: `INTEGER 1, OCTET STRING (32 bytes)` (RFC 5915), the first one found.
    private static func scalarInPKCS8(_ der: Data) -> Data? {
        let bytes = [UInt8](der)
        let marker: [UInt8] = [0x02, 0x01, 0x01, 0x04, 0x20]
        guard bytes.count >= marker.count + 32 else { return nil }
        for i in 0...(bytes.count - marker.count - 32) where Array(bytes[i..<(i + marker.count)]) == marker {
            return Data(bytes[(i + marker.count)..<(i + marker.count + 32)])
        }
        return nil
    }

    /// keyIdOf: the first 16 bytes of SHA-256(public key), lowercase hex.
    static func keyIDOf(_ publicKey: Data) -> String {
        CryptoBytes.toHex(CryptoBytes.sha256(publicKey).prefix(16))
    }

    /// openStoredKey: unwrap, read the key, prove it is the stored public key's pair and that key_id is its id.
    static func openStoredKey(_ row: StoredKeyRow, kek: Data, userID: String) throws(CryptoError) -> PrivateRecipient {
        let publicKey: Data
        do {
            publicKey = try CryptoBytes.fromBase64(row.publicKey)
        } catch {
            throw .badKeyRow
        }
        var pkcs8 = try unwrapPrivateKeyBytes(row, kek: kek, userID: userID)
        defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
        let key = try privateKey(pkcs8: pkcs8)
        guard key.publicKey.x963Representation == publicKey else { throw .keyMismatch }
        guard keyIDOf(publicKey) == row.keyId else { throw .keyMismatch }
        return PrivateRecipient(keyID: row.keyId, publicKey: publicKey, privateKey: key)
    }
}

/// What a wrap gives: the IV (12 bytes) and ciphertext || tag.
struct WrappedPrivateKey: Equatable, Sendable {
    let iv: Data
    let sealed: Data
}
