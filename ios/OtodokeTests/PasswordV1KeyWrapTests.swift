import CryptoKit
import Foundation
import Testing
@testable import Otodoke

/// [password-v1] Wrapping and opening the private key with the KEK (docs/crypto/password-v1.md, step 7) against
/// fixtures/crypto/password-v1.json: every case opens to the PKCS#8 and the vector's key; a given IV wraps to
/// the vector's ciphertext and tag byte for byte; the app's own wrap takes a new random 12-byte IV each time.
/// Negative controls: another user_id in the AAD, an uppercase UUID, a KEK one byte off, another kdf_salt,
/// another password or address: none opens. The row's kdf_iterations is never read.
@Suite("password-v1: the key wrap")
struct PasswordV1KeyWrapTests {
    let v: PasswordV1Vectors

    init() throws {
        v = try PasswordV1Vectors()
    }

    private func ascii() throws -> PasswordV1Vectors.Case {
        try #require(v.named("ascii"))
    }

    // MARK: unwrap

    @Test func everyCaseOpensToThePKCS8() throws {
        for c in v.cases {
            #expect(try KeyWrap.unwrapPrivateKeyBytes(c.row(), kek: c.kek, userID: c.userID) == v.pkcs8, "\(c.name)")
        }
    }

    @Test func everyCaseOpensToTheVectorsKeyProvedToBeThePair() throws {
        for c in v.cases {
            let r = try KeyWrap.openStoredKey(c.row(), kek: c.kek, userID: c.userID)
            #expect(r.keyID == v.keyID, "\(c.name)")
            #expect(r.publicKey == v.publicKey, "\(c.name)")
            #expect(r.privateKey.rawRepresentation == v.d, "\(c.name)")
            #expect(r.privateKey.publicKey.x963Representation == v.publicKey, "\(c.name)")
            #expect(KeyWrap.keyIDOf(r.publicKey) == v.keyID, "\(c.name)")
        }
    }

    @Test func everyCaseOpensFromMasterWithTheRowsKdfSalt() throws {
        for c in v.cases {
            let r = try PasswordV1.openStoredKey(c.row(), master: c.master, userID: c.userID)
            #expect(r.keyID == v.keyID, "\(c.name)")
            #expect(r.publicKey == v.publicKey, "\(c.name)")
            #expect(r.privateKey.rawRepresentation == v.d, "\(c.name)")
        }
    }

    @Test func thePasswordAndTheAddressAsTypedOpenTheKey() throws {
        let c = try ascii()
        let master = try PasswordV1.master(password: c.password, email: c.email)
        let r = try PasswordV1.openStoredKey(c.row(), master: master, userID: c.userID)
        #expect(r.keyID == v.keyID)
        #expect(r.privateKey.rawRepresentation == v.d)
    }

    // MARK: wrap

    @Test func aGivenIVWrapsToTheVectorsCiphertextAndTag() throws {
        for c in v.cases {
            let w = try KeyWrap.wrap(pkcs8: v.pkcs8, kek: c.kek, userID: c.userID, iv: c.wrapIV)
            #expect(w.iv == c.wrapIV, "\(c.name)")
            #expect(w.sealed == c.wrapCiphertext + c.wrapTag, "\(c.name)")
            #expect(w.sealed.dropLast(16) == c.wrapCiphertext, "\(c.name)")
            #expect(w.sealed.suffix(16) == c.wrapTag, "\(c.name)")
            // Stored: base64 of ciphertext || tag, the IV on its own (not CryptoKit's `combined`).
            #expect(CryptoBytes.toBase64(w.sealed) == c.rowString("wrapped_private_key"), "\(c.name)")
            #expect(CryptoBytes.toBase64(w.iv) == c.rowString("wrap_iv"), "\(c.name)")
        }
    }

