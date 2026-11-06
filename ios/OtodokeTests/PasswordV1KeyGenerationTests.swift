import CryptoKit
import Foundation
import Testing
@testable import Otodoke

/// [password-v1] Making the key in the app: a new P-256 key, PKCS#8, keyIdOf, wrapped with the KEK of master
/// under a new 16-byte kdf_salt and 12-byte IV, returned as the user_keys row (the columns and forms of
/// supabase/migrations/20261106120000_mail_encryption_keys.sql and of the vectors' user_keys_row). The vectors'
/// inputs give the vectors' rows byte for byte; a generated row opens again to the same key (round trip).
@Suite("password-v1: making the key")
struct PasswordV1KeyGenerationTests {
    let v: PasswordV1Vectors

    init() throws {
        v = try PasswordV1Vectors()
    }

    static let me = "00000000-0000-4000-8000-0000000000aa"
    /// The columns of the row the app makes (the vectors' user_keys_row; the migration's columns the client writes).
    static let columns: Set<String> = ["user_id", "key_id", "public_key", "wrapped_private_key", "wrap_iv", "kdf_salt", "kdf_iterations"]

    private func json(_ row: NewKeyRow) throws -> [String: Any] {
        let data = try JSONEncoder().encode(row)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func isLowerHex(_ s: String) -> Bool {
        s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }

    // MARK: the vectors' rows

    @Test func theVectorsInputsGiveTheVectorsRowsByteForByte() throws {
        let key = try v.testPrivateKey()
        for c in v.cases {
            let g = try KeyGeneration.row(privateKey: key, master: c.master, userID: c.userID, kdfSalt: c.kdfSalt, iv: c.wrapIV)
            let o = try json(g.row)
            #expect(Set(o.keys) == Self.columns, "\(c.name)")
            #expect(Set(c.rowObject.keys) == Self.columns, "\(c.name): the vector itself")
            for k in Self.columns where k != "kdf_iterations" {
                #expect(o[k] as? String == c.rowObject[k] as? String, "\(c.name) \(k)")
            }
            #expect(o["kdf_iterations"] as? Int == 600_000, "\(c.name)")
            #expect(g.recipient.keyID == v.keyID, "\(c.name)")
            #expect(g.recipient.publicKey == v.publicKey, "\(c.name)")
            #expect(g.recipient.privateKey.rawRepresentation == v.d, "\(c.name)")
        }
    }

    // MARK: a generated row

    @Test func aGeneratedRowHasTheColumnsAndFormsOfTheTable() throws {
        let c = try #require(v.named("ascii"))
        let g = try KeyGeneration.generate(master: c.master, userID: Self.me)
        let o = try json(g.row)
        #expect(Set(o.keys) == Self.columns)
        #expect(g.row.userID == Self.me)
        // key_id: ^[0-9a-f]{32}$, keyIdOf(public_key)
        #expect(g.row.keyID.utf8.count == 32)
        #expect(isLowerHex(g.row.keyID))
        // public_key: 88 characters, the 65-byte uncompressed point
        #expect(g.row.publicKey.utf8.count == 88)
        let pub = try CryptoBytes.fromBase64(g.row.publicKey)
        #expect(pub.count == 65)
        #expect(pub.first == 0x04)
        #expect(KeyWrap.keyIDOf(pub) == g.row.keyID)
        // wrap_iv: 16 characters of 12 bytes; kdf_salt: 24 characters of 16 bytes
        #expect(g.row.wrapIv.utf8.count == 16)
        #expect(try CryptoBytes.fromBase64(g.row.wrapIv).count == 12)
        #expect(g.row.kdfSalt.utf8.count == 24)
        #expect(try CryptoBytes.fromBase64(g.row.kdfSalt).count == 16)
        // wrapped_private_key: ciphertext || tag of the 138-byte PKCS#8
        #expect(try CryptoBytes.fromBase64(g.row.wrappedPrivateKey).count == 138 + 16)
        #expect(g.row.kdfIterations == 600_000)
        // The recipient is the row's key.
        #expect(g.recipient.keyID == g.row.keyID)
        #expect(g.recipient.publicKey == pub)
        #expect(g.recipient.privateKey.publicKey.x963Representation == pub)
    }

    @Test func aGeneratedRowOpensAgainToTheSameKey() throws {
        let c = try #require(v.named("ascii"))
        let g = try KeyGeneration.generate(master: c.master, userID: Self.me)
        let r = try PasswordV1.openStoredKey(g.row.stored, master: c.master, userID: Self.me)
        #expect(r.keyID == g.row.keyID)
        #expect(r.publicKey == g.recipient.publicKey)
        #expect(r.privateKey.rawRepresentation == g.recipient.privateKey.rawRepresentation)
        // And with the KEK the spec makes from master and the row's kdf_salt.
        let kek = try PasswordV1.kek(master: c.master, kdfSalt: try CryptoBytes.fromBase64(g.row.kdfSalt))
        let pkcs8 = try KeyWrap.unwrapPrivateKeyBytes(g.row.stored, kek: kek, userID: Self.me)
        #expect(try KeyWrap.privateKey(pkcs8: pkcs8).rawRepresentation == g.recipient.privateKey.rawRepresentation)
    }

    @Test func thePKCS8IsTheFormTheWebImports() throws {
        let c = try #require(v.named("ascii"))
        let g = try KeyGeneration.generate(master: c.master, userID: Self.me)
        let kek = try PasswordV1.kek(master: c.master, kdfSalt: try CryptoBytes.fromBase64(g.row.kdfSalt))
        let pkcs8 = try KeyWrap.unwrapPrivateKeyBytes(g.row.stored, kek: kek, userID: Self.me)
        // WebCrypto's export (the vectors' plaintext): the same 138-byte layout, the same 36-byte header up to d.
        #expect(pkcs8.count == v.pkcs8.count)
        #expect(pkcs8.prefix(36) == v.pkcs8.prefix(36))
        #expect(pkcs8.suffix(65) == g.recipient.publicKey)
    }

    @Test func eachGeneratedRowHasItsOwnKeySaltAndIV() throws {
        let c = try #require(v.named("ascii"))
        var salts = Set<String>()
        var ivs = Set<String>()
        var kids = Set<String>()
        for _ in 0..<5 {
            let g = try KeyGeneration.generate(master: c.master, userID: Self.me)
            salts.insert(g.row.kdfSalt)
            ivs.insert(g.row.wrapIv)
            kids.insert(g.row.keyID)
            #expect(try CryptoBytes.fromBase64(g.row.kdfSalt) != Data(repeating: 0, count: 16))
            #expect(try CryptoBytes.fromBase64(g.row.wrapIv) != Data(repeating: 0, count: 12))
        }
        #expect(salts.count == 5)
        #expect(ivs.count == 5)
        #expect(kids.count == 5)
    }

    @Test func aGeneratedRowDoesNotOpenWithAnotherMasterOrUser() throws {
        let c = try #require(v.named("ascii"))
        let g = try KeyGeneration.generate(master: c.master, userID: Self.me)
        var other = c.master
        other[other.startIndex] ^= 0x01
        #expect(caught { try PasswordV1.openStoredKey(g.row.stored, master: other, userID: Self.me) } == .wrongPassword)
        #expect(caught { try PasswordV1.openStoredKey(g.row.stored, master: c.master, userID: "00000000-0000-4000-8000-0000000000bb") } == .wrongPassword)
    }

    @Test func anUppercaseUserIDIsRefused() throws {
        let c = try #require(v.named("ascii"))
        #expect(caught { try KeyGeneration.generate(master: c.master, userID: Self.me.uppercased()) } == .badID)
        let key = try v.testPrivateKey()
        #expect(caught { try KeyGeneration.row(privateKey: key, master: c.master, userID: upperUUID, kdfSalt: c.kdfSalt, iv: c.wrapIV) } == .badID)
    }
}
