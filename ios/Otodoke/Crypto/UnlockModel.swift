// Opening the key (task 17, CX2, CX3).
//  - key(): the key in memory; else Face ID once per front period (KeyVault.load); else the passphrase.
//    Face ID unavailable or refused goes back to the passphrase.
//  - submit(passphrase:): reads the key row, runs PBKDF2 off the main thread (KeyDeriving), one at a time
//    (a second submit while one runs does nothing), 「開いています…」 meanwhile, the time taken recorded
//    (never a value or the passphrase). A wrong passphrase is 「合言葉が違います」. The key is put in memory
//    and saved to the Keychain only when the stamps (session + front period) are still current; the save
//    also takes the policy ticket from the start (CX3). A device that cannot keep it goes on in memory.
//  - recipient(forKid:): a sealed mail's kid differs from the key in memory → read the key row again →
//    not readable: 「読み込めませんでした」 → its kid is the mail's: the device key is old (deleted, as
//    KeyVault.shouldDelete(.keyRowKidDiffers)), the passphrase opens the new one → still another kid:
//    「前の合言葉で暗号化したメールです。もう開けません。」 (the device key is kept).

import CryptoKit
import Foundation
import Observation

protocol KeyDeriving: Sendable {
    /// openStoredKey, off the main thread.
    func open(_ row: StoredKeyRow, passphrase: String, userID: String) async throws(CryptoError) -> PrivateRecipient
}

/// The app's: KeyWrap.openStoredKey with `kdf` (PBKDF2), never on the main thread.
struct LiveKeyDeriver: KeyDeriving {
    let kdf: KeyWrap.KDF

    init(kdf: @escaping KeyWrap.KDF = KeyWrap.pbkdf2) {
        self.kdf = kdf
    }

    func open(_ row: StoredKeyRow, passphrase: String, userID: String) async throws(CryptoError) -> PrivateRecipient {
        let kdf = self.kdf
        let result = await Task.detached(priority: .userInitiated) { () -> Result<PrivateRecipient, CryptoError> in
            do throws(CryptoError) {
                return .success(try KeyWrap.openStoredKey(row, passphrase: passphrase, userID: userID, kdf: kdf))
            } catch {
                return .failure(error)
            }
        }.value
        return try result.get()
    }
}

enum RecipientOutcome: Equatable, Sendable {
    case key(OpenedKey)
    /// The passphrase is needed (no key, or the device key turned out old).
    case needsPassphrase
    /// 「読み込めませんでした」 (the key row could not be read).
    case readFailed
    /// 「前の合言葉で暗号化したメールです。もう開けません。」
    case oldKey
}

@MainActor
@Observable
final class UnlockModel {
    enum Phase: Equatable, Sendable {
        case idle
        /// Face ID is being asked.
        case askingBiometrics
        /// The passphrase field is shown.
        case needsPassphrase
        /// 「開いています…」
        case opening
    }

    static let openingText = "開いています…"
    static let wrongPassphraseText = "合言葉が違います"
    static let readFailedText = "読み込めませんでした"
    static let failedText = "開けませんでした"
    static let oldKeyText = "前の合言葉で暗号化したメールです。もう開けません。"

    private(set) var phase: Phase = .idle
    /// Under the field: 「合言葉が違います」, 「読み込めませんでした」, 「開けませんでした」.
    private(set) var message: String?
    /// The last save's result (.memoryOnly shows the 「保存できないとき」 line).
    private(set) var saveResult: VaultSave?
    /// How long the last PBKDF2 took (recorded, never with a value).
    private(set) var lastOpenDuration: Duration?

    @ObservationIgnored let store: OpenKeyStore
    @ObservationIgnored let keys: any MailKeyReading
    @ObservationIgnored let vault: KeyVault?
    @ObservationIgnored let policy: KeyStorePolicy
    @ObservationIgnored let deriver: any KeyDeriving

    /// The front period (and session) Face ID was last asked in: asked once per period.
    @ObservationIgnored private var askedFaceID: UnlockStamp?
    /// The Face ID ask in flight, shared by every key() that comes meanwhile.
    @ObservationIgnored private var faceIDTask: Task<OpenedKey?, Never>?
    /// A submit is running (PBKDF2 runs one at a time).
    @ObservationIgnored private var submitting = false

    init(store: OpenKeyStore, keys: any MailKeyReading, vault: KeyVault?, policy: KeyStorePolicy, deriver: any KeyDeriving = LiveKeyDeriver()) {
        self.store = store
        self.keys = keys
        self.vault = vault
        self.policy = policy
        self.deriver = deriver
    }

    /// The Face ID reason shown by the system (FaceIDText).
    var biometry: BiometryKind? {
        vault?.biometry
    }

