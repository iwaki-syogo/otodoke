// Keeping the opened key on this device with Face ID (task 15, CX3).
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

/// The app's Keychain (SecItem*). The key item is only ever written with the strong attributes; an item that
/// asks for anything else is refused (errSecParam), never written weaker.
struct SystemKeychain: Keychain {
    init() {}

    /// user_id and the key id ride on the item as kSecAttrGeneric (readable without Face ID).
    private struct Owner: Codable {
        let userID: String
        let keyID: String

        enum CodingKeys: String, CodingKey {
            case userID = "user_id"
            case keyID = "key_id"
        }
    }

    private func base(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    func add(_ item: KeychainItem, secret: Data) -> OSStatus {
        guard item.accessibility == .whenPasscodeSetThisDeviceOnly, item.biometryCurrentSet, !item.synchronizable else { return errSecParam }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, &error) else {
            error?.release()
            return errSecParam
        }
        guard let owner = try? JSONEncoder().encode(Owner(userID: item.userID, keyID: item.keyID)) else { return errSecParam }
        var query = base(service: item.service, account: item.account)
        query[kSecValueData as String] = secret
        query[kSecAttrAccessControl as String] = access
        query[kSecAttrSynchronizable as String] = kCFBooleanFalse
        query[kSecAttrGeneric as String] = owner
        return SecItemAdd(query as CFDictionary, nil)
    }

    func readSecret(service: String, account: String, context: any BiometricContext, reason: String) async -> (status: OSStatus, secret: Data?) {
        guard let system = context as? SystemBiometricContext else { return (errSecParam, nil) }
        // SecItemCopyMatching waits for Face ID: never on the main thread.
        let job = Task.detached(priority: .userInitiated) { () -> (OSStatus, Data?) in
            system.context.localizedReason = reason
            var query = base(service: service, account: account)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            query[kSecUseAuthenticationContext as String] = system.context
            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            return (status, status == errSecSuccess ? result as? Data : nil)
        }
        let (status, secret) = await job.value
        return (status, secret)
    }

    func attributes(service: String, account: String) -> (status: OSStatus, item: KeychainItem?) {
        // Never any UI: a context that may not interact.
        let quiet = SystemBiometricContext().context
        quiet.interactionNotAllowed = true
        var query = base(service: service, account: account)
        query[kSecReturnAttributes as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        query[kSecUseAuthenticationContext as String] = quiet
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let attrs = result as? [String: Any] else { return (status, nil) }
        let owner = (attrs[kSecAttrGeneric as String] as? Data).flatMap { try? JSONDecoder().decode(Owner.self, from: $0) }
        let accessible = attrs[kSecAttrAccessible as String] as? String
        let item = KeychainItem(
            service: attrs[kSecAttrService as String] as? String ?? service,
            account: attrs[kSecAttrAccount as String] as? String ?? account,
            accessibility: accessible == (kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as String) ? .whenPasscodeSetThisDeviceOnly : .other,
            // The access control's flags cannot be read back; only add(_:secret:) writes one, always .biometryCurrentSet.
            biometryCurrentSet: attrs[kSecAttrAccessControl as String] != nil,
            synchronizable: (attrs[kSecAttrSynchronizable as String] as? NSNumber)?.boolValue ?? false,
            userID: owner?.userID ?? "",
            keyID: owner?.keyID ?? ""
        )
        return (status, item)
    }

    func delete(service: String, account: String) -> OSStatus {
        SecItemDelete(base(service: service, account: account) as CFDictionary)
    }
}

/// The app's LAContext, one per use.
final class SystemBiometricContext: BiometricContext, @unchecked Sendable {
    let context: LAContext

    init() {
        context = LAContext()
    }
}

struct SystemBiometrics: Biometrics {
    init() {}

    func newContext() -> any BiometricContext {
        SystemBiometricContext()
    }

    func availability(in context: any BiometricContext) -> BiometricAvailability {
        guard let system = context as? SystemBiometricContext else { return .unavailable }
        var error: NSError?
        if system.context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            switch system.context.biometryType {
            case .faceID: return .available(.faceID)
            case .touchID: return .available(.touchID)
            default: return .unavailable
            }
        }
        switch error.flatMap({ LAError.Code(rawValue: $0.code) }) {
        case .passcodeNotSet?: return .noPasscode
        case .biometryNotEnrolled?: return .notEnrolled
        case .biometryLockout?: return .lockedOut
        default: return .unavailable
        }
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
    private(set) var isAllowed: Bool
    private(set) var generation: Int = 0
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        isAllowed = defaults.object(forKey: Self.defaultsKey) as? Bool ?? true
    }

    func ticket() -> Ticket {
        Ticket(generation: generation)
    }

    /// Allowed, and nothing changed since the ticket.
    func permits(_ ticket: Ticket) -> Bool {
        isAllowed && ticket.generation == generation
    }

    /// Forbids saving (and moves the generation) before anything is deleted.
    func turnOff() {
        isAllowed = false
        generation += 1
        defaults.set(false, forKey: Self.defaultsKey)
    }

