// The key after a password sign-in (password-v1, docs/api/keys.md of integrate/password-v1 3449af0, "Order").
// TDD-STUB(password-login): names and signatures only; every body answers a wrong value.
//  - A key in use (user_keys through PostgREST): opened with the KEK of the sign-in's master, put in memory
//    (OpenKeyStore) and kept with Face ID (KeyVault.save with the policy ticket of the start).
//  - None: a new key (KeyGeneration.generate), POST /api/keys/register (expectedCurrentKeyId null), the pending
//    row read back by key_id and opened with the KEK (its public key the new one), the challenge opened with the
//    AAD `otodoke/key-challenge/v1|<user_id>|<key_id>`, POST /api/keys/activate, then memory and Face ID.
//  - 409 key_in_use_changed at register or activate: another device made it first; the key in use is read and
//    opened instead.
//  - One run at a time: a second run while one runs waits for it and answers the same (one key, never two).
//  - The stamp of the start (session generation + front period): after each await, a stamp that is no longer
//    current stops the run; nothing is put in memory or the Keychain.
//  - No request carries the password, master, the KEK or auth_secret; nothing is logged but a code.

import Foundation
import Observation

/// The result codes of docs/api/keys.md, and `network` (no answer, or not the endpoint's JSON).
enum KeyAPIFailure: String, Error, Equatable, Sendable, CaseIterable {
    case unauthorized
    case staleSession = "stale_session"
    case invalidInput = "invalid_input"
    case keyInUseChanged = "key_in_use_changed"
    case keyNotPending = "key_not_pending"
    case keyWrapChanged = "key_wrap_changed"
    case keyNotInUse = "key_not_in_use"
    case keyChallengeFailed = "key_challenge_failed"
    case keyFailed = "key_failed"
    case unavailable
    case network

    /// The words shown (LoginText). TDD-STUB(password-login): "".
    var message: String { "" }
}

/// register's answer.
struct KeyRegistered: Sendable, Equatable {
    let keyID: String
    /// The challenge envelope v1, as JSON bytes.
    let challenge: Data
}

/// POST /api/keys/register and /api/keys/activate, with `Authorization: Bearer <access token>`.
protocol KeyAPI: Sendable {
    func register(_ row: NewKeyRow, expectedCurrentKeyID: String?, accessToken: String) async throws(KeyAPIFailure) -> KeyRegistered
    /// The key id the server answered.
    func activate(keyID: String, challenge: Data, expectedCurrentKeyID: String?, accessToken: String) async throws(KeyAPIFailure) -> String
}

/// The Web's endpoints. Bodies exactly as keys.md lists them (camelCase; no other field), JSON, POST.
struct KeyAPIClient: KeyAPI {
    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = AppConfig.webBase, session: URLSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func register(_ row: NewKeyRow, expectedCurrentKeyID: String?, accessToken: String) async throws(KeyAPIFailure) -> KeyRegistered {
        throw .network
    }

    func activate(keyID: String, challenge: Data, expectedCurrentKeyID: String?, accessToken: String) async throws(KeyAPIFailure) -> String {
        throw .network
    }
}

/// The pending row of a registration, read back by key_id (user_id = me, activated_at is null).
protocol PendingKeyReading: Sendable {
    func pendingKey(keyID: String) async -> LoadResult<StoredKeyRow?>
}

extension MailKeyReader: PendingKeyReading {
    /// user_keys: key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations, activated_at,
    /// retired_at where user_id = me, key_id = keyID, activated_at is null. TDD-STUB(password-login): .failed.
    func pendingKey(keyID: String) async -> LoadResult<StoredKeyRow?> {
        .failed
    }
}

enum KeyChallenge {
    /// `otodoke/key-challenge/v1|<user_id>|<key_id>` (envelope.ts challengeAad). TDD-STUB(password-login): "".
    static func aad(userID: String, keyID: String) -> String { "" }
}

enum KeySetupOutcome: Equatable, Sendable {
    /// The key in use was opened (and is in memory).
    case opened(keyID: String)
    /// A new key was made and put in use (and is in memory).
    case created(keyID: String)
    /// Nothing in memory; the words to show.
    case failed(message: String)
    /// Signed out, another account, or the background meanwhile: nothing kept, nothing shown.
    case stale
}

@MainActor
@Observable
final class KeySetup {
    @ObservationIgnored let store: OpenKeyStore
    @ObservationIgnored let keys: any MailKeyReading
    @ObservationIgnored let pending: any PendingKeyReading
    @ObservationIgnored let api: any KeyAPI
    @ObservationIgnored let vault: KeyVault?
    @ObservationIgnored let policy: KeyStorePolicy
    /// The session's access token (nil when signed out).
    @ObservationIgnored let accessToken: @MainActor () async -> String?

    /// The last run's outcome (the unlock and settings screens show a failure).
    private(set) var lastOutcome: KeySetupOutcome?

    init(
        store: OpenKeyStore,
        keys: any MailKeyReading,
        pending: any PendingKeyReading,
        api: any KeyAPI,
        vault: KeyVault?,
        policy: KeyStorePolicy,
        accessToken: @escaping @MainActor () async -> String?
    ) {
        self.store = store
        self.keys = keys
        self.pending = pending
        self.api = api
        self.vault = vault
        self.policy = policy
        self.accessToken = accessToken
    }

    /// TDD-STUB(password-login): answers .failed("") and does nothing.
    @discardableResult
    func run(_ signIn: PasswordSignIn) async -> KeySetupOutcome {
        .failed(message: "")
    }
}