    @Test func theAppsWrapTakesANewRandom12ByteIVEachTime() throws {
        let c = try ascii()
        var ivs = Set<Data>()
        var sealed = Set<Data>()
        for _ in 0..<16 {
            let w = try KeyWrap.wrap(pkcs8: v.pkcs8, kek: c.kek, userID: c.userID)
            #expect(w.iv.count == 12)
            #expect(w.iv != Data(repeating: 0, count: 12))
            #expect(w.sealed.count == v.pkcs8.count + 16)
            ivs.insert(w.iv)
            sealed.insert(w.sealed)
            // And it opens.
            let row = c.row(wrapIv: CryptoBytes.toBase64(w.iv), wrapped: CryptoBytes.toBase64(w.sealed))
            #expect(try KeyWrap.unwrapPrivateKeyBytes(row, kek: c.kek, userID: c.userID) == v.pkcs8)
        }
        #expect(ivs.count == 16)
        #expect(sealed.count == 16)
        #expect(!ivs.contains(c.wrapIV))
    }

    @Test func aWrapWithABadIVKEKOrIDIsRefused() throws {
        let c = try ascii()
        #expect(caught { try KeyWrap.wrap(pkcs8: v.pkcs8, kek: c.kek, userID: c.userID, iv: c.wrapIV.prefix(11)) } == .badKeyRow)
        #expect(caught { try KeyWrap.wrap(pkcs8: v.pkcs8, kek: c.kek, userID: c.userID, iv: c.wrapIV + Data([0])) } == .badKeyRow)
        #expect(caught { try KeyWrap.wrap(pkcs8: v.pkcs8, kek: c.kek.prefix(31), userID: c.userID) } == .badKeyRow)
        #expect(caught { try KeyWrap.wrap(pkcs8: v.pkcs8, kek: c.kek, userID: upperUUID) } == .badID)
        #expect(caught { try KeyWrap.wrap(pkcs8: v.pkcs8, kek: c.kek, userID: "not-a-uuid") } == .badID)
    }

    // MARK: negative controls: none of these opens

    @Test func anotherUsersAADDoesNotOpen() throws {
        for c in v.cases {
            let other = c.userID == "00000000-0000-4000-8000-0000000000bb" ? "00000000-0000-4000-8000-0000000000cc" : "00000000-0000-4000-8000-0000000000bb"
            #expect(caught { try KeyWrap.openStoredKey(c.row(), kek: c.kek, userID: other) } == .wrongPassword, "\(c.name)")
            #expect(caught { try PasswordV1.openStoredKey(c.row(), master: c.master, userID: other) } == .wrongPassword, "\(c.name)")
        }
    }

    @Test func anUppercaseUUIDIsRefused() throws {
        for c in v.cases {
            #expect(caught { try KeyWrap.unwrapPrivateKeyBytes(c.row(), kek: c.kek, userID: upperUUID) } == .badID, "\(c.name)")
            #expect(caught { try KeyWrap.openStoredKey(c.row(), kek: c.kek, userID: upperUUID) } == .badID, "\(c.name)")
            #expect(caught { try PasswordV1.openStoredKey(c.row(), master: c.master, userID: upperUUID) } == .badID, "\(c.name)")
        }
    }

    @Test func aKEKOneByteOffDoesNotOpen() throws {
        let c = try ascii()
        for at in [0, 15, 31] {
            var kek = c.kek
            kek[kek.startIndex + at] ^= 0x01
            #expect(caught { try KeyWrap.unwrapPrivateKeyBytes(c.row(), kek: kek, userID: c.userID) } == .wrongPassword, "byte \(at)")
            #expect(caught { try KeyWrap.openStoredKey(c.row(), kek: kek, userID: c.userID) } == .wrongPassword, "byte \(at)")
        }
    }