    func turnOn() {
        isAllowed = true
        generation += 1
        defaults.set(true, forKey: Self.defaultsKey)
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
    private let keychain: any Keychain
    private let biometrics: any Biometrics

    init(keychain: any Keychain, biometrics: any Biometrics, policy: KeyStorePolicy, service: String = KeyVault.defaultService) {
        self.service = service
        self.policy = policy
        self.keychain = keychain
        self.biometrics = biometrics
    }

    static func shouldDelete(_ event: VaultEvent) -> Bool {
        switch event {
        case .signedOut, .keyRowKidDiffers, .otherUser, .biometryChanged, .freshInstall, .turnedOff:
            true
        case .readFailed, .noKeyRows, .sealedMailKidDiffers, .cancelled, .lockedOut:
            false
        }
    }

    /// errSecSuccess → opened; errSecUserCanceled → cancelled; errSecItemNotFound → invalidated when the
    /// attributes are there, nothing when not; anything else (errSecAuthFailed, errSecInteractionNotAllowed,
    /// …) → unavailable.
    static func classify(status: OSStatus, itemExists: Bool) -> VaultReadKind {
        switch status {
        case errSecSuccess: .opened
        case errSecUserCanceled: .cancelled
        case errSecItemNotFound: itemExists ? .invalidated : .nothing
        default: .unavailable
        }
    }

    /// What this device offers now (a new context each time); nil when it has no biometrics to use.
    var biometry: BiometryKind? {
        if case let .available(kind) = biometrics.availability(in: biometrics.newContext()) { return kind }
        return nil
    }

    func hasItem() -> Bool {
        keychain.attributes(service: service, account: Self.account).item != nil
    }

    /// Saves (replacing an older item) when `policy.permits(ticket)` and `stillCurrent()` right before the add,
    /// and the device can keep it.
    func save(_ key: VaultKey, ticket: KeyStorePolicy.Ticket, stillCurrent: () -> Bool) -> VaultSave {
        // One stretch on the main actor from the check to the add: nothing can turn it off in between (CX3).
        guard policy.permits(ticket), stillCurrent() else { return .notAllowed }
        guard case .available = biometrics.availability(in: biometrics.newContext()) else { return .memoryOnly }
        let item = KeychainItem(
            service: service,
            account: Self.account,
            accessibility: .whenPasscodeSetThisDeviceOnly,
            biometryCurrentSet: true,
            synchronizable: false,
            userID: key.userID,
            keyID: key.keyID
        )
        var status = keychain.add(item, secret: key.secret)
        if status == errSecDuplicateItem {
            _ = keychain.delete(service: service, account: Self.account)
            status = keychain.add(item, secret: key.secret)
        }
        return status == errSecSuccess ? .saved : .memoryOnly
    }

    /// The kept key for `userID`, with Face ID (once, through a new context). No prompt when there is no
    /// item, it is another user's (deleted), keeping is off, or biometrics are unavailable.
    func load(userID: String, reason: String) async -> VaultLoad {
        guard policy.isAllowed else { return .nothing }
        guard let item = keychain.attributes(service: service, account: Self.account).item else { return .nothing }
        guard item.userID == userID else {
            remove(.otherUser)
            return .otherUser
        }
        let context = biometrics.newContext()
        guard case .available = biometrics.availability(in: context) else { return .unavailable }
        let (status, secret) = await keychain.readSecret(service: service, account: Self.account, context: context, reason: reason)
        let exists = status == errSecItemNotFound ? hasItem() : true
        switch Self.classify(status: status, itemExists: exists) {
        case .opened:
            guard let secret else { return .unavailable }
            return .opened(VaultKey(userID: item.userID, keyID: item.keyID, secret: secret))
        case .nothing:
            return .nothing
        case .cancelled:
            return .cancelled
        case .invalidated:
            remove(.biometryChanged)
            return .invalidated
        case .unavailable:
            return .unavailable
        }
    }

    /// Deletes the item when `shouldDelete(event)`; true when it was deleted (or there was none to delete).
    @discardableResult
    func remove(_ event: VaultEvent) -> Bool {
        guard Self.shouldDelete(event) else { return false }
        let status = keychain.delete(service: service, account: Self.account)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/// The settings switch 「この端末で Face ID を使う」 (task 19). Off: the policy first, then the item.
@MainActor
@Observable
final class FaceIDSwitch {
    let policy: KeyStorePolicy
    let vault: KeyVault
    /// Moves on with each set(_:), so a view reading isOn follows the policy (which is not observable itself).
    private var revision = 0

    init(policy: KeyStorePolicy, vault: KeyVault) {
        self.policy = policy
        self.vault = vault
    }

    var isOn: Bool {
        _ = revision
        return policy.isAllowed
    }

    /// nil when the device has no biometrics to use (the 「保存できないとき」 line instead).
    var biometry: BiometryKind? {
        vault.biometry
    }

    /// CX3: off forbids saving first (the policy's generation moves on), then deletes the item.
    func set(_ on: Bool) {
        if on {
            policy.turnOn()
        } else {
            policy.turnOff()
            vault.remove(.turnedOff)
        }
        revision += 1
    }
}
