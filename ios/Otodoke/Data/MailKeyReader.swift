// TDD-STUB(task 17): the reads opening needs, with the user's JWT and user_id = me besides RLS
// (src/lib/mail-keys.ts readStoredKey / readSealedEnvelope, 2541793).
//  - the key in use: user_keys key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations,
//    activated_at, retired_at where activated_at is not null and retired_at is null (maybeSingle: more than
//    one row is .failed);
//  - one sealed mail's body_envelope, only when it is opened: emails where id, user_id = me and
//    body_state = sealed (maybeSingle). .loaded(nil) when there is no such row or the column is null; the
//    value is the column's JSON bytes as they came.
// Names and signatures are the contract with UnlockModelTests / SealedMailTests.

import Foundation
import PostgREST

protocol MailKeyReading: Sendable {
    func currentKey() async -> LoadResult<StoredKeyRow?>
    func envelope(emailID: String) async -> LoadResult<Data?>
}

struct MailKeyReader: MailKeyReading {
    static let keyColumns = "key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations, activated_at, retired_at"

    let provider: SupabaseProvider

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    func currentKey() async -> LoadResult<StoredKeyRow?> {
        .failed // TDD-STUB(task 17)
    }

    func envelope(emailID: String) async -> LoadResult<Data?> {
        .failed // TDD-STUB(task 17)
    }
}
