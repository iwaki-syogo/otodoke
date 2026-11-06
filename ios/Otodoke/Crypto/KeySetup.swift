// The key after a password sign-in (password-v1, docs/api/keys.md of integrate/password-v1 3449af0, "Order").
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
//  - No request carries the password, master, the KEK or auth_secret; nothing is logged.

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

    /// The words shown (LoginText).
    var message: String {
        switch self {
        case .unauthorized: LoginText.signedOut
        case .staleSession: LoginText.staleSession
        case .invalidInput: LoginText.invalidInput
        case .keyInUseChanged: LoginText.keyInUseChanged
        case .keyNotPending: LoginText.keyNotPending
        case .keyWrapChanged: LoginText.keyWrapChanged
        case .keyNotInUse: LoginText.keyNotInUse
        case .keyChallengeFailed: LoginText.keyChallengeFailed
        case .keyFailed: LoginText.keyFailed
        case .unavailable, .network: LoginText.network
        }
    }
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

/// The Web's endpoints. Bodies exactly as keys.md lists them (camelCase; no other field; expectedCurrentKeyId
/// always present, JSON null for none), JSON, POST, sent once (never retried).
struct KeyAPIClient: KeyAPI {
    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = AppConfig.webBase, session: URLSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func register(_ row: NewKeyRow, expectedCurrentKeyID: String?, accessToken: String) async throws(KeyAPIFailure) -> KeyRegistered {
        let answer = try await post("register", [
            "publicKey": row.publicKey,
            "wrappedPrivateKey": row.wrappedPrivateKey,
            "wrapIv": row.wrapIv,
            "kdfSalt": row.kdfSalt,
            "kdfIterations": row.kdfIterations,
            "expectedCurrentKeyId": expectedCurrentKeyID ?? NSNull(),
        ], accessToken: accessToken)
        guard let keyID = answer["keyId"] as? String, Envelope.isKid(keyID), let challenge = answer["challenge"] as? [String: Any],
              let bytes = try? JSONSerialization.data(withJSONObject: challenge)
        else { throw .network }
        return KeyRegistered(keyID: keyID, challenge: bytes)
    }

    func activate(keyID: String, challenge: Data, expectedCurrentKeyID: String?, accessToken: String) async throws(KeyAPIFailure) -> String {
        let answer = try await post("activate", [
            "keyId": keyID,
            "challenge": CryptoBytes.toBase64(challenge),
            "expectedCurrentKeyId": expectedCurrentKeyID ?? NSNull(),
        ], accessToken: accessToken)
        guard let answered = answer["keyId"] as? String, Envelope.isKid(answered) else { throw .network }
        return answered
    }

