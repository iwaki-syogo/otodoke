import Foundation
import LocalAuthentication
import Security
import Testing
@testable import Otodoke

/// [Batch 2, task 15] Keeping the opened key with Face ID. The Keychain and LAContext are fakes here (this
/// Mac's simctl cannot drive Face ID): a match, no match, a cancel, biometry changed, no passcode, a lockout.
/// What is deleted and what is kept is one function (shouldDelete). The item's attributes are checked on the
/// real Keychain of the simulator at the end, with the session's item beside it and FreshInstall's delete.
@Suite("KeyVault with fakes (batch 2, task 15)")
@MainActor
struct KeyVaultTests {
    static let service = "com.iwakisyogo.otodoke.auth"
    static let me = FakeSupabase.me
    static let other = FakeSupabase.other
    static let kid = "01360a5a3fd78d79f6fa52bcee61ef7e"
    static let otherKid = "0123456789abcdef0123456789abcdef"
    static let secret = Data(repeating: 7, count: 32)

    struct World {
        let keychain: FakeKeychain
        let biometrics: FakeBiometrics
        let policy: KeyStorePolicy
        let vault: KeyVault
    }

    func world(_ availability: BiometricAvailability = .available(.faceID)) -> World {
        let keychain = FakeKeychain()
        let biometrics = FakeBiometrics(availability)
        let policy = KeyStorePolicy(defaults: scratchDefaults())
        let vault = KeyVault(keychain: keychain, biometrics: biometrics, policy: policy, service: Self.service)
        return World(keychain: keychain, biometrics: biometrics, policy: policy, vault: vault)
    }

    func key(_ user: String = me, _ kid: String = kid) -> VaultKey { VaultKey(userID: user, keyID: kid, secret: Self.secret) }

    func plantedItem(user: String = me, kid: String = kid) -> KeychainItem {
        KeychainItem(service: Self.service, account: KeyVault.account, accessibility: .whenPasscodeSetThisDeviceOnly, biometryCurrentSet: true, synchronizable: false, userID: user, keyID: kid)
    }

    // MARK: what is deleted, what is kept

