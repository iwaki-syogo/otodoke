// The key after a password sign-in (password-v1, docs/api/keys.md of integrate/password-v1 3449af0, "Order").
//  - A key in use (user_keys through PostgREST): opened with the KEK of the sign-in's master, put in memory
//    (OpenKeyStore) and kept with Face ID (KeyVault.save with the policy ticket of the start).
//  - None: a new key (KeyGeneration.generate), POST /api/keys/register (expectedCurrentKeyId null), the pending
//    row read back by key_id and opened with the KEK (its public key the new one), the challenge opened with the
//    AAD `otodoke/key-challenge/v1|<user_id>|<key_id>`, POST /api/keys/activate, then memory and Face ID.
//  - 409 key_in_use_changed at register or activate: another device made it first; the key in use is read and
//    opened instead.
//  - One run at a time: a second run of the same sign-in (user and session stamp) while one runs waits for it and
//    answers the same (one key, never two); another sign-in's run waits for it to end, then runs (S5).
//  - The session stamp of the start (signed out, another account) stops the steps with the server after each
//    await; the front period stops only the last step, keep (memory and Face ID): a key put in use while the app
//    was in the background is opened with the password later (S2, CX2).
//  - key_not_pending or no answer (network, unavailable, an answer that is not the endpoint's): once more from
//    register, with a new key (keys.md: register may be sent again). Never more than once (S3).
//  - The run's failure stays in lastOutcome (the unlock and the settings show it, S3).
//  - Requests go to the endpoint only: a redirect is not followed (it is .network, SEC-N2); `ok` is JSON true
//    only, and activate's keyId is the one sent (SEC-N1).
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
        // SEC-N1: the key the server put in use is the one sent.
        guard let answered = answer["keyId"] as? String, Envelope.isKid(answered), answered == keyID else { throw .network }
        return answered
    }

    /// SEC-N2: the key endpoints answer themselves; a redirect is not followed (its answer is not the endpoint's
    /// JSON: .network).
    final class NoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? {
            nil
        }
    }

    /// SEC-N1: JSON `true` only (JSONSerialization gives an NSNumber for both `true` and `1`).
    static func isJSONTrue(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID() && number.boolValue
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
            reply = try await session.data(for: request, delegate: NoRedirect())
        } catch {
            throw .network
        }
        guard let http = reply.1 as? HTTPURLResponse,
              let object = (try? JSONSerialization.jsonObject(with: reply.0)) as? [String: Any]
        else { throw .network }
        if http.statusCode == 200, Self.isJSONTrue(object["ok"]) { return object }
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
    /// N4: the sign-in made no master for the session's address (letters outside ASCII): no key is made. The
    /// Web's address_mismatch; signing in again does not help, so it is not offered.
    case addressMismatch
    /// Signed out, another account, or the background meanwhile: nothing kept, nothing shown.
    case stale
    /// The key in use does not open with the password that signed in (a change on the Web stopped half-way):
    /// nothing made, nothing kept; the Web's login is asked for (no other password, no rewrap or restore here).
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
    /// The run in flight, with the sign-in's user and the session stamp it started under: shared by a second run
    /// of the same (S5).
    @ObservationIgnored private var running: (task: Task<KeySetupOutcome, Never>, userID: String, session: SessionStamp)?

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
        // S5: the same sign-in joins the run in flight; another waits for it to end first.
        while let current = running {
            if current.userID == signIn.userID, let now = store.stamp()?.session, now == current.session {
                return await current.task.value
            }
            _ = await current.task.value
            if running?.task == current.task { running = nil }
        }
        guard let stamp = store.stamp(), stamp.session.userID == signIn.userID else {
            lastOutcome = .stale
            return .stale
        }
        // CX3: the save may only use the policy as it was when this started.
        let ticket = policy.ticket()
        let task = Task { await self.perform(signIn, stamp: stamp, ticket: ticket) }
        running = (task, signIn.userID, stamp.session)
        let outcome = await task.value
        if running?.task == task { running = nil }
        lastOutcome = outcome
        return outcome
    }

    /// N4: the sign-in made no key for this address (AuthService.takeAddressMismatch).
    func noteAddressMismatch() {
        lastOutcome = .addressMismatch
    }

    /// S2: the steps with the server stop only for a sign-out or another account (not for the background).
    private func sessionIsCurrent(_ stamp: UnlockStamp) -> Bool {
        store.session.isCurrent(stamp.session)
    }

    private func perform(_ signIn: PasswordSignIn, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) async -> KeySetupOutcome {
        let read = await keys.currentKey()
        guard sessionIsCurrent(stamp) else { return .stale }
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
        let recipient: PrivateRecipient
        do {
            recipient = try PasswordV1.openStoredKey(row, master: signIn.master, userID: signIn.userID)
        } catch {
            // Wrapped for another password (a change on the Web stopped half-way): the Web's login is asked for.
            // A row that is not a key row at all is another failure.
            return error == .wrongPassword ? .needsWebLogin : .failed(message: UnlockModel.failedText)
        }
        return keep(recipient, stamp: stamp, ticket: ticket) ? .opened(keyID: recipient.keyID) : .stale
    }

    /// Another device made the key first: the key in use, read again and opened.
    private func openInUse(_ signIn: PasswordSignIn, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) async -> KeySetupOutcome {
        let read = await keys.currentKey()
        guard sessionIsCurrent(stamp) else { return .stale }
        guard case let .loaded(row?) = read else { return .failed(message: KeyAPIFailure.keyInUseChanged.message) }
        return open(row, signIn: signIn, stamp: stamp, ticket: ticket)
    }

    /// One attempt, then (S3) once more from register with a new key after key_not_pending or no answer.
    private func create(_ signIn: PasswordSignIn, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) async -> KeySetupOutcome {
        switch await attempt(signIn, stamp: stamp, ticket: ticket) {
        case let .done(outcome):
            return outcome
        case .again:
            guard sessionIsCurrent(stamp) else { return .stale }
            switch await attempt(signIn, stamp: stamp, ticket: ticket) {
            case let .done(outcome): return outcome
            case let .again(failure): return .failed(message: failure.message)
            }
        }
    }

    private enum Attempt {
        case done(KeySetupOutcome)
        /// key_not_pending or no answer: worth one more attempt from register.
        case again(KeyAPIFailure)
    }

    private static func isWorthAgain(_ failure: KeyAPIFailure) -> Bool {
        failure == .keyNotPending || failure == .network || failure == .unavailable
    }

    private func attempt(_ signIn: PasswordSignIn, stamp: UnlockStamp, ticket: KeyStorePolicy.Ticket) async -> Attempt {
        guard let generated = try? KeyGeneration.generate(master: signIn.master, userID: signIn.userID) else {
            return .done(.failed(message: LoginText.other))
        }
        guard let token = await accessToken() else { return .done(sessionIsCurrent(stamp) ? .failed(message: LoginText.signedOut) : .stale) }
        guard sessionIsCurrent(stamp) else { return .done(.stale) }

        // 4. register (the key in use stays as it is until activation).
        let registered: KeyRegistered
        do {
            registered = try await api.register(generated.row, expectedCurrentKeyID: nil, accessToken: token)
        } catch {
            guard sessionIsCurrent(stamp) else { return .done(.stale) }
            if error == .keyInUseChanged { return .done(await openInUse(signIn, stamp: stamp, ticket: ticket)) }
            return Self.isWorthAgain(error) ? .again(error) : .done(.failed(message: error.message))
        }
        guard sessionIsCurrent(stamp) else { return .done(.stale) }
        guard registered.keyID == generated.row.keyID else { return .done(.failed(message: LoginText.keyChallengeFailed)) }

        // 5. The pending row read back opens with this password and is the pair of the stored public key.
        let back = await pending.pendingKey(keyID: registered.keyID)
        guard sessionIsCurrent(stamp) else { return .done(.stale) }
        guard case let .loaded(row?) = back, row.publicKey == generated.row.publicKey,
              let opened = try? PasswordV1.openStoredKey(row, master: signIn.master, userID: signIn.userID),
              opened.keyID == generated.row.keyID
        else { return .done(.failed(message: LoginText.keyChallengeFailed)) }

        // 6. The challenge, opened with that private key.
        guard let envelope = try? Envelope.parse(jsonData: registered.challenge),
              let answer = try? EnvelopeCrypto.openBytes(opened, aad: KeyChallenge.aad(userID: signIn.userID, keyID: registered.keyID), envelope: envelope),
              answer.count == 32
        else { return .done(.failed(message: LoginText.keyChallengeFailed)) }

        // 7. activate.
        do {
            _ = try await api.activate(keyID: registered.keyID, challenge: answer, expectedCurrentKeyID: nil, accessToken: token)
        } catch {
            guard sessionIsCurrent(stamp) else { return .done(.stale) }
            if error == .keyInUseChanged { return .done(await openInUse(signIn, stamp: stamp, ticket: ticket)) }
            return Self.isWorthAgain(error) ? .again(error) : .done(.failed(message: error.message))
        }
        guard sessionIsCurrent(stamp) else { return .done(.stale) }
        // Only keep looks at the front period (CX2: nothing in memory for a period that ended).
        return .done(keep(opened, stamp: stamp, ticket: ticket) ? .created(keyID: opened.keyID) : .stale)
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
