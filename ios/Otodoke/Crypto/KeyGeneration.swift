// Making the user's key in the app (password-v1): a new P-256 private key, its PKCS#8 (CryptoKit's
// derRepresentation, the same 138-byte form WebCrypto exports), keyIdOf(public key), the PKCS#8 wrapped with
// the KEK of master and a new 16-byte kdf_salt, under a new 12-byte IV. The result is the user_keys row as
// stored (supabase/migrations/20261106120000_mail_encryption_keys.sql; the user_keys_row of the password-v1 vectors):
// user_id, key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations (always 600000).
// Nothing is sent here: saving the row is the Web's endpoint (docs/api/keys.md), not this file.
//
// TDD-STUB(password-v1): names and signatures only. Every body answers a wrong value (never fatalError).

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
    /// A new private key, a random kdf_salt (16 bytes) and a random IV (12 bytes). .badID unless userID is a
    /// lowercase UUID. TDD-STUB(password-v1)
    static func generate(master: Data, userID: String) throws(CryptoError) -> GeneratedKey {
        stubKey()
    }

    /// The row for a given private key, kdf_salt and IV (the vectors; generate(master:userID:) is the only
    /// caller in the app). TDD-STUB(password-v1)
    static func row(privateKey: AgreementPrivate, master: Data, userID: String, kdfSalt: Data, iv: Data) throws(CryptoError) -> GeneratedKey {
        stubKey()
    }

    /// TDD-STUB(password-v1): a wrong answer.
    private static func stubKey() -> GeneratedKey {
        let key = AgreementPrivate()
        let row = NewKeyRow(userID: "", keyID: "", publicKey: "", wrappedPrivateKey: "", wrapIv: "", kdfSalt: "", kdfIterations: 0)
        return GeneratedKey(row: row, recipient: PrivateRecipient(keyID: "", publicKey: Data(), privateKey: key))
    }
}