    @Test func deletedOnlyAtTheListedMoments() {
        let deleted: Set<VaultEvent> = [.signedOut, .keyRowKidDiffers, .otherUser, .biometryChanged, .freshInstall, .turnedOff]
        let kept: Set<VaultEvent> = [.readFailed, .noKeyRows, .sealedMailKidDiffers, .cancelled, .lockedOut]
        #expect(deleted.union(kept) == Set(VaultEvent.allCases))
        for e in deleted { #expect(KeyVault.shouldDelete(e), "\(e)") }
        for e in kept { #expect(!KeyVault.shouldDelete(e), "\(e)") }
    }

    @Test func removeFollowsShouldDelete() {
        for event in VaultEvent.allCases {
            let w = world()
            w.keychain.plant(plantedItem(), secret: Self.secret)
            w.vault.remove(event)
            #expect((w.keychain.count(service: Self.service) == 0) == KeyVault.shouldDelete(event), "\(event)")
        }
    }

    @Test func theOSStatusSaysWhatHappened() {
        #expect(KeyVault.classify(status: errSecSuccess, itemExists: true) == .opened)
        #expect(KeyVault.classify(status: errSecUserCanceled, itemExists: true) == .cancelled)
        #expect(KeyVault.classify(status: errSecItemNotFound, itemExists: false) == .nothing)
        #expect(KeyVault.classify(status: errSecItemNotFound, itemExists: true) == .invalidated)
        #expect(KeyVault.classify(status: errSecAuthFailed, itemExists: true) == .unavailable)
        #expect(KeyVault.classify(status: errSecInteractionNotAllowed, itemExists: true) == .unavailable)
        #expect(KeyVault.classify(status: errSecNotAvailable, itemExists: true) == .unavailable)
    }

    @Test func theItemSitsBesideTheSessionUnderAnotherAccount() {
        #expect(KeyVault.defaultService == KeychainSessionStorage().service)
        let config = AppConfig(supabaseURL: URL(string: "https://abcdefghijklmnop.supabase.co")!, anonKey: "k", inboundDomain: "in.example.test")
        #expect(KeyVault.account != SupabaseProvider.storageKey(for: config))
        #expect(!KeyVault.account.hasPrefix("sb-"))
    }

    // MARK: saving

    @Test func savedWithTheAttributesAndTheOwner() {
        let w = world()
        #expect(w.vault.save(key(), ticket: w.policy.ticket(), stillCurrent: { true }) == .saved)
        let item = w.keychain.item(service: Self.service, account: KeyVault.account)
        #expect(item == plantedItem())
        #expect(w.keychain.secret(service: Self.service, account: KeyVault.account) == Self.secret)
        #expect(w.vault.hasItem())
    }

    @Test func aNewerKeyReplacesTheOlder() {
        let w = world()
        #expect(w.vault.save(key(Self.me, Self.otherKid), ticket: w.policy.ticket(), stillCurrent: { true }) == .saved)
        #expect(w.vault.save(key(), ticket: w.policy.ticket(), stillCurrent: { true }) == .saved)
        #expect(w.keychain.count(service: Self.service) == 1)
        #expect(w.keychain.item(service: Self.service, account: KeyVault.account)?.keyID == Self.kid)
    }

    @Test(arguments: [BiometricAvailability.noPasscode, .notEnrolled, .unavailable])
    func aDeviceThatCannotKeepItGoesOnInMemory(_ availability: BiometricAvailability) {
        let w = world(availability)
        #expect(w.vault.save(key(), ticket: w.policy.ticket(), stillCurrent: { true }) == .memoryOnly)
        #expect(w.keychain.count(service: Self.service) == 0)
        #expect(w.keychain.adds.isEmpty)
    }

    @Test func aRefusedAddIsMemoryOnlyAndNeverAWeakerItem() {
        let w = world()
        w.keychain.forceAdd(errSecAuthFailed)
        #expect(w.vault.save(key(), ticket: w.policy.ticket(), stillCurrent: { true }) == .memoryOnly)
        #expect(w.keychain.count(service: Self.service) == 0)
        for a in w.keychain.adds {
            #expect(a.accessibility == .whenPasscodeSetThisDeviceOnly)
            #expect(a.biometryCurrentSet)
            #expect(!a.synchronizable)
        }
    }

    @Test func notSavedWhenTurnedOffOrStale() {
        let off = world()
        let ticket = off.policy.ticket()
        off.policy.turnOff()
        #expect(off.vault.save(key(), ticket: ticket, stillCurrent: { true }) == .notAllowed)
        #expect(off.vault.save(key(), ticket: off.policy.ticket(), stillCurrent: { true }) == .notAllowed)
        #expect(off.keychain.adds.isEmpty)

        let stale = world()
        #expect(stale.vault.save(key(), ticket: stale.policy.ticket(), stillCurrent: { false }) == .notAllowed)
        #expect(stale.keychain.adds.isEmpty)

        let moved = world()
        let old = moved.policy.ticket()
        moved.policy.turnOff()
        moved.policy.turnOn()
        #expect(moved.policy.isAllowed)
        #expect(moved.vault.save(key(), ticket: old, stillCurrent: { true }) == .notAllowed)
        #expect(moved.keychain.adds.isEmpty)
    }

    // MARK: loading (Face ID)

    @Test func aMatchOpensTheKeyThroughANewContextEachTime() async {
        let w = world()
        w.keychain.plant(plantedItem(), secret: Self.secret)
        #expect(await w.vault.load(userID: Self.me, reason: "理由") == .opened(key()))
        #expect(await w.vault.load(userID: Self.me, reason: "理由") == .opened(key()))
        #expect(w.keychain.readCount == 2)
        let used = w.keychain.readContexts
        #expect(Set(used).count == 2)
        #expect(Set(used).isSubset(of: Set(w.biometrics.contextIDs)))
        #expect(w.keychain.readReasons == ["理由", "理由"])
    }

    @Test func noMatchIsUnavailableAndKept() async {
        let w = world()
        w.keychain.plant(plantedItem(), secret: Self.secret)
        w.keychain.forceRead(errSecAuthFailed)
        #expect(await w.vault.load(userID: Self.me, reason: "r") == .unavailable)
        #expect(w.keychain.count(service: Self.service) == 1)
    }

    @Test func aCancelIsKept() async {
        let w = world()
        w.keychain.plant(plantedItem(), secret: Self.secret)
        w.keychain.forceRead(errSecUserCanceled)
        #expect(await w.vault.load(userID: Self.me, reason: "r") == .cancelled)
        #expect(w.keychain.count(service: Self.service) == 1)
    }

    @Test func changedBiometryDeletesTheItem() async {
        let w = world()
        w.keychain.plant(plantedItem(), secret: Self.secret)
        w.keychain.invalidate(service: Self.service, account: KeyVault.account)
        #expect(await w.vault.load(userID: Self.me, reason: "r") == .invalidated)
        #expect(w.keychain.count(service: Self.service) == 0)
    }

    @Test(arguments: [BiometricAvailability.lockedOut, .noPasscode, .notEnrolled, .unavailable])
    func unavailableBiometricsAskNothingAndKeepTheItem(_ availability: BiometricAvailability) async {
        let w = world(availability)
        w.keychain.plant(plantedItem(), secret: Self.secret)
        #expect(await w.vault.load(userID: Self.me, reason: "r") == .unavailable)
        #expect(w.keychain.readCount == 0)
        #expect(w.keychain.count(service: Self.service) == 1)
    }

    @Test func anotherUsersItemIsDeletedWithoutAsking() async {
        let w = world()
        w.keychain.plant(plantedItem(user: Self.other), secret: Self.secret)
        #expect(await w.vault.load(userID: Self.me, reason: "r") == .otherUser)
        #expect(w.keychain.readCount == 0)
        #expect(w.keychain.count(service: Self.service) == 0)
    }

    @Test func nothingKeptAsksNothing() async {
        let w = world()
        #expect(await w.vault.load(userID: Self.me, reason: "r") == .nothing)
        #expect(w.keychain.readCount == 0)
    }

    @Test func turnedOffAsksNothing() async {
        let w = world()
        w.keychain.plant(plantedItem(), secret: Self.secret)
        w.policy.turnOff()
        #expect(await w.vault.load(userID: Self.me, reason: "r") == .nothing)
        #expect(w.keychain.readCount == 0)
    }

    @Test func whatTheDeviceOffers() {
        #expect(world(.available(.faceID)).vault.biometry == .faceID)
        #expect(world(.available(.touchID)).vault.biometry == .touchID)
        #expect(world(.noPasscode).vault.biometry == nil)
        #expect(world(.notEnrolled).vault.biometry == nil)
    }

    // MARK: the policy (CX3)

    @Test func thePolicyIsOnUntilTurnedOffAndRemembered() {
        let defaults = scratchDefaults()
        let policy = KeyStorePolicy(defaults: defaults)
        #expect(policy.isAllowed)
        let t = policy.ticket()
        #expect(policy.permits(t))
        policy.turnOff()
        #expect(!policy.isAllowed)
        #expect(!policy.permits(t))
        #expect(!policy.permits(policy.ticket()))
        #expect(policy.generation > t.generation)
        #expect(!KeyStorePolicy(defaults: defaults).isAllowed)
        policy.turnOn()
        #expect(KeyStorePolicy(defaults: defaults).isAllowed)
    }
}

/// The simulator's real Keychain: the item's attributes (this device only, not synchronized, Face ID's
/// current set), the session's item read by its own account beside it, and FreshInstall's one delete.
@Suite("KeyVault on the real Keychain (batch 2, task 15)", .serialized)
@MainActor
struct KeyVaultRealKeychainTests {
    private func rawAttributes(service: String, account: String) -> (OSStatus, [String: Any]?) {
        var out: AnyObject?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnAttributes as String: true,
            kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ] as CFDictionary, &out)
        return (status, out as? [String: Any])
    }

