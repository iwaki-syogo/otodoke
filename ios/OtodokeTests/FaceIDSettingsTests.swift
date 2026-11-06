import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 19, CX3, task 15 Info.plist] The settings switch 「この端末で Face ID を使う」 (off forbids saving
/// first, then deletes the item; a key made meanwhile does not make it again), when the switch shows, the four
/// Face ID lines (Face ID or Touch ID, never both), NSFaceIDUsageDescription, and the one item 「あなたのメールの
/// 扱い」 gains (the same words on the Web and in the README: src/lib/__tests__/ios-scaffold-b2-m2.test.ts).
@Suite("Face ID in settings (batch 2, task 19)")
@MainActor
struct FaceIDSettingsTests {
    // MARK: the words

    @Test func theFourLinesFollowTheDevice() {
        for kind in [BiometryKind.faceID, .touchID] {
            let name = kind == .faceID ? "Face ID" : "Touch ID"
            let otherName = kind == .faceID ? "Touch ID" : "Face ID"
            for line in [FaceIDText.toggle(kind), FaceIDText.usage(kind)] {
                #expect(line.contains(name), "\(line)")
                #expect(!line.contains(otherName), "\(line)")
            }
            for line in [FaceIDText.passphraseField(kind), FaceIDText.cannotSave(kind)] {
                #expect(!line.isEmpty)
                #expect(!line.contains(otherName), "\(line)")
            }
        }
        for line in [FaceIDText.passphraseField(nil), FaceIDText.cannotSave(nil)] {
            #expect(!line.isEmpty)
            #expect(!line.contains("Face ID") && !line.contains("Touch ID"), "\(line)")
        }
    }

    @Test func theUsageDescriptionIsInTheAppsInfoPlist() {
        #expect(!FaceIDText.usageDescription.isEmpty)
        #expect(FaceIDText.usageDescription == FaceIDText.usage(.faceID))
        #expect(Bundle.main.object(forInfoDictionaryKey: "NSFaceIDUsageDescription") as? String == FaceIDText.usageDescription)
    }

    @Test func theMailHandlingGainsTheKeychainItem() {
        #expect(MailHandlingText.items.count == 13)
        let added = MailHandlingText.items.filter { $0.contains("キーチェーン") }
        #expect(added.count == 1)
        let item = added.first ?? ""
        for fact in ["Face ID", "外に出", "同期", "ログアウト"] {
            #expect(item.contains(fact), "\(fact)")
        }
        // The repository link stays the last item.
        #expect(MailHandlingText.items.last == "運営者が正しいプログラムを動かしていることが前提です。コードはすべて公開しています。")
    }

    // MARK: the switch

    struct World {
        let keychain: FakeKeychain
        let policy: KeyStorePolicy
        let vault: KeyVault
        let toggle: FaceIDSwitch
    }

    func world(_ availability: BiometricAvailability = .available(.faceID)) -> World {
        let keychain = FakeKeychain()
        let policy = KeyStorePolicy(defaults: scratchDefaults())
        let vault = KeyVault(keychain: keychain, biometrics: FakeBiometrics(availability), policy: policy, service: UnlockWorld.service)
        return World(keychain: keychain, policy: policy, vault: vault, toggle: FaceIDSwitch(policy: policy, vault: vault))
    }

    func plant(_ w: World) {
        w.keychain.plant(KeychainItem(service: UnlockWorld.service, account: KeyVault.account, accessibility: .whenPasscodeSetThisDeviceOnly, biometryCurrentSet: true, synchronizable: false, userID: FakeSupabase.me, keyID: KeyVaultTests.kid), secret: Data(repeating: 1, count: 32))
    }

    @Test func onAtFirstAndOffDeletesTheKey() {
        let w = world()
        plant(w)
        #expect(w.toggle.isOn)
        #expect(w.toggle.biometry == .faceID)
        w.toggle.set(false)
        #expect(!w.toggle.isOn)
        #expect(!w.policy.isAllowed)
        #expect(w.keychain.count(service: UnlockWorld.service) == 0)
        w.toggle.set(true)
        #expect(w.toggle.isOn)
        // On again keeps nothing by itself: the next unlock saves.
        #expect(w.keychain.count(service: UnlockWorld.service) == 0)
        #expect(w.keychain.adds.isEmpty)
    }

    @Test func offForbidsSavingBeforeItDeletes() {
        let w = world()
        plant(w)
        final class Seen: @unchecked Sendable { var allowedAtDelete: [Bool] = [] }
        let seen = Seen()
        let policy = w.policy
        w.keychain.onDelete {
            MainActor.assumeIsolated { seen.allowedAtDelete.append(policy.isAllowed) }
        }
        w.toggle.set(false)
        #expect(seen.allowedAtDelete == [false])
    }

    @Test func aDeviceWithoutBiometricsHasNoSwitchToUse() {
        #expect(world(.noPasscode).toggle.biometry == nil)
        #expect(world(.available(.touchID)).toggle.biometry == .touchID)
    }

    @Test func aKeyMadeWhileTurningOffIsNotKept() async throws {
        let w = try UnlockWorld()
        let toggle = FaceIDSwitch(policy: w.policy, vault: w.vault)
        let gate = Gate()
        w.deriver.hold(on: gate)
        let run = Task { await w.model.submit(password: w.v.passphrase, email: UnlockWorld.email) }
        defer { gate.open() }
        let deriver = w.deriver
        #expect(await waitFor { deriver.calls == 1 })
        toggle.set(false)
        gate.open()
        _ = await run.value
        #expect(w.keychain.adds.isEmpty)
        #expect(w.vaultCount == 0)
    }

    // MARK: when it shows on the settings screen

    private func settings(keys: [Row], faults: (FakeSupabase) async -> Void = { _ in }) async throws -> SettingsModel {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", keys)
        await faults(fake)
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
        model.faceID = world().toggle
        await model.load()
        return model
    }

    @Test func theSwitchShowsOnlyWithAKeyInUse() async throws {
        let v = try EnvelopeVector()
        #expect(try await settings(keys: [v.keyRow(userID: FakeSupabase.me)]).showsFaceIDToggle)
        #expect(try await settings(keys: []).showsFaceIDToggle == false)
        #expect(try await settings(keys: [v.keyRow(userID: FakeSupabase.me)], faults: { await $0.fail("GET", "user_keys", with: .http(500)) }).showsFaceIDToggle == false)
    }

    @Test func noSwitchWithoutAFaceIDSwitch() async throws {
        let v = try EnvelopeVector()
        let model = try await settings(keys: [v.keyRow(userID: FakeSupabase.me)])
        model.faceID = nil
        #expect(model.showsFaceIDToggle == false)
    }
}
