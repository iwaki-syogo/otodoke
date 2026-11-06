import CryptoKit
import Foundation
import Testing
@testable import Otodoke

/// The error a throwing call ended with (nil when it returned).
func caught<T>(_ body: () throws -> T) -> CryptoError? {
    do {
        _ = try body()
        return nil
    } catch let error as CryptoError {
        return error
    } catch {
        Issue.record("not a CryptoError: \(type(of: error))")
        return nil
    }
}

/// PBKDF2, recorded: what it was called with, how often, on which thread. Delegates to KeyWrap.pbkdf2.
final class KDFRecorder: @unchecked Sendable {
    struct Call: Equatable {
        let password: Data
        let salt: Data
        let iterations: Int
        let onMainThread: Bool
    }

    private let lock = NSLock()
    private var log: [Call] = []

    var calls: [Call] { lock.withLock { log } }

    var kdf: KeyWrap.KDF {
        { [self] (password: Data, salt: Data, iterations: Int) throws(CryptoError) -> Data in
            lock.withLock { log.append(Call(password: password, salt: salt, iterations: iterations, onMainThread: Thread.isMainThread)) }
            return try KeyWrap.pbkdf2(password: password, salt: salt, iterations: iterations)
        }
    }
}

/// [Batch 2, task 14] The opening side of envelope v1 and the key wrap against the Web's fixed vectors
/// (fixtures/crypto/envelope-v1.json, written outside git by scripts/ios-fixtures.ts): every intermediate
/// value byte for byte, every negative control refused. A missing vector file fails the suite (never skips).
@Suite("Crypto vectors (batch 2, task 14)")
struct CryptoVectorTests {
    let v: EnvelopeVector
    let negatives: NegativeVectors

    init() throws {
        v = try EnvelopeVector()
        negatives = try NegativeVectors()
    }

    @Test func theVectorFilesHoldWhatTheTestsUse() {
        #expect(v.keyID.count == 32)
        #expect(v.recipientPublic.count == 65)
        #expect(v.z.count == 32)
        #expect(v.hkdfInfo.count == 130)
        #expect(v.aesKey.count == 32)
        #expect(v.kek.count == 32)
        #expect(v.iterations == 600_000)
        #expect(Set(negatives.mail.map(\.name)) == ["missing_key", "version_2", "bad_utf8"])
    }

    // MARK: bytes

    @Test func base64IsTheStandardPaddedAlphabetOnly() throws {
        let text = v.s(v.recipient, "private_key_pkcs8")
        #expect(try CryptoBytes.fromBase64(text) == v.recipientPKCS8)
        #expect(CryptoBytes.toBase64(v.recipientPKCS8) == text)
        #expect(try CryptoBytes.fromBase64("") == Data())
        #expect(try CryptoBytes.fromBase64("QQ==") == Data([0x41]))
        for bad in ["QQ", "QQ=", "Q Q==", "QQ==\n", " QQ==", "-_8=", "QUJD_A==", "QQ===", "Q===", "あいう="] {
            #expect(caught { try CryptoBytes.fromBase64(bad) } == .badBase64, "\(bad)")
        }
    }

    @Test func hexAndSha256() {
        #expect(CryptoBytes.toHex(Data([0x00, 0xab, 0xff, 0x10])) == "00abff10")
        #expect(CryptoBytes.toHex(CryptoBytes.sha256(Data("abc".utf8))) == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(KeyWrap.keyIDOf(v.recipientPublic) == v.keyID)
    }

    // MARK: AAD

    @Test func theAADIsMadeInOnePlaceFromLowercaseIDs() throws {
        #expect(try CryptoAAD.mail(userID: v.userID, emailID: v.emailID) == v.aad)
        #expect(try CryptoAAD.key(userID: v.userID) == v.wrapAAD)
        #expect(CryptoAAD.mail(userID: UUID(uuidString: v.userID)!, emailID: UUID(uuidString: v.emailID)!) == v.aad)
        #expect(CryptoAAD.key(userID: UUID(uuidString: v.userID)!) == v.wrapAAD)
        #expect(CryptoAAD.isLowercaseUUID(v.userID))
    }