    private func clear(_ service: String) {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }

    @Test func theItemIsThisDeviceOnlyNotSynchronizedAndBehindFaceID() throws {
        let service = scratchService()
        defer { clear(service) }
        let item = KeychainItem(service: service, account: KeyVault.account, accessibility: .whenPasscodeSetThisDeviceOnly, biometryCurrentSet: true, synchronizable: false, userID: FakeSupabase.me, keyID: KeyVaultTests.kid)
        let keychain = SystemKeychain()
        #expect(keychain.add(item, secret: Data(repeating: 1, count: 32)) == errSecSuccess)

        let (status, attrs) = rawAttributes(service: service, account: KeyVault.account)
        #expect(status == errSecSuccess)
        let a = try #require(attrs)
        #expect(a[kSecAttrAccessible as String] as? String == kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly as String)
        #expect((a[kSecAttrSynchronizable as String] as? NSNumber)?.boolValue == false)
        #expect(a[kSecAttrAccessControl as String] != nil)
        #expect(a[kSecAttrService as String] as? String == service)
        #expect(a[kSecAttrAccount as String] as? String == KeyVault.account)

        // The wrapper reads the same back, user and key id included, without any UI.
        let (s2, read) = keychain.attributes(service: service, account: KeyVault.account)
        #expect(s2 == errSecSuccess)
        #expect(read == item)

        #expect(keychain.delete(service: service, account: KeyVault.account) == errSecSuccess)
        #expect(rawAttributes(service: service, account: KeyVault.account).0 == errSecItemNotFound)
    }

