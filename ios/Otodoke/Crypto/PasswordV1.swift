// password-v1 (docs/crypto/password-v1.md): one password gives the login secret and the key-encryption key.
//   email_norm    the address with U+0009 U+000A U+000C U+000D U+0020 taken off both ends, A-Z made a-z
//                 (on unicodeScalars; never trimmingCharacters(in:) or lowercased())
//   salt_pw       UTF-8("otodoke/pw/v1|" + email_norm)
//   password_norm NFKC(password), nothing trimmed: decomposedStringWithCompatibilityMapping then
//                 precomposedStringWithCanonicalMapping (Foundation's precomposedStringWithCompatibilityMapping
//                 leaves the voiced marks of half-width katakana uncomposed)
//   master        PBKDF2-HMAC-SHA256(UTF-8(password_norm), salt_pw, 600000, 32)  (never the row's kdf_iterations)
//   auth_secret   lowercase hex of HKDF-SHA256(master, salt empty, info "otodoke/auth/v1", 32)
//   KEK           HKDF-SHA256(master, salt kdf_salt (16 bytes), info "otodoke/kek/v1", 32)
// PBKDF2 runs off the main thread, one at a time (PasswordV1Deriver). The password, master, the KEK and
// auth_secret never reach a log line, a print or an error.
//
// TDD-STUB(password-v1): names and signatures only. Every body answers a wrong value (never fatalError).

import CommonCrypto
import CryptoKit
import Foundation

enum PasswordV1 {
    /// PBKDF2 itself (password bytes, salt, rounds) -> 32 bytes. Injected in tests to see where, how often and
    /// with which round count it runs.
    typealias KDF = @Sendable (_ password: Data, _ salt: Data, _ iterations: Int) throws(CryptoError) -> Data

    /// The round count of master, fixed by this version (the row's kdf_iterations is a record only).
    static let iterations = 600_000
    static let saltPrefix = "otodoke/pw/v1|"
    static let authInfo = "otodoke/auth/v1"
    static let kekInfo = "otodoke/kek/v1"

    /// Step 1. TDD-STUB(password-v1)
    static func emailNorm(_ email: String) -> String {
        ""
    }

    /// Step 2: UTF-8("otodoke/pw/v1|" + emailNorm(email)). TDD-STUB(password-v1)
    static func saltPW(email: String) -> Data {
        Data()
    }

    /// Step 3: NFKC, nothing trimmed. TDD-STUB(password-v1)
    static func passwordNorm(_ password: String) -> String {
        ""
    }

    /// CCKeyDerivationPBKDF (HMAC-SHA256, 32 bytes) for any salt length. TDD-STUB(password-v1)
    static func pbkdf2(password: Data, salt: Data, iterations: Int) throws(CryptoError) -> Data {
        Data()
    }

    /// Step 4: kdf(UTF-8(passwordNorm(password)), saltPW(email), 600000). TDD-STUB(password-v1)
    static func master(password: String, email: String, kdf: KDF = PasswordV1.pbkdf2) throws(CryptoError) -> Data {
        Data()
    }

    /// Step 5: the 64-character lowercase hex sent to Supabase Auth as the password. TDD-STUB(password-v1)
    static func authSecret(master: Data) -> String {
        ""
    }

    /// Step 6: .badKeyRow unless kdfSalt is 16 bytes (and master 32). TDD-STUB(password-v1)
    static func kek(master: Data, kdfSalt: Data) throws(CryptoError) -> Data {
        Data()
    }

    /// The row's kdf_salt (base64) -> KEK -> KeyWrap.openStoredKey(_:kek:userID:). Never reads kdf_iterations.
    /// TDD-STUB(password-v1)
    static func openStoredKey(_ row: StoredKeyRow, master: Data, userID: String) throws(CryptoError) -> PrivateRecipient {
        let key = AgreementPrivate()
        return PrivateRecipient(keyID: "", publicKey: Data(), privateKey: key)
    }
}

/// master, off the main thread and one at a time: a call made while another runs waits for it (never two
/// PBKDF2 at once), then runs. TDD-STUB(password-v1)
final class PasswordV1Deriver: Sendable {
    private let kdf: PasswordV1.KDF

    init(kdf: @escaping PasswordV1.KDF = PasswordV1.pbkdf2) {
        self.kdf = kdf
    }

    /// TDD-STUB(password-v1)
    func master(password: String, email: String) async throws(CryptoError) -> Data {
        Data()
    }
}
