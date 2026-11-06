// TDD-STUB(task 15, CX3): keeping the opened key on this device with Face ID.
//  - The Keychain and LAContext are wrapped in protocols (Keychain, Biometrics) so the flows are tested with
//    fakes; SystemKeychain / SystemBiometrics are the app's.
//  - The item: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, synchronizable false,
//    in the login session's service under another account (FreshInstall's one delete takes it too), with the
//    user_id and the key id on it (readable without Face ID). A new LAContext for each use.
//  - When the device cannot keep it (no passcode, no Face ID, the Keychain refused) the key stays in memory
//    only: .memoryOnly. Never a weaker item instead.
//  - Deleted only for: sign-out, the key row read with another kid, the item of another user, biometry
//    changed, FreshInstall, the switch turned off. Kept for: a failed read, no key row, a sealed mail's kid
//    differing, a cancel, a lockout (shouldDelete).
//  - CX3: whether saving is allowed, and its generation, are one shared state (KeyStorePolicy). Turning it
//    off forbids saving first and then deletes. A save checks the policy ticket and the caller's own check
//    right before it adds, on the main actor (so nothing can turn it off in between).
// Names and signatures are the contract with KeyVaultTests / UnlockModelTests / FaceIDSettingsTests.

import Foundation
import LocalAuthentication
import Observation
import Security

enum BiometryKind: Equatable, Sendable {
    case faceID
    case touchID
}

enum BiometricAvailability: Equatable, Sendable {
    case available(BiometryKind)
    case noPasscode
    case notEnrolled
    case lockedOut
    case unavailable
}

/// One LAContext (made anew for each use).
protocol BiometricContext: AnyObject, Sendable {}

protocol Biometrics: Sendable {
    /// A new context (never one kept from before).
    func newContext() -> any BiometricContext
    /// What the device offers now, asked through `context` (canEvaluatePolicy, biometryType).
    func availability(in context: any BiometricContext) -> BiometricAvailability
}

enum KeychainAccessibility: Equatable, Sendable {
    case whenPasscodeSetThisDeviceOnly
    case afterFirstUnlockThisDeviceOnly
    case other
}

/// The attributes of the key item (all readable without Face ID).
struct KeychainItem: Equatable, Sendable {
    var service: String
    var account: String
    var accessibility: KeychainAccessibility
    /// A SecAccessControl with .biometryCurrentSet.
    var biometryCurrentSet: Bool
    var synchronizable: Bool
    var userID: String
    var keyID: String
}

protocol Keychain: Sendable {
    func add(_ item: KeychainItem, secret: Data) -> OSStatus
    /// The secret; shows Face ID through `context` with `reason`. Runs off the main thread.
    func readSecret(service: String, account: String, context: any BiometricContext, reason: String) async -> (status: OSStatus, secret: Data?)
    /// The attributes only: no secret, never any UI.
    func attributes(service: String, account: String) -> (status: OSStatus, item: KeychainItem?)
    func delete(service: String, account: String) -> OSStatus
}

/// The app's Keychain (SecItem*).
struct SystemKeychain: Keychain {
    init() {}

    func add(_ item: KeychainItem, secret: Data) -> OSStatus {
        errSecUnimplemented // TDD-STUB(task 15)
    }

    func readSecret(service: String, account: String, context: any BiometricContext, reason: String) async -> (status: OSStatus, secret: Data?) {
        (errSecUnimplemented, nil) // TDD-STUB(task 15)
    }

    func attributes(service: String, account: String) -> (status: OSStatus, item: KeychainItem?) {
        (errSecUnimplemented, nil) // TDD-STUB(task 15)
    }

    func delete(service: String, account: String) -> OSStatus {
        errSecUnimplemented // TDD-STUB(task 15)
    }
}

/// The app's LAContext, one per use.
final class SystemBiometricContext: BiometricContext, @unchecked Sendable {
    let context = LAContext()
}

struct SystemBiometrics: Biometrics {
    init() {}

    func newContext() -> any BiometricContext {
        SystemBiometricContext() // TDD-STUB(task 15)
    }

    func availability(in context: any BiometricContext) -> BiometricAvailability {
        .unavailable // TDD-STUB(task 15)
    }
}

/// The key as kept: whose it is, its id, and the private key's raw d (32 bytes).
struct VaultKey: Equatable, Sendable {
    let userID: String
    let keyID: String
    let secret: Data
}

enum VaultSave: Equatable, Sendable {
    case saved
    /// The device cannot keep it (no passcode, no Face ID, the Keychain refused): memory only.
    case memoryOnly
    /// Turned off, or the policy ticket or the caller's check went stale: nothing written.
    case notAllowed
}

