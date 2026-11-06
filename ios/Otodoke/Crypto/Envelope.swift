// TDD-STUB(task 14): envelope v1 of src/lib/crypto/envelope.ts (2541793), opening side only.
//   Z     ECDH(recipient private, epk): the 32-byte x coordinate
//   key   HKDF-SHA256(ikm = Z, salt = "otodoke/mail/v1", info = epk || recipient public) -> AES-256
//   ct    AES-256-GCM(key, iv, aad), the 16-byte tag at the end
// Every field is checked before anything is decrypted (parseEnvelope); any doubt throws. The mail JSON is
// checked as a dictionary (v is the number 1, the five fields are each a string or null, UTF-8 strict).
// Names and signatures are the contract with CryptoVectorTests; the bodies return placeholders.

import CryptoKit
import Foundation

struct Envelope: Equatable, Sendable {
    static let version = 1
    static let alg = "P256-HKDF-SHA256-A256GCM"
    static let hkdfSalt = "otodoke/mail/v1"

    let kid: String
    /// 65 bytes, 0x04 first.
    let epk: Data
    /// 12 bytes.
    let iv: Data
    /// At least 16 bytes (the tag).
    let ct: Data

    /// parseEnvelope on a value from JSONSerialization: an object with exactly the keys
    /// alg, ct, epk, iv, kid, v; v the number 1 (not true, not "1"); alg exactly ENVELOPE_ALG; kid /^[0-9a-f]{32}$/;
    /// epk, iv and ct strict base64 of the right lengths.
    static func parse(_ value: Any?) throws(CryptoError) -> Envelope {
        throw .badEnvelope // TDD-STUB(task 14)
    }

    /// The same from the JSON bytes of body_envelope.
    static func parse(jsonData: Data) throws(CryptoError) -> Envelope {
        throw .badEnvelope // TDD-STUB(task 14)
    }

    /// sealed-mail.tsx kidOf: the kid when it is a string of 32 lowercase hex digits, else nil.
    static func kidOf(jsonData: Data) -> String? {
        nil // TDD-STUB(task 14)
    }
}

/// MailPlaintext of envelope.ts.
struct MailPlaintext: Equatable, Sendable {
    var subject: String?
    var fromName: String?
    var fromAddress: String?
    var text: String?
    var html: String?
}

/// CryptoKit's P-256 key agreement private key. Spelled through this alias: gitleaks' generic-api-key
/// rule reads `<…key>: P256.KeyAgreement.PrivateKey` as a secret (.gitleaks.toml is not changed for it).
typealias AgreementPrivate = P256.KeyAgreement.PrivateKey

/// The recipient as the opening side knows it.
struct PrivateRecipient: Sendable {
    let keyID: String
    /// 65 bytes, uncompressed.
    let publicKey: Data
    let privateKey: AgreementPrivate
}

enum EnvelopeCrypto {
    /// Z: ECDH of `privateKey` with the 65-byte point `peerPublicKey` (x coordinate, 32 bytes).
    static func sharedSecret(_ privateKey: P256.KeyAgreement.PrivateKey, peerPublicKey: Data) throws(CryptoError) -> Data {
        throw .badEnvelope // TDD-STUB(task 14)
    }

    /// epk || recipient public (130 bytes).
    static func hkdfInfo(epk: Data, recipientPublicKey: Data) -> Data {
        Data() // TDD-STUB(task 14)
    }

    /// HKDF-SHA256(ikm = Z, salt = "otodoke/mail/v1", info) -> 32 bytes.
    static func aesKey(sharedSecret: Data, info: Data) -> Data {
        Data() // TDD-STUB(task 14)
    }

    /// openBytes: .wrongKey when the kid is not the recipient's (checked before any crypto).
    static func openBytes(_ recipient: PrivateRecipient, aad: String, envelope: Envelope) throws(CryptoError) -> Data {
        throw .openFailed // TDD-STUB(task 14)
    }

    /// openMail: parse the envelope, the AAD from the ids (CryptoAAD.mail), openBytes, then parsePlaintext.
    static func openMail(_ recipient: PrivateRecipient, userID: String, emailID: String, envelopeJSON: Data) throws(CryptoError) -> MailPlaintext {
        throw .openFailed // TDD-STUB(task 14)
    }

    /// The mail JSON: strict UTF-8, an object, v === 1, subject / from_name / from_address / text / html
    /// each present and a string or null (other keys are ignored, as the Web does).
    static func parsePlaintext(_ bytes: Data) throws(CryptoError) -> MailPlaintext {
        throw .badPlaintext // TDD-STUB(task 14)
    }
}