    @Test func theSessionIsReadByItsAccountWithTheKeyItemBeside() throws {
        let service = scratchService()
        defer { clear(service) }
        let storage = KeychainSessionStorage(service: service)
        let session = Data("{\"access_token\":\"t\"}".utf8)
        try storage.store(key: "sb-test-auth-token", value: session)
        let item = KeychainItem(service: service, account: KeyVault.account, accessibility: .whenPasscodeSetThisDeviceOnly, biometryCurrentSet: true, synchronizable: false, userID: FakeSupabase.me, keyID: KeyVaultTests.kid)
        #expect(SystemKeychain().add(item, secret: Data(repeating: 2, count: 32)) == errSecSuccess)
        #expect(try storage.retrieve(key: "sb-test-auth-token") == session)
        // Storing the session again updates its own item only.
        try storage.store(key: "sb-test-auth-token", value: Data("x".utf8))
        #expect(rawAttributes(service: service, account: KeyVault.account).0 == errSecSuccess)
    }

    @Test func freshInstallsOneDeleteTakesTheKeyItemToo() throws {
        let service = scratchService()
        defer { clear(service) }
        let added = SecItemAdd([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: KeyVault.account,
            kSecValueData as String: Data([1]),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly,
        ] as CFDictionary, nil)
        #expect(added == errSecSuccess)
        let marker = FileManager.default.temporaryDirectory.appending(path: "otodoke-fresh-\(UUID().uuidString)/installed")
        defer { try? FileManager.default.removeItem(at: marker.deletingLastPathComponent()) }
        #expect(FreshInstall.prepare(marker: marker, keychain: KeychainSessionStorage(service: service)) == .cleared)
        #expect(rawAttributes(service: service, account: KeyVault.account).0 == errSecItemNotFound)
    }

    @Test func withoutEnrolledBiometricsTheRealVaultKeepsNothing() throws {
        // Asked of LAContext here, not assumed: the expectation follows what this simulator offers.
        var error: NSError?
        let enrolled = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        let service = scratchService()
        defer { clear(service) }
        let vault = KeyVault(keychain: SystemKeychain(), biometrics: SystemBiometrics(), policy: KeyStorePolicy(defaults: scratchDefaults()), service: service)
        if enrolled {
            #expect(vault.biometry != nil)
        } else {
            #expect(vault.biometry == nil)
            #expect(vault.save(VaultKey(userID: FakeSupabase.me, keyID: KeyVaultTests.kid, secret: Data(repeating: 3, count: 32)), ticket: vault.policy.ticket(), stillCurrent: { true }) == .memoryOnly)
            #expect(rawAttributes(service: service, account: KeyVault.account).0 == errSecItemNotFound)
        }
    }
}
