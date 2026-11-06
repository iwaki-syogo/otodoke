// TDD-STUB(task 14): opening the stored key, as src/lib/crypto/key-wrap.ts (2541793) openStoredKey does.
//   kek      PBKDF2-SHA256(NFKC(passphrase) as UTF-8, salt 16 bytes, 600,000 ... 10,000,000 rounds) -> 32 bytes
//   pkcs8    AES-256-GCM open(kek, wrap_iv 12 bytes, aad "otodoke/key/v1|<user_id>", wrapped_private_key)
//   then the private key from the PKCS#8 (or from d when CryptoKit cannot read it), its public point equal to
//   public_key, and keyIdOf(public_key) equal to key_id. CommonCrypto for PBKDF2, CryptoKit for the rest.
// Names and signatures are the contract with CryptoVectorTests; the bodies return placeholders.

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
        false // TDD-STUB(task 14)
    }

    /// normalizePassphrase: NFKC.
    static func normalize(_ passphrase: String) -> String {
        "" // TDD-STUB(task 14)
    }

    /// CCKeyDerivationPBKDF (SHA-256, 32 bytes). .badKeyRow for iterations out of range or a salt that is not 16 bytes.
    static func pbkdf2(password: Data, salt: Data, iterations: Int) throws(CryptoError) -> Data {
        throw .badKeyRow // TDD-STUB(task 14)
    }

    /// unwrapPrivateKeyBytes: the PKCS#8 bytes; .badKeyRow before PBKDF2 for a bad row, .wrongPassphrase when
    /// AES-GCM refuses.
    static func unwrapPrivateKeyBytes(_ row: StoredKeyRow, passphrase: String, userID: String, kdf: KDF = KeyWrap.pbkdf2) throws(CryptoError) -> Data {
        throw .wrongPassphrase // TDD-STUB(task 14)
    }

    /// The private key from PKCS#8 (WebCrypto's export); from d inside it when CryptoKit does not read it.
    static func privateKey(pkcs8: Data) throws(CryptoError) -> P256.KeyAgreement.PrivateKey {
        throw .keyMismatch // TDD-STUB(task 14)
    }

    /// keyIdOf: the first 16 bytes of SHA-256(public key), lowercase hex.
    static func keyIDOf(_ publicKey: Data) -> String {
        "" // TDD-STUB(task 14)
    }

    /// openStoredKey: unwrap, read the key, prove it is the stored public key's pair and that key_id is its id.
    static func openStoredKey(_ row: StoredKeyRow, passphrase: String, userID: String, kdf: KDF = KeyWrap.pbkdf2) throws(CryptoError) -> PrivateRecipient {
        throw .wrongPassphrase // TDD-STUB(task 14)
    }
}