    /// The key: memory, else Face ID (once in this front period), else nil with phase .needsPassphrase.
    func key() async -> OpenedKey? {
        if let key = store.key {
            if phase != .opening { phase = .idle }
            return key
        }
        if let faceIDTask { return await faceIDTask.value }
        guard let stamp = store.stamp() else { return nil }
        guard let vault, askedFaceID != stamp, let kind = vault.biometry else {
            if phase != .opening { phase = .needsPassphrase }
            return nil
        }
        askedFaceID = stamp
        let task = Task { await self.openWithFaceID(vault: vault, kind: kind, stamp: stamp) }
        faceIDTask = task
        let key = await task.value
        faceIDTask = nil
        return key
    }

    private func openWithFaceID(vault: KeyVault, kind: BiometryKind, stamp: UnlockStamp) async -> OpenedKey? {
        phase = .askingBiometrics
        let loaded = await vault.load(userID: stamp.session.userID, reason: FaceIDText.usage(kind))
        // Signed out, another account, or the background meanwhile: nothing is kept or shown (CX2).
        guard store.isCurrent(stamp) else {
            if phase == .askingBiometrics { phase = .idle }
            return nil
        }
        if case let .opened(kept) = loaded, kept.userID == stamp.session.userID, let recipient = Self.recipient(kept) {
            let key = OpenedKey(userID: kept.userID, recipient: recipient)
            if store.put(key, stamp: stamp) {
                phase = .idle
                return key
            }
        }
        // Cancelled, no match, unavailable, invalidated, or a kept key that is not its kid: the passphrase.
        phase = .needsPassphrase
        return nil
    }

    /// The kept raw d as a recipient, only when its public key's id is the kid it was kept under.
    private static func recipient(_ kept: VaultKey) -> PrivateRecipient? {
        guard let privateKey = try? AgreementPrivate(rawRepresentation: kept.secret) else { return nil }
        let publicKey = privateKey.publicKey.x963Representation
        guard KeyWrap.keyIDOf(publicKey) == kept.keyID else { return nil }
        return PrivateRecipient(keyID: kept.keyID, publicKey: publicKey, privateKey: privateKey)
    }

    /// true when the key is open in memory afterwards (and the stamps were current).
    @discardableResult
    func submit(passphrase: String) async -> Bool {
        guard !submitting, let stamp = store.stamp() else { return false }
        // CX3: the save may only use the policy as it was when this started.
        let ticket = policy.ticket()
        submitting = true
        defer { submitting = false }
        phase = .opening
        message = nil

        let row: StoredKeyRow
        switch await keys.currentKey() {
        case let .loaded(found?):
            row = found
        case .loaded(nil), .failed:
            return finish(stamp, message: Self.readFailedText)
        }
        guard store.isCurrent(stamp) else { return finish(stamp, message: nil) }

        let clock = ContinuousClock()
        let started = clock.now
        let recipient: PrivateRecipient
        do {
            recipient = try await deriver.open(row, passphrase: passphrase, userID: stamp.session.userID)
        } catch {
            lastOpenDuration = clock.now - started
            return finish(stamp, message: error == .wrongPassphrase ? Self.wrongPassphraseText : Self.failedText)
        }
        lastOpenDuration = clock.now - started

        let key = OpenedKey(userID: stamp.session.userID, recipient: recipient)
        // The background, a sign-out or another account while PBKDF2 ran: nothing is kept (CX2).
        guard store.put(key, stamp: stamp) else { return finish(stamp, message: nil) }
        if let vault {
            let kept = VaultKey(userID: key.userID, keyID: key.keyID, secret: recipient.privateKey.rawRepresentation)
            let store = self.store
            saveResult = vault.save(kept, ticket: ticket, stillCurrent: { store.isCurrent(stamp) })
        } else {
            saveResult = .memoryOnly
        }
        phase = .idle
        message = nil
        return true
    }

    /// A submit that did not open: back to the field with `message`, unless the stamps went stale.
    private func finish(_ stamp: UnlockStamp, message: String?) -> Bool {
        if store.isCurrent(stamp) {
            phase = .needsPassphrase
            self.message = message
        } else {
            phase = .idle
            self.message = nil
        }
        return false
    }

    /// The key for a sealed mail's kid (T17-4).
    func recipient(forKid kid: String) async -> RecipientOutcome {
        guard let key = await key() else { return .needsPassphrase }
        if key.keyID == kid { return .key(key) }
        guard let stamp = store.stamp() else { return .needsPassphrase }

        // Another kid: the key row read again decides.
        let read = await keys.currentKey()
        guard store.isCurrent(stamp) else { return .needsPassphrase }
        guard case let .loaded(row?) = read else {
            // Not readable (or no key row): nothing is deleted.
            return .readFailed
        }
        if row.keyId != key.keyID {
            // The key in use is not the device's: the device key is old.
            vault?.remove(.keyRowKidDiffers)
            store.forgetKey()
        }
        if row.keyId == kid {
            phase = .needsPassphrase
            return .needsPassphrase
        }
        // An older passphrase's mail (the device key is kept unless it was old itself).
        return .oldKey
    }
}
