// TDD-STUB(task 14): the byte helpers of src/lib/crypto/bytes.ts (2541793) and the one place the AAD ids are
// made. Names and signatures are the contract with CryptoVectorTests; the bodies return placeholders.
//
// Base64 is the standard alphabet with padding, checked strictly (the Web's B64 regex): anything else is
// .badBase64. The AAD ids must be lowercase UUID text: `otodoke/mail/v1|<user_id>|<email_id>` and
// `otodoke/key/v1|<user_id>`; the UUID overloads lowercase uuidString and go through the same function.

import CryptoKit
import Foundation

/// Every way opening a key or a mail can fail. No case carries anything from the input (never a
/// passphrase, a key, a mail or an id), so an error can be logged or shown as it is.
enum CryptoError: Error, Equatable, Sendable {
    case badBase64
    /// An AAD id that is not a lowercase UUID.
    case badID
    /// The envelope's fields (parseEnvelope), or an epk that is not a P-256 point.
    case badEnvelope
    /// Sealed to another key id (WrongKeyError).
    case wrongKey
    /// AES-GCM refused: a changed byte, another AAD, another key.
    case openFailed
    /// Opened, but not the mail JSON: not UTF-8, not an object, v is not 1, a field missing or not a string or null.
    case badPlaintext
    /// A stored key row out of range: iterations, salt length, iv length, the public key.
    case badKeyRow
    /// The wrapped key did not open with this passphrase.
    case wrongPassphrase
    /// The unwrapped key is not the pair of the stored public key, or the key id does not match it.
    case keyMismatch
}

enum CryptoBytes {
    /// fromBase64 of bytes.ts: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/ then decode.
    static func fromBase64(_ text: String) throws(CryptoError) -> Data {
        throw .badBase64 // TDD-STUB(task 14)
    }

    static func toBase64(_ data: Data) -> String {
        "" // TDD-STUB(task 14)
    }

    /// Lowercase hex.
    static func toHex(_ data: Data) -> String {
        "" // TDD-STUB(task 14)
    }

    static func sha256(_ data: Data) -> Data {
        Data() // TDD-STUB(task 14)
    }
}

enum CryptoAAD {
    /// 8-4-4-4-12 lowercase hex digits (the only form the ids take in the AAD).
    static func isLowercaseUUID(_ text: String) -> Bool {
        false // TDD-STUB(task 14)
    }

    /// mailAad: `otodoke/mail/v1|<user_id>|<email_id>`; .badID unless both are lowercase UUIDs.
    static func mail(userID: String, emailID: String) throws(CryptoError) -> String {
        throw .badID // TDD-STUB(task 14)
    }

    /// keyWrapAad: `otodoke/key/v1|<user_id>`; .badID unless it is a lowercase UUID.
    static func key(userID: String) throws(CryptoError) -> String {
        throw .badID // TDD-STUB(task 14)
    }

    /// The same text from UUID values (uuidString lowercased, through the String function).
    static func mail(userID: UUID, emailID: UUID) -> String {
        "" // TDD-STUB(task 14)
    }

    static func key(userID: UUID) -> String {
        "" // TDD-STUB(task 14)
    }
}
