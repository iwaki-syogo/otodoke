// The reads opening needs, with the user's JWT and user_id = me besides RLS
// (src/lib/mail-keys.ts readStoredKey / readSealedEnvelope, 2541793).
//  - the key in use: user_keys key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations,
//    activated_at, retired_at where activated_at is not null and retired_at is null (maybeSingle: more than
//    one row is .failed);
//  - one sealed mail's body_envelope, only when it is opened: emails where id, user_id = me and
//    body_state = sealed (maybeSingle). .loaded(nil) when there is no such row or the column is null; the
//    value is the column's JSON, as JSON bytes.

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
        guard let me = await provider.currentUserID() else { return .failed }
        let request = provider.database.from("user_keys").select(Self.keyColumns)
            .eq("user_id", value: me)
            .not("activated_at", operator: .is, value: "null")
            // .is(_, value: nil) would send "is.NULL"; the Web's .is("retired_at", null) sends "is.null".
            .filter("retired_at", operator: "is", value: "null")
            .limit(2)
        do {
            let response = try await request.execute()
            let rows = try JSONDecoder().decode([StoredKeyRow].self, from: response.data)
            guard rows.count <= 1 else { return .failed }
            return .loaded(rows.first)
        } catch {
            return .failed
        }
    }

    func envelope(emailID: String) async -> LoadResult<Data?> {
        guard let me = await provider.currentUserID() else { return .failed }
        let request = provider.database.from("emails").select("body_envelope")
            .eq("id", value: emailID)
            .eq("user_id", value: me)
            .eq("body_state", value: "sealed")
            .limit(2)
        do {
            let response = try await request.execute()
            guard let rows = try JSONSerialization.jsonObject(with: response.data) as? [[String: Any]], rows.count <= 1 else { return .failed }
            guard let row = rows.first else { return .loaded(nil) }
            guard let value = row["body_envelope"], !(value is NSNull) else { return .loaded(nil) }
            return .loaded(try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]))
        } catch {
            return .failed
        }
    }
}