    @Test func anUppercaseOrMalformedIDIsRefused() {
        let upper = v.userID.uppercased()
        #expect(upper != v.userID)
        #expect(!CryptoAAD.isLowercaseUUID(upper))
        #expect(caught { try CryptoAAD.mail(userID: upper, emailID: v.emailID) } == .badID)
        #expect(caught { try CryptoAAD.mail(userID: v.userID, emailID: v.emailID.uppercased()) } == .badID)
        #expect(caught { try CryptoAAD.key(userID: upper) } == .badID)
        // One letter only, in the middle.
        var oneUpper = Array(v.emailID)
        if let i = oneUpper.lastIndex(where: { $0.isLetter }) { oneUpper[i] = Character(oneUpper[i].uppercased()) }
        #expect(caught { try CryptoAAD.mail(userID: v.userID, emailID: String(oneUpper)) } == .badID)
        for bad in ["", "abc", "00000000-0000-4000-8000-0000000000a", "00000000000040008000000000000000aa", "{00000000-0000-4000-8000-0000000000aa}", " 00000000-0000-4000-8000-0000000000aa"] {
            #expect(!CryptoAAD.isLowercaseUUID(bad), "\(bad)")
            #expect(caught { try CryptoAAD.key(userID: bad) } == .badID, "\(bad)")
        }
    }

    // MARK: parseEnvelope

    @Test func theVectorEnvelopeParses() throws {
        let e = try Envelope.parse(jsonData: v.envelopeJSON)
        #expect(e.kid == v.keyID)
        #expect(e.epk == v.ephemeralPublic)
        #expect(e.iv.count == 12)
        #expect(e.ct.count > 16)
        #expect(try Envelope.parse(v.envelopeObject) == e)
        #expect(Envelope.kidOf(jsonData: v.envelopeJSON) == v.keyID)
    }

