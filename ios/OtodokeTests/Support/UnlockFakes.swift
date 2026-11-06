import CryptoKit
import Foundation
@testable import Otodoke

private func onMainThread() -> Bool { Thread.isMainThread }

/// openStoredKey, faked: answers the vector's recipient for the right passphrase and .wrongPassphrase
/// otherwise; can hold each call on a Gate (PBKDF2 still running) and records how many ran at once and
/// whether any ran on the main thread.
final class GatedDeriver: KeyDeriving, @unchecked Sendable {
    private let lock = NSLock()
    private let recipient: PrivateRecipient
    private let passphrase: String
    private var gate: Gate?
    private var entered = 0
    private var running = 0
    private var most = 0
    private var mainThreadRuns = 0
    private var forced: CryptoError?

    init(recipient: PrivateRecipient, passphrase: String, gate: Gate? = nil) {
        self.recipient = recipient
        self.passphrase = passphrase
        self.gate = gate
    }

    func hold(on gate: Gate?) { lock.withLock { self.gate = gate } }
    func fail(with error: CryptoError?) { lock.withLock { forced = error } }

    var calls: Int { lock.withLock { entered } }
    var maxAtOnce: Int { lock.withLock { most } }
    var ranOnMainThread: Int { lock.withLock { mainThreadRuns } }

    func open(_ row: StoredKeyRow, passphrase: String, userID: String) async throws(CryptoError) -> PrivateRecipient {
        let main = onMainThread()
        let waitOn: Gate? = lock.withLock {
            entered += 1
            running += 1
            most = max(most, running)
            if main { mainThreadRuns += 1 }
            return gate
        }
        if let waitOn { await waitOn.wait() }
        let failure: CryptoError? = lock.withLock {
            running -= 1
            return forced
        }
        if let failure { throw failure }
        guard passphrase == self.passphrase || KeyWrap.normalize(passphrase) == KeyWrap.normalize(self.passphrase) else { throw .wrongPassphrase }
        return recipient
    }
}

/// MailKeyReading, faked: the key row reads answer from a queue (the last answer repeats), the envelope
/// read answers `envelope` and can be held on a Gate.
final class FakeMailKeys: MailKeyReading, @unchecked Sendable {
    private let lock = NSLock()
    private var keyAnswers: [LoadResult<StoredKeyRow?>]
    private var envelopeAnswer: LoadResult<Data?>
    private var envelopeGate: Gate?
    private var keyReads = 0
    private var envelopeReads = 0

    init(key: LoadResult<StoredKeyRow?>, envelope: LoadResult<Data?> = .loaded(nil)) {
        keyAnswers = [key]
        envelopeAnswer = envelope
    }

    /// The next key reads answer these, in order (the last one repeats).
    func answerKeys(_ answers: [LoadResult<StoredKeyRow?>]) { lock.withLock { keyAnswers = answers } }
    func answerEnvelope(_ answer: LoadResult<Data?>) { lock.withLock { envelopeAnswer = answer } }
    func holdEnvelope(on gate: Gate?) { lock.withLock { envelopeGate = gate } }

    var keyReadCount: Int { lock.withLock { keyReads } }
    var envelopeReadCount: Int { lock.withLock { envelopeReads } }

    func currentKey() async -> LoadResult<StoredKeyRow?> {
        lock.withLock {
            keyReads += 1
            return keyAnswers.count > 1 ? keyAnswers.removeFirst() : (keyAnswers.first ?? .failed)
        }
    }

    func envelope(emailID: String) async -> LoadResult<Data?> {
        let gate: Gate? = lock.withLock {
            envelopeReads += 1
            return envelopeGate
        }
        if let gate { await gate.wait() }
        return lock.withLock { envelopeAnswer }
    }
}

/// Sign-out's steps as AuthService calls them, with the generation seen at each.
@MainActor
final class SignOutSteps: SignOutCleanup {
    let session: SessionGeneration
    private(set) var steps: [String] = []
    private(set) var generations: [Int] = []

    init(session: SessionGeneration) {
        self.session = session
    }

    func cancelWork() { record("cancel") }
    func dropMemory() { record("drop") }
    func deleteKeychainKey() { record("keychain") }

    private func record(_ step: String) {
        steps.append(step)
        generations.append(session.value)
    }
}

/// A detail that holds opened mail, for OpenKeyStore's drop.
@MainActor
final class PlaintextProbe: PlaintextHolder {
    private(set) var drops = 0
    func dropPlaintext() { drops += 1 }
}

/// The world UnlockModel runs in: the vector's key, a session signed in as `me`, a fake Keychain.
@MainActor
struct UnlockWorld {
    let v: EnvelopeVector
    let session: SessionGeneration
    let keychain: FakeKeychain
    let biometrics: FakeBiometrics
    let policy: KeyStorePolicy
    let vault: KeyVault
    let store: OpenKeyStore
    let keys: FakeMailKeys
    let deriver: GatedDeriver
    let model: UnlockModel

    static let service = "com.iwakisyogo.otodoke.auth"

    init(session: SessionGeneration? = nil, availability: BiometricAvailability = .available(.faceID), key: LoadResult<StoredKeyRow?>? = nil) throws {
        let v = try EnvelopeVector()
        self.v = v
        let session = session ?? {
            let s = SessionGeneration()
            s.update(userID: FakeSupabase.me)
            return s
        }()
        self.session = session
        keychain = FakeKeychain()
        biometrics = FakeBiometrics(availability)
        policy = KeyStorePolicy(defaults: scratchDefaults())
        vault = KeyVault(keychain: keychain, biometrics: biometrics, policy: policy, service: Self.service)
        store = OpenKeyStore(session: session, vault: vault)
        keys = FakeMailKeys(key: key ?? .loaded(v.row()))
        deriver = GatedDeriver(recipient: try v.testRecipient(), passphrase: v.passphrase)
        model = UnlockModel(store: store, keys: keys, vault: vault, policy: policy, deriver: deriver)
    }

    /// The vector's key kept on the device (as a past unlock left it).
    func plantVaultKey(user: String = FakeSupabase.me, kid: String? = nil) {
        keychain.plant(
            KeychainItem(service: Self.service, account: KeyVault.account, accessibility: .whenPasscodeSetThisDeviceOnly, biometryCurrentSet: true, synchronizable: false, userID: user, keyID: kid ?? v.keyID),
            secret: v.recipientD
        )
    }

    var vaultCount: Int { keychain.count(service: Self.service) }

    /// The vector's key put straight into memory for the session now.
    func putKeyInMemory() throws {
        let stamp = try require_(store.stamp())
        store.put(OpenedKey(userID: FakeSupabase.me, recipient: try v.testRecipient()), stamp: stamp)
    }
}

struct Missing: Error {}

/// #require outside a test function.
func require_<T>(_ value: T?) throws -> T {
    guard let value else { throw Missing() }
    return value
}