enum VaultLoad: Equatable, Sendable {
    case opened(VaultKey)
    /// No item (or keeping is turned off): nothing asked.
    case nothing
    /// The person cancelled Face ID.
    case cancelled
    /// The item can no longer be opened (biometry changed): deleted.
    case invalidated
    /// The item is another user's: deleted.
    case otherUser
    /// Locked out, no passcode, Face ID failed: kept.
    case unavailable
}

/// What a read of the secret says, by OSStatus (and whether the item's attributes are there).
enum VaultReadKind: Equatable, Sendable {
    case opened
    case nothing
    case cancelled
    case invalidated
    case unavailable
}

/// The moments that may delete the item.
enum VaultEvent: CaseIterable, Equatable, Sendable {
    // deleted
    case signedOut
    case keyRowKidDiffers
    case otherUser
    case biometryChanged
    case freshInstall
    case turnedOff
    // kept
    case readFailed
    case noKeyRows
    case sealedMailKidDiffers
    case cancelled
    case lockedOut
}

/// CX3: may the key be kept on this device, and the generation of that choice. Persisted in `defaults`.
@MainActor
final class KeyStorePolicy {
    struct Ticket: Equatable, Sendable {
        let generation: Int
    }

    static let defaultsKey = "otodoke.keepKeyWithBiometrics"

    /// On unless turned off (and persisted).
    private(set) var isAllowed: Bool = false
    private(set) var generation: Int = 0
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults // TDD-STUB(task 15): read the stored choice
    }

    func ticket() -> Ticket {
        Ticket(generation: generation) // TDD-STUB(task 15)
    }

    /// Allowed, and nothing changed since the ticket.
    func permits(_ ticket: Ticket) -> Bool {
        false // TDD-STUB(task 15)
    }

    /// Forbids saving (and moves the generation) before anything is deleted.
    func turnOff() {
        // TDD-STUB(task 15)
    }

    func turnOn() {
        // TDD-STUB(task 15)
    }
}

@MainActor
final class KeyVault {
    /// The login session's service (KeychainSessionStorage's default).
    static let defaultService = "com.iwakisyogo.otodoke.auth"
    /// Not the session's account (sb-<ref>-auth-token): reading the session never touches this item.
    static let account = "otodoke-mail-key"

    let service: String
    let policy: KeyStorePolicy

    init(keychain: any Keychain, biometrics: any Biometrics, policy: KeyStorePolicy, service: String = KeyVault.defaultService) {
        self.service = service
        self.policy = policy
        // TDD-STUB(task 15)
    }

    static func shouldDelete(_ event: VaultEvent) -> Bool {
        false // TDD-STUB(task 15)
    }

    /// errSecSuccess → opened; errSecUserCanceled → cancelled; errSecItemNotFound → invalidated when the
    /// attributes are there, nothing when not; anything else (errSecAuthFailed, errSecInteractionNotAllowed,
    /// …) → unavailable.
    static func classify(status: OSStatus, itemExists: Bool) -> VaultReadKind {
        .unavailable // TDD-STUB(task 15)
    }

    /// What this device offers now (a new context each time); nil when it has no biometrics to use.
    var biometry: BiometryKind? {
        nil // TDD-STUB(task 15)
    }

    func hasItem() -> Bool {
        false // TDD-STUB(task 15)
    }

    /// Saves (replacing an older item) when `policy.permits(ticket)` and `stillCurrent()` right before the add,
    /// and the device can keep it.
    func save(_ key: VaultKey, ticket: KeyStorePolicy.Ticket, stillCurrent: () -> Bool) -> VaultSave {
        .notAllowed // TDD-STUB(task 15)
    }

    /// The kept key for `userID`, with Face ID (once, through a new context). No prompt when there is no
    /// item, it is another user's (deleted), keeping is off, or biometrics are unavailable.
    func load(userID: String, reason: String) async -> VaultLoad {
        .nothing // TDD-STUB(task 15)
    }

    /// Deletes the item when `shouldDelete(event)`; true when it was deleted (or there was none to delete).
    @discardableResult
    func remove(_ event: VaultEvent) -> Bool {
        false // TDD-STUB(task 15)
    }
}

/// The settings switch 「この端末で Face ID を使う」 (task 19). Off: the policy first, then the item.
@MainActor
@Observable
final class FaceIDSwitch {
    let policy: KeyStorePolicy
    let vault: KeyVault

    init(policy: KeyStorePolicy, vault: KeyVault) {
        self.policy = policy
        self.vault = vault
    }

    var isOn: Bool {
        false // TDD-STUB(task 19)
    }

    /// nil when the device has no biometrics to use (the 「保存できないとき」 line instead).
    var biometry: BiometryKind? {
        nil // TDD-STUB(task 19)
    }

    func set(_ on: Bool) {
        // TDD-STUB(task 19)
    }
}