    /// `{ ok: true, ... }` on 200; the result code of `{ ok: false, code }` otherwise (an unknown one, or an
    /// answer that is not the endpoint's JSON, is .network).
    private func post(_ endpoint: String, _ body: [String: Any], accessToken: String) async throws(KeyAPIFailure) -> [String: Any] {
        var request = URLRequest(url: baseURL.appending(path: "api/keys/\(endpoint)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { throw .invalidInput }
        request.httpBody = data
        let reply: (Data, URLResponse)
        do {
            reply = try await session.data(for: request)
        } catch {
            throw .network
        }
        guard let http = reply.1 as? HTTPURLResponse,
              let object = (try? JSONSerialization.jsonObject(with: reply.0)) as? [String: Any]
        else { throw .network }
        if http.statusCode == 200, object["ok"] as? Bool == true { return object }
        if let code = object["code"] as? String, let failure = KeyAPIFailure(rawValue: code), failure != .network { throw failure }
        throw .network
    }
}

/// The pending row of a registration, read back by key_id (user_id = me, activated_at is null).
protocol PendingKeyReading: Sendable {
    func pendingKey(keyID: String) async -> LoadResult<StoredKeyRow?>
}

extension MailKeyReader: PendingKeyReading {
    /// user_keys: key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations, activated_at,
    /// retired_at where user_id = me, key_id = keyID, activated_at is null (more than one row is .failed).
    func pendingKey(keyID: String) async -> LoadResult<StoredKeyRow?> {
        guard let me = await provider.currentUserID() else { return .failed }
        let request = provider.database.from("user_keys").select(Self.keyColumns)
            .eq("user_id", value: me)
            .eq("key_id", value: keyID)
            .filter("activated_at", operator: "is", value: "null")
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
}

enum KeyChallenge {
    /// `otodoke/key-challenge/v1|<user_id>|<key_id>` (envelope.ts challengeAad).
    static func aad(userID: String, keyID: String) -> String {
        "otodoke/key-challenge/v1|\(userID)|\(keyID)"
    }
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
    /// The key in use does not open with the password that signed in (a change on the Web stopped half-way):
    /// nothing made, nothing kept; the Web's login is asked for. TDD-STUB(password-login): not answered yet.
    case needsWebLogin
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

    /// The last run's outcome (the unlock and settings screens can show a failure).
    private(set) var lastOutcome: KeySetupOutcome?
    /// The run in flight, shared by a second run meanwhile.
    @ObservationIgnored private var running: Task<KeySetupOutcome, Never>?

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

    @discardableResult
    func run(_ signIn: PasswordSignIn) async -> KeySetupOutcome {
        if let running { return await running.value }
        guard let stamp = store.stamp(), stamp.session.userID == signIn.userID else {
            lastOutcome = .stale
            return .stale
        }
        // CX3: the save may only use the policy as it was when this started.
        let ticket = policy.ticket()
        let task = Task { await self.perform(signIn, stamp: stamp, ticket: ticket) }
        running = task
        let outcome = await task.value
        running = nil
        lastOutcome = outcome
        return outcome
    }

    private func perform(_ signIn: PasswordSignIn, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) async -> KeySetupOutcome {
        let read = await keys.currentKey()
        guard store.isCurrent(stamp) else { return .stale }
        switch read {
        case .failed:
            // Not "no key": nothing is made over a key that may be in use.
            return .failed(message: UnlockModel.readFailedText)
        case let .loaded(row?):
            return open(row, signIn: signIn, stamp: stamp, ticket: ticket)
        case .loaded(nil):
            return await create(signIn, stamp: stamp, ticket: ticket)
        }
    }

    /// The key in use, opened with the KEK of the sign-in's master.
    private func open(_ row: StoredKeyRow, signIn: PasswordSignIn, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) -> KeySetupOutcome {
        guard let recipient = try? PasswordV1.openStoredKey(row, master: signIn.master, userID: signIn.userID) else {
            return .failed(message: UnlockModel.failedText)
        }
        return keep(recipient, stamp: stamp, ticket: ticket) ? .opened(keyID: recipient.keyID) : .stale
    }

    /// Another device made the key first: the key in use, read again and opened.
    private func openInUse(_ signIn: PasswordSignIn, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) async -> KeySetupOutcome {
        let read = await keys.currentKey()
        guard store.isCurrent(stamp) else { return .stale }
        guard case let .loaded(row?) = read else { return .failed(message: KeyAPIFailure.keyInUseChanged.message) }
        return open(row, signIn: signIn, stamp: stamp, ticket: ticket)
    }

    private func create(_ signIn: PasswordSignIn, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) async -> KeySetupOutcome {
        guard let generated = try? KeyGeneration.generate(master: signIn.master, userID: signIn.userID) else {
            return .failed(message: LoginText.other)
        }
        guard let token = await accessToken() else { return store.isCurrent(stamp) ? .failed(message: LoginText.signedOut) : .stale }
        guard store.isCurrent(stamp) else { return .stale }

        // 4. register (the key in use stays as it is until activation).
        let registered: KeyRegistered
        do {
            registered = try await api.register(generated.row, expectedCurrentKeyID: nil, accessToken: token)
        } catch {
            guard store.isCurrent(stamp) else { return .stale }
            if error == .keyInUseChanged { return await openInUse(signIn, stamp: stamp, ticket: ticket) }
            return .failed(message: error.message)
        }
        guard store.isCurrent(stamp) else { return .stale }
        guard registered.keyID == generated.row.keyID else { return .failed(message: LoginText.keyChallengeFailed) }

        // 5. The pending row read back opens with this password and is the pair of the stored public key.
        let back = await pending.pendingKey(keyID: registered.keyID)
        guard store.isCurrent(stamp) else { return .stale }
        guard case let .loaded(row?) = back, row.publicKey == generated.row.publicKey,
              let opened = try? PasswordV1.openStoredKey(row, master: signIn.master, userID: signIn.userID),
              opened.keyID == generated.row.keyID
        else { return .failed(message: LoginText.keyChallengeFailed) }

        // 6. The challenge, opened with that private key.
        guard let envelope = try? Envelope.parse(jsonData: registered.challenge),
              let answer = try? EnvelopeCrypto.openBytes(opened, aad: KeyChallenge.aad(userID: signIn.userID, keyID: registered.keyID), envelope: envelope),
              answer.count == 32
        else { return .failed(message: LoginText.keyChallengeFailed) }

        // 7. activate.
        do {
            _ = try await api.activate(keyID: registered.keyID, challenge: answer, expectedCurrentKeyID: nil, accessToken: token)
        } catch {
            guard store.isCurrent(stamp) else { return .stale }
            if error == .keyInUseChanged { return await openInUse(signIn, stamp: stamp, ticket: ticket) }
            return .failed(message: error.message)
        }
        guard store.isCurrent(stamp) else { return .stale }
        return keep(opened, stamp: stamp, ticket: ticket) ? .created(keyID: opened.keyID) : .stale
    }

    /// In memory for the stamp, then kept with Face ID (when allowed and the device can).
    private func keep(_ recipient: PrivateRecipient, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) -> Bool {
        let key = OpenedKey(userID: stamp.session.userID, recipient: recipient)
        guard store.put(key, stamp: stamp) else { return false }
        if let vault {
            let kept = VaultKey(userID: key.userID, keyID: key.keyID, secret: recipient.privateKey.rawRepresentation)
            let store = self.store
            _ = vault.save(kept, ticket: ticket, stillCurrent: { store.isCurrent(stamp) })
        }
        return true
    }
}

extension PasswordSignIn {
    /// Zeroes master's bytes where they are (every copy of this value shares them), once the key step is done.
    func wipe() {
        master.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress, bytes.count > 0 else { return }
            memset(UnsafeMutableRawPointer(mutating: base), 0, bytes.count)
        }
    }
}
