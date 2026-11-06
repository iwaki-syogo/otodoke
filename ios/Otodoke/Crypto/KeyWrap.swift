// Opening the stored key, as src/lib/crypto/key-wrap.ts (2541793) openStoredKey does.
//   kek      PBKDF2-SHA256(NFKC(passphrase) as UTF-8, salt 16 bytes, 600,000 ... 10,000,000 rounds) -> 32 bytes
//   pkcs8    AES-256-GCM open(kek, wrap_iv 12 bytes, aad "otodoke/key/v1|<user_id>", wrapped_private_key)
//   then the private key from the PKCS#8 (or from d when CryptoKit cannot read it), its public point equal to
//   public_key, and keyIdOf(public_key) equal to key_id. CommonCrypto for PBKDF2, CryptoKit for the rest.
// Every field of the row is checked before PBKDF2 runs (it is the slow part).

import CommonCrypto
import CryptoKit
import Foundation

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
    /// PBKDF2 itself (password bytes, salt, iterations) -> 32 bytes. Injected in tests to see where and how
    /// often it runs.
    typealias KDF = @Sendable (_ password: Data, _ salt: Data, _ iterations: Int) throws(CryptoError) -> Data

    static let minIterations = 600_000
    static let maxIterations = 10_000_000

    /// minIterations ≤ n ≤ maxIterations.
    static func iterationsAllowed(_ n: Int) -> Bool {
        n >= minIterations && n <= maxIterations
    }

    /// normalizePassphrase: NFKC.
    static func normalize(_ passphrase: String) -> String {
        passphrase.precomposedStringWithCompatibilityMapping
    }

    /// CCKeyDerivationPBKDF (SHA-256, 32 bytes). .badKeyRow for iterations out of range or a salt that is not 16 bytes.
    static func pbkdf2(password: Data, salt: Data, iterations: Int) throws(CryptoError) -> Data {
        guard iterationsAllowed(iterations), salt.count == 16 else { throw .badKeyRow }
        var out = Data(repeating: 0, count: 32)
        let status = out.withUnsafeMutableBytes { (outBuf: UnsafeMutableRawBufferPointer) -> Int32 in
            password.withUnsafeBytes { (pw: UnsafeRawBufferPointer) -> Int32 in
                salt.withUnsafeBytes { (s: UnsafeRawBufferPointer) -> Int32 in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pw.baseAddress?.assumingMemoryBound(to: CChar.self),
                        pw.count,
                        s.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        s.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        UInt32(iterations),
                        outBuf.baseAddress?.assumingMemoryBound(to: UInt8.self),
                        outBuf.count
                    )
                }
            }
        }
        guard status == Int32(kCCSuccess) else { throw .badKeyRow }
        return out
    }

    /// The row's wrapped key, IV and salt, checked (lengths, base64, iteration count) before any PBKDF2.
    private struct CheckedWrap {
        let wrapped: Data
        let iv: Data
        let salt: Data
        let iterations: Int
        let aad: String
    }

    private static func check(_ row: StoredKeyRow, userID: String) throws(CryptoError) -> CheckedWrap {
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
        guard iv.count == 12, salt.count == 16, wrapped.count >= 16, iterationsAllowed(row.kdfIterations) else { throw .badKeyRow }
        return CheckedWrap(wrapped: wrapped, iv: iv, salt: salt, iterations: row.kdfIterations, aad: aad)
    }

    /// unwrapPrivateKeyBytes: the PKCS#8 bytes; .badKeyRow before PBKDF2 for a bad row, .wrongPassphrase when
    /// AES-GCM refuses.
    static func unwrapPrivateKeyBytes(_ row: StoredKeyRow, passphrase: String, userID: String, kdf: KDF = KeyWrap.pbkdf2) throws(CryptoError) -> Data {
        let w = try check(row, userID: userID)
        let kek = try kdf(Data(normalize(passphrase).utf8), w.salt, w.iterations)
        return try AESGCM.open(key: kek, iv: w.iv, sealed: w.wrapped, aad: Data(w.aad.utf8), failure: .wrongPassphrase)
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
    static func openStoredKey(_ row: StoredKeyRow, passphrase: String, userID: String, kdf: KDF = KeyWrap.pbkdf2) throws(CryptoError) -> PrivateRecipient {
        let publicKey: Data
        do {
            publicKey = try CryptoBytes.fromBase64(row.publicKey)
        } catch {
            throw .badKeyRow
        }
        var pkcs8 = try unwrapPrivateKeyBytes(row, passphrase: passphrase, userID: userID, kdf: kdf)
        defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
        let key = try privateKey(pkcs8: pkcs8)
        guard key.publicKey.x963Representation == publicKey else { throw .keyMismatch }
        guard keyIDOf(publicKey) == row.keyId else { throw .keyMismatch }
        return PrivateRecipient(keyID: row.keyId, publicKey: publicKey, privateKey: key)
    }
}