    @Test func everyFieldIsChecked() {
        let epk64 = Data(repeating: 4, count: 64).base64EncodedString()
        var epk05 = v.ephemeralPublic
        epk05[epk05.startIndex] = 0x05
        let cases: [(String, Data)] = [
            ("extra key", { var o = v.envelopeObject; o["x"] = 1; return try! JSONSerialization.data(withJSONObject: o) }()),
            ("no ct", v.envelopeJSON(replacing: "ct", with: nil)),
            ("v 2", v.envelopeJSON(replacing: "v", with: 2)),
            ("v true", v.envelopeJSON(replacing: "v", with: true)),
            ("v \"1\"", v.envelopeJSON(replacing: "v", with: "1")),
            ("alg case", v.envelopeJSON(replacing: "alg", with: "p256-HKDF-SHA256-A256GCM")),
            ("kid upper", v.envelopeJSON(replacing: "kid", with: v.keyID.uppercased())),
            ("kid 31", v.envelopeJSON(replacing: "kid", with: String(v.keyID.dropLast()))),
            ("kid number", v.envelopeJSON(replacing: "kid", with: 1)),
            ("epk 64 bytes", v.envelopeJSON(replacing: "epk", with: epk64)),
            ("epk 0x05", v.envelopeJSON(replacing: "epk", with: epk05.base64EncodedString())),
            ("epk url-safe", v.envelopeJSON(replacing: "epk", with: (v.envelopeObject["epk"] as! String).replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_"))),
            ("iv 11", v.envelopeJSON(replacing: "iv", with: Data(repeating: 1, count: 11).base64EncodedString())),
            ("ct no padding", v.envelopeJSON(replacing: "ct", with: (v.envelopeObject["ct"] as! String).replacingOccurrences(of: "=", with: ""))),
            ("ct 15", v.envelopeJSON(replacing: "ct", with: Data(repeating: 1, count: 15).base64EncodedString())),
            ("array", try! JSONSerialization.data(withJSONObject: [v.envelopeObject])),
            ("string", Data("\"x\"".utf8)),
            ("null", Data("null".utf8)),
            ("not JSON", Data("{".utf8)),
        ]
        for (name, json) in cases {
            #expect(caught { try Envelope.parse(jsonData: json) } == .badEnvelope, "\(name)")
        }
        #expect(Envelope.kidOf(jsonData: v.envelopeJSON(replacing: "kid", with: v.keyID.uppercased())) == nil)
        #expect(Envelope.kidOf(jsonData: Data("[]".utf8)) == nil)
    }

    // MARK: the intermediate values

    @Test func zInfoAndTheAESKeyMatchByteForByte() throws {
        let recipient = try P256.KeyAgreement.PrivateKey(rawRepresentation: v.recipientD)
        let ephemeral = try P256.KeyAgreement.PrivateKey(rawRepresentation: v.ephemeralD)
        #expect(try EnvelopeCrypto.sharedSecret(recipient, peerPublicKey: v.ephemeralPublic) == v.z)
        #expect(try EnvelopeCrypto.sharedSecret(ephemeral, peerPublicKey: v.recipientPublic) == v.z)
        #expect(EnvelopeCrypto.hkdfInfo(epk: v.ephemeralPublic, recipientPublicKey: v.recipientPublic) == v.hkdfInfo)
        #expect(EnvelopeCrypto.aesKey(sharedSecret: v.z, info: v.hkdfInfo) == v.aesKey)
        #expect(caught { try EnvelopeCrypto.sharedSecret(recipient, peerPublicKey: Data(repeating: 4, count: 65)) } == .badEnvelope)
    }

    @Test func theVectorOpensToItsPlaintext() throws {
        let r = try v.testRecipient()
        let e = try Envelope.parse(jsonData: v.envelopeJSON)
        #expect(try EnvelopeCrypto.openBytes(r, aad: v.aad, envelope: e) == Data(v.plaintextJSON.utf8))
        #expect(try EnvelopeCrypto.openMail(r, userID: v.userID, emailID: v.emailID, envelopeJSON: v.envelopeJSON) == v.plaintext)
    }

    // MARK: negative controls

    @Test func oneByteOfTheAADIsRefused() throws {
        let r = try v.testRecipient()
        let e = try Envelope.parse(jsonData: v.envelopeJSON)
        var aad = Array(v.aad.utf8)
        aad[aad.count - 1] ^= 0x01
        #expect(caught { try EnvelopeCrypto.openBytes(r, aad: String(decoding: aad, as: UTF8.self), envelope: e) } == .openFailed)
        let otherMail = String(v.emailID.dropLast()) + (v.emailID.last == "f" ? "e" : "f")
        #expect(caught { try EnvelopeCrypto.openMail(r, userID: v.userID, emailID: otherMail, envelopeJSON: v.envelopeJSON) } == .openFailed)
    }

    @Test func oneCharacterOfTheKidIsAnotherKey() throws {
        let r = try v.testRecipient()
        let kid = String(v.keyID.dropLast()) + (v.keyID.last == "0" ? "1" : "0")
        #expect(caught { try EnvelopeCrypto.openMail(r, userID: v.userID, emailID: v.emailID, envelopeJSON: v.envelopeJSON(replacing: "kid", with: kid)) } == .wrongKey)
    }

    @Test func oneByteOfTheIVOrTheCiphertextIsRefused() throws {
        let r = try v.testRecipient()
        for (key, at) in [("iv", 0), ("iv", 11), ("ct", 0), ("ct", 40), ("ct", (Data(base64Encoded: v.envelopeObject["ct"] as! String)!.count - 1))] {
            let json = v.envelopeJSON(replacing: key, with: v.flipped(key, at: at))
            #expect(caught { try EnvelopeCrypto.openMail(r, userID: v.userID, emailID: v.emailID, envelopeJSON: json) } == .openFailed, "\(key)[\(at)]")
        }
        let epk = v.envelopeJSON(replacing: "epk", with: v.flipped("epk", at: 10))
        let err = caught { try EnvelopeCrypto.openMail(r, userID: v.userID, emailID: v.emailID, envelopeJSON: epk) }
        #expect(err == .badEnvelope || err == .openFailed)
    }

    @Test func anotherPrivateKeyUnderTheSameKidIsRefused() throws {
        let other = PrivateRecipient(keyID: v.keyID, publicKey: v.recipientPublic, privateKey: P256.KeyAgreement.PrivateKey())
        #expect(caught { try EnvelopeCrypto.openMail(other, userID: v.userID, emailID: v.emailID, envelopeJSON: v.envelopeJSON) } == .openFailed)
    }

    @Test func uppercaseIDsAreRefusedBeforeOpening() throws {
        let r = try v.testRecipient()
        #expect(caught { try EnvelopeCrypto.openMail(r, userID: v.userID.uppercased(), emailID: v.emailID, envelopeJSON: v.envelopeJSON) } == .badID)
        #expect(caught { try EnvelopeCrypto.openMail(r, userID: v.userID, emailID: v.emailID.uppercased(), envelopeJSON: v.envelopeJSON) } == .badID)
    }

    @Test func theWebsNegativeVectorsOpenAsBytesButNotAsMail() throws {
        let r = try v.testRecipient()
        for name in ["missing_key", "version_2", "bad_utf8"] {
            let m = try #require(negatives.named(name), "\(name)")
            #expect(m.aad == v.aad, "\(name)")
            let e = try Envelope.parse(jsonData: m.envelopeJSON)
            #expect(try EnvelopeCrypto.openBytes(r, aad: m.aad, envelope: e).count > 0, "\(name)")
            #expect(caught { try EnvelopeCrypto.openMail(r, userID: m.userID, emailID: m.emailID, envelopeJSON: m.envelopeJSON) } == .badPlaintext, "\(name)")
        }
    }

    @Test func theMailJSONIsCheckedAsADictionary() throws {
        func json(_ s: String) -> Data { Data(s.utf8) }
        let ok = #"{"v":1,"subject":"件名","from_name":null,"from_address":"a@example.test","text":"本文","html":null}"#
        #expect(try EnvelopeCrypto.parsePlaintext(json(ok)) == MailPlaintext(subject: "件名", fromName: nil, fromAddress: "a@example.test", text: "本文", html: nil))
        // Other keys are ignored, as the Web does.
        let extra = #"{"v":1,"subject":null,"from_name":null,"from_address":null,"text":null,"html":null,"x":3}"#
        #expect(try EnvelopeCrypto.parsePlaintext(json(extra)) == MailPlaintext())
        #expect(try EnvelopeCrypto.parsePlaintext(Data(v.plaintextJSON.utf8)) == v.plaintext)
        for bad in [
            #"{"v":1,"subject":1,"from_name":null,"from_address":null,"text":null,"html":null}"#,
            #"{"v":"1","subject":null,"from_name":null,"from_address":null,"text":null,"html":null}"#,
            #"{"v":true,"subject":null,"from_name":null,"from_address":null,"text":null,"html":null}"#,
            #"{"v":2,"subject":null,"from_name":null,"from_address":null,"text":null,"html":null}"#,
            #"{"subject":null,"from_name":null,"from_address":null,"text":null,"html":null}"#,
            #"{"v":1,"subject":null,"from_name":null,"from_address":null,"text":null}"#,
            #"{"v":1,"subject":null,"from_name":null,"from_address":null,"text":["a"],"html":null}"#,
            #"[1]"#, "null", "\"text\"", "",
        ] {
            #expect(caught { try EnvelopeCrypto.parsePlaintext(json(bad)) } == .badPlaintext, "\(bad)")
        }
        #expect(caught { try EnvelopeCrypto.parsePlaintext(Data([0x7B, 0xFF, 0x7D])) } == .badPlaintext)
    }

    // MARK: the key wrap

    @Test func thePassphraseIsNFKCAsUTF8() {
        #expect(KeyWrap.normalize(v.passphrase) == v.passphraseNFKC)
        #expect(Data(KeyWrap.normalize(v.passphrase).utf8) == v.passphraseNFKCUTF8)
        #expect(KeyWrap.normalize(v.passphraseNFKC) == v.passphraseNFKC)
    }

    @Test func pbkdf2GivesTheKEK() throws {
        #expect(try KeyWrap.pbkdf2(password: v.passphraseNFKCUTF8, salt: v.salt, iterations: v.iterations) == v.kek)
    }

    @Test func theIterationCountAndTheSaltAreChecked() {
        #expect(KeyWrap.iterationsAllowed(600_000))
        #expect(KeyWrap.iterationsAllowed(10_000_000))
        #expect(!KeyWrap.iterationsAllowed(599_999))
        #expect(!KeyWrap.iterationsAllowed(10_000_001))
        #expect(!KeyWrap.iterationsAllowed(0))
        #expect(!KeyWrap.iterationsAllowed(-600_000))
        #expect(caught { try KeyWrap.pbkdf2(password: v.passphraseNFKCUTF8, salt: v.salt, iterations: 599_999) } == .badKeyRow)
        #expect(caught { try KeyWrap.pbkdf2(password: v.passphraseNFKCUTF8, salt: v.salt, iterations: 10_000_001) } == .badKeyRow)
        #expect(caught { try KeyWrap.pbkdf2(password: v.passphraseNFKCUTF8, salt: v.salt.prefix(15), iterations: 600_000) } == .badKeyRow)
    }

    @Test func theWrappedKeyOpensToThePKCS8() throws {
        let rec = KDFRecorder()
        #expect(try KeyWrap.unwrapPrivateKeyBytes(v.row(), passphrase: v.passphrase, userID: v.userID, kdf: rec.kdf) == v.recipientPKCS8)
        #expect(rec.calls.count == 1)
        #expect(rec.calls.first?.password == v.passphraseNFKCUTF8)
        #expect(rec.calls.first?.salt == v.salt)
        #expect(rec.calls.first?.iterations == 600_000)
    }

    @Test func thePrivateKeyIsReadFromPKCS8() throws {
        #expect(try KeyWrap.privateKey(pkcs8: v.recipientPKCS8).rawRepresentation == v.recipientD)
        #expect(try KeyWrap.privateKey(pkcs8: v.b(v.ephemeral, "private_key_pkcs8")).rawRepresentation == v.ephemeralD)
        #expect(caught { try KeyWrap.privateKey(pkcs8: Data(repeating: 0, count: 10)) } != nil)
    }

    @Test func theStoredKeyOpensAndIsProvedToBeThePair() throws {
        let r = try KeyWrap.openStoredKey(v.row(), passphrase: v.passphrase, userID: v.userID)
        #expect(r.keyID == v.keyID)
        #expect(r.publicKey == v.recipientPublic)
        #expect(r.privateKey.rawRepresentation == v.recipientD)
        // Half-width typed: the same after NFKC.
        let half = try KeyWrap.openStoredKey(v.row(), passphrase: v.passphraseNFKC, userID: v.userID)
        #expect(half.keyID == v.keyID)
        // And it opens the vector's mail.
        #expect(try EnvelopeCrypto.openMail(r, userID: v.userID, emailID: v.emailID, envelopeJSON: v.envelopeJSON) == v.plaintext)
    }

    @Test func aWrongPassphraseIsTold() {
        #expect(caught { try KeyWrap.openStoredKey(v.row(), passphrase: v.passphrase + "x", userID: v.userID) } == .wrongPassphrase)
        #expect(caught { try KeyWrap.openStoredKey(v.row(), passphrase: String(v.passphrase.dropLast()) + "４", userID: v.userID) } == .wrongPassphrase)
    }

    @Test func aBadRowIsRefusedBeforePBKDF2Runs() {
        let shortIV = Data(repeating: 1, count: 11).base64EncodedString()
        let shortSalt = Data(repeating: 1, count: 15).base64EncodedString()
        for (name, row) in [
            ("599,999", v.row(iterations: 599_999)),
            ("10,000,001", v.row(iterations: 10_000_001)),
            ("iv 11", v.row(wrapIv: shortIV)),
            ("salt 15", v.row(salt: shortSalt)),
            ("salt not base64", v.row(salt: "!!!!")),
        ] {
            let rec = KDFRecorder()
            let err = caught { try KeyWrap.openStoredKey(row, passphrase: v.passphrase, userID: v.userID, kdf: rec.kdf) }
            #expect(err == .badKeyRow || err == .badBase64, "\(name)")
            #expect(rec.calls.isEmpty, "\(name): PBKDF2 ran")
        }
    }

    @Test func anotherUsersAADDoesNotOpenTheWrap() {
        #expect(caught { try KeyWrap.openStoredKey(v.row(), passphrase: v.passphrase, userID: "00000000-0000-4000-8000-0000000000bb") } == .wrongPassphrase)
        #expect(caught { try KeyWrap.openStoredKey(v.row(), passphrase: v.passphrase, userID: v.userID.uppercased()) } == .badID)
    }

    @Test func aKeyIDOrPublicKeyThatIsNotThePairIsRefused() {
        let otherKid = String(v.keyID.dropLast()) + (v.keyID.last == "0" ? "1" : "0")
        #expect(caught { try KeyWrap.openStoredKey(v.row(keyID: otherKid), passphrase: v.passphrase, userID: v.userID) } == .keyMismatch)
        let otherPublic = P256.KeyAgreement.PrivateKey().publicKey.x963Representation.base64EncodedString()
        #expect(caught { try KeyWrap.openStoredKey(v.row(publicKey: otherPublic), passphrase: v.passphrase, userID: v.userID) } == .keyMismatch)
    }
}