    @Test func anotherKdfSaltDoesNotOpen() throws {
        let c = try ascii()
        var salt = c.kdfSalt
        salt[salt.startIndex + 7] ^= 0x80
        let row = c.row(salt: CryptoBytes.toBase64(salt))
        #expect(caught { try PasswordV1.openStoredKey(row, master: c.master, userID: c.userID) } == .wrongPassword)
        // Another case's row (its own kdf_salt) does not open with this case's KEK either.
        let other = try #require(v.named("password_fullwidth_alnum"))
        #expect(caught { try KeyWrap.openStoredKey(other.row(), kek: c.kek, userID: other.userID) } == .wrongPassword)
    }

    @Test func anotherPasswordDoesNotOpen() throws {
        let c = try ascii()
        for wrong in [c.password + "x", "Tr0ub4dor&4", "tr0ub4dor&3", " " + c.password] {
            let master = try PasswordV1.master(password: wrong, email: c.email)
            #expect(master.count == 32, "\(wrong)")
            #expect(caught { try PasswordV1.openStoredKey(c.row(), master: master, userID: c.userID) } == .wrongPassword, "\(wrong)")
        }
    }

    @Test func anotherAddressDoesNotOpen() throws {
        let c = try ascii()
        let master = try PasswordV1.master(password: c.password, email: "user2@example.test")
        #expect(master.count == 32)
        #expect(caught { try PasswordV1.openStoredKey(c.row(), master: master, userID: c.userID) } == .wrongPassword)
    }

    // MARK: the row

    @Test func theRowsKdfIterationsIsNeverRead() throws {
        for c in v.cases {
            for n in [600_000, 599_999, 700_000, 10_000_001, 0, -1] {
                let r = try PasswordV1.openStoredKey(c.row(iterations: n), master: c.master, userID: c.userID)
                #expect(r.keyID == v.keyID, "\(c.name) \(n)")
                #expect(r.privateKey.rawRepresentation == v.d, "\(c.name) \(n)")
                #expect(try KeyWrap.unwrapPrivateKeyBytes(c.row(iterations: n), kek: c.kek, userID: c.userID) == v.pkcs8, "\(c.name) \(n)")
            }
        }
    }

    @Test func aBadRowIsRefused() throws {
        let c = try ascii()
        let shortIV = Data(repeating: 1, count: 11).base64EncodedString()
        let shortSalt = Data(repeating: 1, count: 15).base64EncodedString()
        let shortWrapped = Data(repeating: 1, count: 15).base64EncodedString()
        for (name, row) in [
            ("iv 11", c.row(wrapIv: shortIV)),
            ("salt 15", c.row(salt: shortSalt)),
            ("wrapped 15", c.row(wrapped: shortWrapped)),
            ("salt not base64", c.row(salt: "!!!!")),
            ("iv not base64", c.row(wrapIv: "P9TW9xuoPyO8OqxX=")),
        ] {
            let err = caught { try PasswordV1.openStoredKey(row, master: c.master, userID: c.userID) }
            #expect(err == .badKeyRow || err == .badBase64, "\(name): \(String(describing: err))")
        }
        let err = caught { try KeyWrap.unwrapPrivateKeyBytes(c.row(wrapIv: shortIV), kek: c.kek, userID: c.userID) }
        #expect(err == .badKeyRow)
    }

    @Test func aKeyIDOrPublicKeyThatIsNotThePairIsRefused() throws {
        let c = try ascii()
        let otherKid = String(v.keyID.dropLast()) + (v.keyID.last == "0" ? "1" : "0")
        #expect(caught { try KeyWrap.openStoredKey(c.row(keyID: otherKid), kek: c.kek, userID: c.userID) } == .keyMismatch)
        let otherPublic = P256.KeyAgreement.PrivateKey().publicKey.x963Representation.base64EncodedString()
        #expect(caught { try KeyWrap.openStoredKey(c.row(publicKey: otherPublic), kek: c.kek, userID: c.userID) } == .keyMismatch)
        #expect(caught { try PasswordV1.openStoredKey(c.row(publicKey: otherPublic), master: c.master, userID: c.userID) } == .keyMismatch)
    }
}
