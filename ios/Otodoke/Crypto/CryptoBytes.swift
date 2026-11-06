// The byte helpers of src/lib/crypto/bytes.ts (2541793) and the one place the AAD ids are made.
//
// Base64 is the standard alphabet with padding, checked strictly (the Web's B64 regex): anything else is
// .badBase64. The AAD ids must be lowercase UUID text: `otodoke/mail/v1|<user_id>|<email_id>` and
// `otodoke/key/v1|<user_id>`; the UUID overloads lowercase uuidString and go through the same function.

import CryptoKit
import Foundation

/// Every way opening a key or a mail can fail. No case carries anything from the input (never a
/// password, a key, a mail or an id), so an error can be logged or shown as it is.
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
    /// The wrapped key did not open with the KEK of this password (and address): password-v1.
    case wrongPassword
    /// The unwrapped key is not the pair of the stored public key, or the key id does not match it.
    case keyMismatch
}

enum CryptoBytes {
    /// The value of each base64 letter (255 for a byte outside the alphabet).
    private static let alphabet: [UInt8] = {
        var table = [UInt8](repeating: 255, count: 256)
        for (i, c) in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".utf8.enumerated() {
            table[Int(c)] = UInt8(i)
        }
        return table
    }()

    private static let pad = UInt8(ascii: "=")

    /// fromBase64 of bytes.ts: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/ then decode
    /// as atob does (the bits left over in the last letter are ignored).
    static func fromBase64(_ text: String) throws(CryptoError) -> Data {
        let bytes = Array(text.utf8)
        guard bytes.count % 4 == 0 else { throw .badBase64 }
        var padding = 0
        while padding < bytes.count, bytes[bytes.count - 1 - padding] == pad { padding += 1 }
        guard padding <= 2 else { throw .badBase64 }
        let letters = bytes.count - padding
        var out = Data()
        out.reserveCapacity(letters * 3 / 4)
        var acc: UInt32 = 0
        var bits = 0
        for i in 0..<letters {
            let value = alphabet[Int(bytes[i])]
            guard value != 255 else { throw .badBase64 }
            acc = (acc << 6) | UInt32(value)
            bits += 6
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((acc >> UInt32(bits)) & 0xFF))
            }
        }
        return out
    }

    static func toBase64(_ data: Data) -> String {
        data.base64EncodedString()
    }

    /// Lowercase hex.
    static func toHex(_ data: Data) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8]()
        out.reserveCapacity(data.count * 2)
        for b in data {
            out.append(digits[Int(b >> 4)])
            out.append(digits[Int(b & 0x0F)])
        }
        return String(decoding: out, as: UTF8.self)
    }

    static func sha256(_ data: Data) -> Data {
        Data(SHA256.hash(data: data))
    }
}

enum CryptoAAD {
    /// 8-4-4-4-12 lowercase hex digits (the only form the ids take in the AAD).
    static func isLowercaseUUID(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 36 else { return false }
        for (i, c) in bytes.enumerated() {
            if i == 8 || i == 13 || i == 18 || i == 23 {
                guard c == UInt8(ascii: "-") else { return false }
            } else {
                let digit = c >= UInt8(ascii: "0") && c <= UInt8(ascii: "9")
                let lower = c >= UInt8(ascii: "a") && c <= UInt8(ascii: "f")
                guard digit || lower else { return false }
            }
        }
        return true
    }

    /// mailAad: `otodoke/mail/v1|<user_id>|<email_id>`; .badID unless both are lowercase UUIDs.
    static func mail(userID: String, emailID: String) throws(CryptoError) -> String {
        guard isLowercaseUUID(userID), isLowercaseUUID(emailID) else { throw .badID }
        return "otodoke/mail/v1|\(userID)|\(emailID)"
    }

    /// keyWrapAad: `otodoke/key/v1|<user_id>`; .badID unless it is a lowercase UUID.
    static func key(userID: String) throws(CryptoError) -> String {
        guard isLowercaseUUID(userID) else { throw .badID }
        return "otodoke/key/v1|\(userID)"
    }

    /// The same text from UUID values (uuidString lowercased, through the String function).
    static func mail(userID: UUID, emailID: UUID) -> String {
        // A lowercased uuidString is always a lowercase UUID, so this never throws.
        (try? mail(userID: userID.uuidString.lowercased(), emailID: emailID.uuidString.lowercased())) ?? ""
    }

    static func key(userID: UUID) -> String {
        (try? key(userID: userID.uuidString.lowercased())) ?? ""
    }
}
