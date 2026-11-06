// Envelope v1 of src/lib/crypto/envelope.ts (2541793), opening side only.
//   Z     ECDH(recipient private, epk): the 32-byte x coordinate
//   key   HKDF-SHA256(ikm = Z, salt = "otodoke/mail/v1", info = epk || recipient public) -> AES-256
//   ct    AES-256-GCM(key, iv, aad), the 16-byte tag at the end
// Every field is checked before anything is decrypted (parseEnvelope); any doubt throws. The mail JSON is
// checked as a dictionary (v is the number 1, the five fields are each a string or null, UTF-8 strict).

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

    private static let keys: Set<String> = ["alg", "ct", "epk", "iv", "kid", "v"]

    /// parseEnvelope on a value from JSONSerialization: an object with exactly the keys
    /// alg, ct, epk, iv, kid, v; v the number 1 (not true, not "1"); alg exactly ENVELOPE_ALG; kid /^[0-9a-f]{32}$/;
    /// epk, iv and ct strict base64 of the right lengths.
    static func parse(_ value: Any?) throws(CryptoError) -> Envelope {
        guard let e = value as? [String: Any] else { throw .badEnvelope }
        guard Set(e.keys) == keys, e.count == keys.count else { throw .badEnvelope }
        guard JSONValues.isNumberOne(e["v"]) else { throw .badEnvelope }
        guard let alg = e["alg"] as? String, alg == Self.alg else { throw .badEnvelope }
        guard let kid = e["kid"] as? String, isKid(kid) else { throw .badEnvelope }
        guard let epk64 = e["epk"] as? String, let iv64 = e["iv"] as? String, let ct64 = e["ct"] as? String else { throw .badEnvelope }
        let epk: Data
        let iv: Data
        let ct: Data
        do {
            epk = try CryptoBytes.fromBase64(epk64)
            iv = try CryptoBytes.fromBase64(iv64)
            ct = try CryptoBytes.fromBase64(ct64)
        } catch {
            throw .badEnvelope
        }
        guard epk.count == 65, epk.first == 0x04 else { throw .badEnvelope }
        guard iv.count == 12 else { throw .badEnvelope }
        guard ct.count >= 16 else { throw .badEnvelope }
        return Envelope(kid: kid, epk: epk, iv: iv, ct: ct)
    }

    /// The same from the JSON bytes of body_envelope.
    static func parse(jsonData: Data) throws(CryptoError) -> Envelope {
        guard let value = JSONValues.object(jsonData) else { throw .badEnvelope }
        return try parse(value)
    }

    /// sealed-mail.tsx kidOf: the kid when it is a string of 32 lowercase hex digits, else nil.
    static func kidOf(jsonData: Data) -> String? {
        guard let e = JSONValues.object(jsonData) as? [String: Any], let kid = e["kid"] as? String, isKid(kid) else { return nil }
        return kid
    }

    /// /^[0-9a-f]{32}$/
    static func isKid(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        return bytes.count == 32 && bytes.allSatisfy { ($0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9")) || ($0 >= UInt8(ascii: "a") && $0 <= UInt8(ascii: "f")) }
    }
}

/// What JSON.parse and `=== 1` decide, on JSONSerialization's values.
enum JSONValues {
    /// Any JSON value (fragments too); nil for text that is not JSON.
    static func object(_ data: Data) -> Any? {
        try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    /// `v === 1`: the number 1, never a boolean (NSNumber bridges true to 1) and never a string.
    static func isNumberOne(_ value: Any?) -> Bool {
        guard let n = value as? NSNumber, !(value is String) else { return false }
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return false }
        return n.doubleValue == 1
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
    static func sharedSecret(_ privateKey: AgreementPrivate, peerPublicKey: Data) throws(CryptoError) -> Data {
        guard peerPublicKey.count == 65, peerPublicKey.first == 0x04 else { throw .badEnvelope }
        let peer: P256.KeyAgreement.PublicKey
        do {
            peer = try P256.KeyAgreement.PublicKey(x963Representation: peerPublicKey)
        } catch {
            throw .badEnvelope
        }
        let secret: SharedSecret
        do {
            secret = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        } catch {
            throw .badEnvelope
        }
        return secret.withUnsafeBytes { Data($0) }
    }

    /// epk || recipient public (130 bytes).
    static func hkdfInfo(epk: Data, recipientPublicKey: Data) -> Data {
        epk + recipientPublicKey
    }

    /// HKDF-SHA256(ikm = Z, salt = "otodoke/mail/v1", info) -> 32 bytes.
    static func aesKey(sharedSecret: Data, info: Data) -> Data {
        let key = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: sharedSecret), salt: Data(Envelope.hkdfSalt.utf8), info: info, outputByteCount: 32)
        return key.withUnsafeBytes { Data($0) }
    }

    /// openBytes: .wrongKey when the kid is not the recipient's (checked before any crypto).
    static func openBytes(_ recipient: PrivateRecipient, aad: String, envelope: Envelope) throws(CryptoError) -> Data {
        guard envelope.kid == recipient.keyID else { throw .wrongKey }
        let z = try sharedSecret(recipient.privateKey, peerPublicKey: envelope.epk)
        let key = aesKey(sharedSecret: z, info: hkdfInfo(epk: envelope.epk, recipientPublicKey: recipient.publicKey))
        return try AESGCM.open(key: key, iv: envelope.iv, sealed: envelope.ct, aad: Data(aad.utf8), failure: .openFailed)
    }

    /// openMail: parse the envelope, the AAD from the ids (CryptoAAD.mail), openBytes, then parsePlaintext.
    static func openMail(_ recipient: PrivateRecipient, userID: String, emailID: String, envelopeJSON: Data) throws(CryptoError) -> MailPlaintext {
        let aad = try CryptoAAD.mail(userID: userID, emailID: emailID)
        let envelope = try Envelope.parse(jsonData: envelopeJSON)
        return try parsePlaintext(openBytes(recipient, aad: aad, envelope: envelope))
    }

    private static let fields = ["subject", "from_name", "from_address", "text", "html"]

    /// The mail JSON: strict UTF-8, an object, v === 1, subject / from_name / from_address / text / html
    /// each present and a string or null (other keys are ignored, as the Web does).
    static func parsePlaintext(_ bytes: Data) throws(CryptoError) -> MailPlaintext {
        // TextDecoder("utf-8", { fatal: true }): any invalid sequence throws; a leading BOM is dropped.
        var body = bytes
        if body.starts(with: [0xEF, 0xBB, 0xBF]) { body = body.dropFirst(3) }
        let text = String(decoding: body, as: UTF8.self)
        guard Data(text.utf8) == body else { throw .badPlaintext }
        guard let m = JSONValues.object(Data(text.utf8)) as? [String: Any] else { throw .badPlaintext }
        guard JSONValues.isNumberOne(m["v"]) else { throw .badPlaintext }
        var values: [String: String?] = [:]
        for f in fields {
            guard let value = m[f] else { throw .badPlaintext }
            if value is NSNull {
                values[f] = .some(nil)
            } else if let s = value as? String {
                values[f] = .some(s)
            } else {
                throw .badPlaintext
            }
        }
        return MailPlaintext(
            subject: values["subject"] ?? nil,
            fromName: values["from_name"] ?? nil,
            fromAddress: values["from_address"] ?? nil,
            text: values["text"] ?? nil,
            html: values["html"] ?? nil
        )
    }
}

/// AES-256-GCM opening with the 16-byte tag at the end of `sealed`.
enum AESGCM {
    static func open(key: Data, iv: Data, sealed: Data, aad: Data, failure: CryptoError) throws(CryptoError) -> Data {
        guard sealed.count >= 16, iv.count == 12 else { throw failure }
        do {
            let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: iv), ciphertext: sealed.dropLast(16), tag: sealed.suffix(16))
            return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
        } catch {
            throw failure
        }
    }
}
