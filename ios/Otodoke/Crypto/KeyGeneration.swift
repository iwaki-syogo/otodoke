// Making the user's key in the app (password-v1): a new P-256 private key, its PKCS#8 (CryptoKit's
// derRepresentation, the same 138-byte form WebCrypto exports), keyIdOf(public key), the PKCS#8 wrapped with
// the KEK of master and a new 16-byte kdf_salt, under a new 12-byte IV. The result is the user_keys row as
// stored (supabase/migrations/20261106120000_mail_encryption_keys.sql; the user_keys_row of the password-v1 vectors):
// user_id, key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations (always 600000).
// Nothing is sent here: saving the row is the Web's endpoint (docs/api/keys.md), not this file.

import CryptoKit
import Foundation

/// A user_keys row to store, in the column names and forms of the table.
struct NewKeyRow: Encodable, Equatable, Sendable {
    let userID: String
    let keyID: String
    /// base64 of the 65-byte uncompressed point (88 characters).
    let publicKey: String
    /// base64 of ciphertext || 16-byte tag.
    let wrappedPrivateKey: String
    /// base64 of 12 bytes (16 characters).
    let wrapIv: String
    /// base64 of 16 bytes (24 characters).
    let kdfSalt: String
    let kdfIterations: Int

    enum CodingKeys: String, CodingKey {
        case userID = "user_id"
        case keyID = "key_id"
        case publicKey = "public_key"
        case wrappedPrivateKey = "wrapped_private_key"
        case wrapIv = "wrap_iv"
        case kdfSalt = "kdf_salt"
        case kdfIterations = "kdf_iterations"
    }
}

/// The row to store and the key it holds, already open (to keep in memory once the row is saved).
struct GeneratedKey: Sendable {
    let row: NewKeyRow
    let recipient: PrivateRecipient
}

enum KeyGeneration {
    /// Keep the same key pair, use fresh salt/IV, and prove the saved form opens with the new master.
    static func rewrap(stored: StoredKeyRow, opener: Data, next: Data, userID: String) throws(CryptoError) -> PasswordRewrap {
        let recipient = try PasswordV1.openStoredKey(stored, master: opener, userID: userID)
        let made = try row(privateKey: recipient.privateKey, master: next, userID: userID, kdfSalt: KeyWrap.randomBytes(16), iv: KeyWrap.randomIV())
        let wrapped = StoredKeyRow(keyId: made.row.keyID, publicKey: made.row.publicKey, wrappedPrivateKey: made.row.wrappedPrivateKey, wrapIv: made.row.wrapIv, kdfSalt: made.row.kdfSalt, kdfIterations: PasswordV1.iterations)
        let reopened = try PasswordV1.openStoredKey(wrapped, master: next, userID: userID)
        guard reopened.keyID == stored.keyId, reopened.publicKey == recipient.publicKey else { throw .keyMismatch }
        return PasswordRewrap(stored: stored, row: made.row)
    }

    /// A new private key, a random kdf_salt (16 bytes) and a random IV (12 bytes). .badID unless userID is a
    /// lowercase UUID.
    static func generate(master: Data, userID: String) throws(CryptoError) -> GeneratedKey {
        _ = try CryptoAAD.key(userID: userID)
        let privateKey = AgreementPrivate()
        // 16 bytes from CryptoKit's secure random source.
        let kdfSalt = SymmetricKey(size: .bits128).withUnsafeBytes { Data($0) }
        return try row(privateKey: privateKey, master: master, userID: userID, kdfSalt: kdfSalt, iv: KeyWrap.randomIV())
    }

    /// The row for a given private key, kdf_salt and IV (the vectors; generate(master:userID:) is the only
    /// caller in the app).
    static func row(privateKey: AgreementPrivate, master: Data, userID: String, kdfSalt: Data, iv: Data) throws(CryptoError) -> GeneratedKey {
        _ = try CryptoAAD.key(userID: userID)
        let publicKey = privateKey.publicKey.x963Representation
        let keyID = KeyWrap.keyIDOf(publicKey)
        var kek = try PasswordV1.kek(master: master, kdfSalt: kdfSalt)
        defer { kek.resetBytes(in: 0..<kek.count) }
        var pkcs8 = privateKey.derRepresentation
        defer { pkcs8.resetBytes(in: 0..<pkcs8.count) }
        let wrapped = try KeyWrap.wrap(pkcs8: pkcs8, kek: kek, userID: userID, iv: iv)
        let row = NewKeyRow(
            userID: userID,
            keyID: keyID,
            publicKey: CryptoBytes.toBase64(publicKey),
            wrappedPrivateKey: CryptoBytes.toBase64(wrapped.sealed),
            wrapIv: CryptoBytes.toBase64(wrapped.iv),
            kdfSalt: CryptoBytes.toBase64(kdfSalt),
            kdfIterations: PasswordV1.iterations
        )
        return GeneratedKey(row: row, recipient: PrivateRecipient(keyID: keyID, publicKey: publicKey, privateKey: privateKey))
    }
}
