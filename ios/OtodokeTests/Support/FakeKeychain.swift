import Foundation
import Security
@testable import Otodoke

/// [Batch 2, M2] The Keychain in memory, answering with the OSStatus the real one gives. It records every
/// add, read and delete (with the context each read used), can hold a read on a Gate (Face ID waiting),
/// can force a read's or an add's status (cancel, auth failed, no passcode), and can mark an item as
/// invalidated (biometry changed: the attributes are still there, the secret no longer opens).
final class FakeKeychain: Keychain, @unchecked Sendable {
    private struct Stored {
        var item: KeychainItem
        var secret: Data
        var invalidated = false
    }

    private let lock = NSLock()
    private var items: [String: Stored] = [:]
    private var addLog: [KeychainItem] = []
    private var readLog: [(account: String, context: ObjectIdentifier, reason: String)] = []
    private var deleteLog: [String] = []
    private var forcedAdd: OSStatus?
    private var forcedRead: OSStatus?
    private var gate: Gate?
    private var readEntered = 0
    /// Called (on the caller's thread) when delete is called, before anything is removed.
    private var deleteObserver: (@Sendable () -> Void)?

    private static func key(_ service: String, _ account: String) -> String { "\(service)|\(account)" }

    // MARK: setting it up

    func forceAdd(_ status: OSStatus?) { lock.withLock { forcedAdd = status } }
    func forceRead(_ status: OSStatus?) { lock.withLock { forcedRead = status } }
    func holdReads(on gate: Gate?) { lock.withLock { self.gate = gate } }
    func onDelete(_ observer: (@Sendable () -> Void)?) { lock.withLock { deleteObserver = observer } }

    /// An item put there directly (another install, another user).
    func plant(_ item: KeychainItem, secret: Data) {
        lock.withLock { items[Self.key(item.service, item.account)] = Stored(item: item, secret: secret) }
    }

    /// Biometry changed: the item stays listed but its secret can no longer be read.
    func invalidate(service: String, account: String) {
        lock.withLock { items[Self.key(service, account)]?.invalidated = true }
    }

    // MARK: what happened

    var adds: [KeychainItem] { lock.withLock { addLog } }
    var readCount: Int { lock.withLock { readLog.count } }
    var readContexts: [ObjectIdentifier] { lock.withLock { readLog.map(\.context) } }
    var readReasons: [String] { lock.withLock { readLog.map(\.reason) } }
    var deletes: [String] { lock.withLock { deleteLog } }
    /// Reads that reached the Keychain (and may be waiting on the gate).
    var readsEntered: Int { lock.withLock { readEntered } }

    func count(service: String) -> Int {
        lock.withLock { items.values.filter { $0.item.service == service }.count }
    }

    func item(service: String, account: String) -> KeychainItem? {
        lock.withLock { items[Self.key(service, account)]?.item }
    }

    func secret(service: String, account: String) -> Data? {
        lock.withLock { items[Self.key(service, account)]?.secret }
    }

    // MARK: Keychain

    func add(_ item: KeychainItem, secret: Data) -> OSStatus {
        lock.withLock {
            addLog.append(item)
            if let forcedAdd { return forcedAdd }
            let k = Self.key(item.service, item.account)
            guard items[k] == nil else { return errSecDuplicateItem }
            items[k] = Stored(item: item, secret: secret)
            return errSecSuccess
        }
    }

    func readSecret(service: String, account: String, context: any BiometricContext, reason: String) async -> (status: OSStatus, secret: Data?) {
        let waitOn: Gate? = lock.withLock {
            readLog.append((account, ObjectIdentifier(context), reason))
            readEntered += 1
            return gate
        }
        if let waitOn { await waitOn.wait() }
        return lock.withLock {
            if let forcedRead { return (forcedRead, nil) }
            guard let stored = items[Self.key(service, account)] else { return (errSecItemNotFound, nil) }
            if stored.invalidated { return (errSecItemNotFound, nil) }
            return (errSecSuccess, stored.secret)
        }
    }

    func attributes(service: String, account: String) -> (status: OSStatus, item: KeychainItem?) {
        lock.withLock {
            guard let stored = items[Self.key(service, account)] else { return (errSecItemNotFound, nil) }
            return (errSecSuccess, stored.item)
        }
    }

    func delete(service: String, account: String) -> OSStatus {
        let observer = lock.withLock { deleteObserver }
        observer?()
        return lock.withLock {
            deleteLog.append(account)
            return items.removeValue(forKey: Self.key(service, account)) == nil ? errSecItemNotFound : errSecSuccess
        }
    }
}

final class FakeBiometricContext: BiometricContext, @unchecked Sendable {}

/// LAContext, faked: what the device offers, and every context made (each use must make a new one).
final class FakeBiometrics: Biometrics, @unchecked Sendable {
    private let lock = NSLock()
    private var offered: BiometricAvailability
    private var made: [FakeBiometricContext] = []

    init(_ availability: BiometricAvailability = .available(.faceID)) {
        offered = availability
    }

    func set(_ availability: BiometricAvailability) { lock.withLock { offered = availability } }
    var contextsMade: Int { lock.withLock { made.count } }
    var contextIDs: [ObjectIdentifier] { lock.withLock { made.map(ObjectIdentifier.init) } }

    func newContext() -> any BiometricContext {
        let c = FakeBiometricContext()
        lock.withLock { made.append(c) }
        return c
    }

    func availability(in context: any BiometricContext) -> BiometricAvailability {
        lock.withLock { offered }
    }
}

/// A UserDefaults of its own for each test (the switch's choice is persisted).
func scratchDefaults() -> UserDefaults {
    let name = "otodoke.tests.\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: name)!
    defaults.removePersistentDomain(forName: name)
    return defaults
}

/// A Keychain service of its own for each real-Keychain test.
func scratchService() -> String { "com.iwakisyogo.otodoke.tests.\(UUID().uuidString.lowercased())" }
