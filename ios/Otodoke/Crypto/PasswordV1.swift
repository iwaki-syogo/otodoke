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

    /// U+0009 U+000A U+000C U+000D U+0020 (WHATWG "ASCII whitespace").
    private static func isASCIIWhitespace(_ s: Unicode.Scalar) -> Bool {
        switch s.value {
        case 0x09, 0x0A, 0x0C, 0x0D, 0x20: true
        default: false
        }
    }

    /// Step 1: the five ASCII whitespaces off both ends, then A-Z to a-z; every other code point as it is.
    static func emailNorm(_ email: String) -> String {
        let scalars = Array(email.unicodeScalars)
        var start = 0
        var end = scalars.count
        while start < end, isASCIIWhitespace(scalars[start]) { start += 1 }
        while end > start, isASCIIWhitespace(scalars[end - 1]) { end -= 1 }
        var out = String.UnicodeScalarView()
        for s in scalars[start..<end] {
            if s.value >= 0x41, s.value <= 0x5A, let lower = Unicode.Scalar(s.value + 0x20) {
                out.append(lower)
            } else {
                out.append(s)
            }
        }
        return String(out)
    }

    /// Step 2: UTF-8("otodoke/pw/v1|" + emailNorm(email)).
    static func saltPW(email: String) -> Data {
        Data((saltPrefix + emailNorm(email)).utf8)
    }

    /// Step 3: NFKC as the compatibility decomposition then the canonical composition. Nothing trimmed.
    static func passwordNorm(_ password: String) -> String {
        password.decomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping
    }

    /// CCKeyDerivationPBKDF (HMAC-SHA256, 32 bytes) for any salt length. .badKeyRow for a round count of 0 or
    /// less, or a failure of CommonCrypto.
    static func pbkdf2(password: Data, salt: Data, iterations: Int) throws(CryptoError) -> Data {
        guard iterations > 0, iterations <= Int(UInt32.max) else { throw .badKeyRow }
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

    /// Step 4: kdf(UTF-8(passwordNorm(password)), saltPW(email), 600000).
    static func master(password: String, email: String, kdf: KDF = PasswordV1.pbkdf2) throws(CryptoError) -> Data {
        var bytes = Data(passwordNorm(password).utf8)
        defer { bytes.resetBytes(in: 0..<bytes.count) }
        return try kdf(bytes, saltPW(email: email), iterations)
    }

    private static func hkdf(_ ikm: Data, salt: Data, info: String) -> Data {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data(info.utf8), outputByteCount: 32)
        return key.withUnsafeBytes { Data($0) }
    }

    /// Step 5: the 64-character lowercase hex sent to Supabase Auth as the password (HKDF with an empty salt).
    static func authSecret(master: Data) -> String {
        CryptoBytes.toHex(hkdf(master, salt: Data(), info: authInfo))
    }

    /// Step 6: .badKeyRow unless kdfSalt is 16 bytes and master 32.
    static func kek(master: Data, kdfSalt: Data) throws(CryptoError) -> Data {
        guard master.count == 32, kdfSalt.count == 16 else { throw .badKeyRow }
        return hkdf(master, salt: kdfSalt, info: kekInfo)
    }

    /// The row's kdf_salt (base64) -> KEK -> KeyWrap.openStoredKey(_:kek:userID:). Never reads kdf_iterations.
    /// The row is checked (ids, lengths, base64) before the KEK is made.
    static func openStoredKey(_ row: StoredKeyRow, master: Data, userID: String) throws(CryptoError) -> PrivateRecipient {
        let checked = try KeyWrap.check(row, userID: userID)
        var kek = try kek(master: master, kdfSalt: checked.salt)
        defer { kek.resetBytes(in: 0..<kek.count) }
        return try KeyWrap.openStoredKey(row, kek: kek, userID: userID)
    }
}

/// master, off the main thread and one at a time: a call made while another runs waits for it (never two
/// PBKDF2 at once), then runs. The wait is a lock taken on a detached task's thread, never on the caller's.
final class PasswordV1Deriver: Sendable {
    private let kdf: PasswordV1.KDF
    /// Held while one PBKDF2 runs (on the detached task's thread).
    private let running = NSLock()

    init(kdf: @escaping PasswordV1.KDF = PasswordV1.pbkdf2) {
        self.kdf = kdf
    }

    func master(password: String, email: String) async throws(CryptoError) -> Data {
        let kdf = self.kdf
        let running = self.running
        let result = await Task.detached(priority: .userInitiated) { () -> Result<Data, CryptoError> in
            running.withLock { () -> Result<Data, CryptoError> in
                do throws(CryptoError) {
                    return .success(try PasswordV1.master(password: password, email: email, kdf: kdf))
                } catch {
                    return .failure(error)
                }
            }
        }.value
        return try result.get()
    }
}
