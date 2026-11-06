// TDD-STUB(task 17, CX2, CX3): opening the key.
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
// Names and signatures are the contract with UnlockModelTests / SealedMailTests.

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
        throw .wrongPassphrase // TDD-STUB(task 17)
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

    init(store: OpenKeyStore, keys: any MailKeyReading, vault: KeyVault?, policy: KeyStorePolicy, deriver: any KeyDeriving = LiveKeyDeriver()) {
        self.store = store
        self.keys = keys
        self.vault = vault
        self.policy = policy
        self.deriver = deriver
    }

    /// The Face ID reason shown by the system (FaceIDText).
    var biometry: BiometryKind? {
        nil // TDD-STUB(task 17)
    }

    /// The key: memory, else Face ID (once in this front period), else nil with phase .needsPassphrase.
    func key() async -> OpenedKey? {
        nil // TDD-STUB(task 17)
    }

    /// true when the key is open in memory afterwards (and the stamps were current).
    @discardableResult
    func submit(passphrase: String) async -> Bool {
        false // TDD-STUB(task 17)
    }

    /// The key for a sealed mail's kid (T17-4).
    func recipient(forKid kid: String) async -> RecipientOutcome {
        .readFailed // TDD-STUB(task 17)
    }
}
