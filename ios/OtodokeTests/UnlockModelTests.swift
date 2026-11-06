import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 17, CX2, CX3, task 16] Opening the key: memory, Face ID once, the passphrase; PBKDF2 off the
/// main thread and one at a time; a kid that differs. Then the orders the plan fixes with Gates: the
/// background, the switch turned off, a sign-out and an account switch, each landing while a step is held,
/// and nothing is kept, saved or shown afterwards.
@Suite("UnlockModel (batch 2, task 17)")
@MainActor
struct UnlockModelTests {
    static let me = FakeSupabase.me
    static let otherKid = "0123456789abcdef0123456789abcdef"

    // MARK: memory, Face ID, the passphrase

    @Test func theWords() {
        #expect(UnlockModel.openingText == "開いています…")
        #expect(UnlockModel.wrongPassphraseText == "合言葉が違います")
        #expect(UnlockModel.readFailedText == "読み込めませんでした")
        #expect(UnlockModel.failedText == "開けませんでした")
        #expect(UnlockModel.oldKeyText == "前の合言葉で暗号化したメールです。もう開けません。")
    }

    @Test func aKeyInMemoryIsUsedWithoutAskingAnything() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        try w.putKeyInMemory()
        let key = await w.model.key()
        #expect(key?.keyID == w.v.keyID)
        #expect(w.keychain.readCount == 0)
        #expect(w.keys.keyReadCount == 0)
        #expect(w.deriver.calls == 0)
    }

    @Test func faceIDOpensTheKeptKey() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        let key = await w.model.key()
        #expect(key?.keyID == w.v.keyID)
        #expect(key?.recipient.publicKey == w.v.recipientPublic)
        #expect(w.store.key?.keyID == w.v.keyID)
        #expect(w.keychain.readCount == 1)
        #expect(w.deriver.calls == 0)
        #expect(w.model.phase == .idle)
        // In memory now: no second Face ID.
        _ = await w.model.key()
        #expect(w.keychain.readCount == 1)
    }

    @Test func aKeptKeyThatIsNotItsKidIsNotUsed() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey(kid: Self.otherKid)
        #expect(await w.model.key() == nil)
        #expect(w.store.key == nil)
        #expect(w.model.phase == .needsPassphrase)
    }

    @Test func aCancelGoesBackToThePassphraseAndFaceIDIsAskedOncePerFront() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        w.keychain.forceRead(errSecUserCanceled)
        #expect(await w.model.key() == nil)
        #expect(w.model.phase == .needsPassphrase)
        #expect(await w.model.key() == nil)
        #expect(w.keychain.readCount == 1)
        #expect(w.vaultCount == 1)
        // A new front period asks again.
        w.store.wentToBackground()
        _ = await w.model.key()
        #expect(w.keychain.readCount == 2)
    }

    @Test(arguments: [BiometricAvailability.lockedOut, .noPasscode, .notEnrolled])
    func unavailableFaceIDGoesStraightToThePassphrase(_ availability: BiometricAvailability) async throws {
        let w = try UnlockWorld(availability: availability)
        w.plantVaultKey()
        #expect(await w.model.key() == nil)
        #expect(w.model.phase == .needsPassphrase)
        #expect(w.keychain.readCount == 0)
        #expect(w.vaultCount == 1)
    }

    @Test func noMatchGoesBackToThePassphrase() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        w.keychain.forceRead(errSecAuthFailed)
        #expect(await w.model.key() == nil)
        #expect(w.model.phase == .needsPassphrase)
        #expect(w.vaultCount == 1)
    }

    @Test func aWrongPassphraseIsTold() async throws {
        let w = try UnlockWorld()
        _ = await w.model.key()
        #expect(await w.model.submit(passphrase: "ちがう合言葉ちがう合言葉") == false)
        #expect(w.model.message == UnlockModel.wrongPassphraseText)
        #expect(w.model.phase == .needsPassphrase)
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
    }

    @Test func theRightPassphraseOpensAndKeepsTheKeyWithFaceID() async throws {
        let w = try UnlockWorld()
        _ = await w.model.key()
        #expect(await w.model.submit(passphrase: w.v.passphrase))
        #expect(w.store.key?.keyID == w.v.keyID)
        #expect(w.model.message == nil)
        #expect(w.model.phase == .idle)
        #expect(w.model.saveResult == .saved)
        #expect(w.model.lastOpenDuration != nil)
        let item = w.keychain.item(service: UnlockWorld.service, account: KeyVault.account)
        #expect(item?.userID == Self.me)
        #expect(item?.keyID == w.v.keyID)
        #expect(w.keychain.secret(service: UnlockWorld.service, account: KeyVault.account) == w.v.recipientD)
    }

    @Test func aDeviceThatCannotKeepItGoesOnInMemory() async throws {
        let w = try UnlockWorld(availability: .noPasscode)
        #expect(await w.model.submit(passphrase: w.v.passphrase))
        #expect(w.store.key?.keyID == w.v.keyID)
        #expect(w.model.saveResult == .memoryOnly)
        #expect(w.vaultCount == 0)
    }

    @Test func turnedOffItIsOpenedButNotKept() async throws {
        let w = try UnlockWorld()
        w.policy.turnOff()
        #expect(await w.model.submit(passphrase: w.v.passphrase))
        #expect(w.store.key != nil)
        #expect(w.model.saveResult == .notAllowed)
        #expect(w.keychain.adds.isEmpty)
    }

    @Test func anUnreadableKeyRowIsReadFailedAndRunsNoPBKDF2() async throws {
        for answer in [LoadResult<StoredKeyRow?>.failed, .loaded(nil)] {
            let w = try UnlockWorld(key: answer)
            #expect(await w.model.submit(passphrase: w.v.passphrase) == false)
            #expect(w.model.message == UnlockModel.readFailedText)
            #expect(w.deriver.calls == 0)
            #expect(w.model.phase == .needsPassphrase)
        }
    }

    @Test func aBadKeyRowIsNotAWrongPassphrase() async throws {
        let w = try UnlockWorld()
        w.deriver.fail(with: .badKeyRow)
        #expect(await w.model.submit(passphrase: w.v.passphrase) == false)
        #expect(w.model.message == UnlockModel.failedText)
    }

    // MARK: PBKDF2: one at a time, off the main thread

    @Test func oneAtATimeWithOpeningShownMeanwhile() async throws {
        let w = try UnlockWorld()
        let gate = Gate()
        w.deriver.hold(on: gate)
        let first = Task { await w.model.submit(passphrase: w.v.passphrase) }
        defer { gate.open() }
        let deriver = w.deriver
        #expect(await waitFor { deriver.calls == 1 })
        #expect(w.model.phase == .opening)
        #expect(await w.model.submit(passphrase: w.v.passphrase) == false)
        #expect(w.deriver.calls == 1)
        gate.open()
        #expect(await first.value)
        #expect(w.deriver.maxAtOnce == 1)
    }

    @Test func pbkdf2RunsOffTheMainThread() async throws {
        let w = try UnlockWorld()
        #expect(await w.model.submit(passphrase: w.v.passphrase))
        #expect(w.deriver.ranOnMainThread == 0)

        // The app's deriver with the real PBKDF2, called from the main actor.
        let rec = KDFRecorder()
        let live = LiveKeyDeriver(kdf: rec.kdf)
        let r = try await live.open(w.v.row(), passphrase: w.v.passphrase, userID: Self.me)
        #expect(r.keyID == w.v.keyID)
        #expect(rec.calls.count == 1)
        #expect(rec.calls.first?.onMainThread == false)
    }

    @Test func theLiveDeriverTellsAWrongPassphrase() async throws {
        let w = try UnlockWorld()
        let live = LiveKeyDeriver()
        do {
            _ = try await live.open(w.v.row(), passphrase: "ちがう合言葉ちがう合言葉", userID: Self.me)
            Issue.record("opened with a wrong passphrase")
        } catch {
            #expect(error == .wrongPassphrase)
        }
    }

    // MARK: a sealed mail's kid differs (T17-4)

    @Test func theKidOfTheKeyInMemoryNeedsNoRead() async throws {
        let w = try UnlockWorld()
        try w.putKeyInMemory()
        #expect(await w.model.recipient(forKid: w.v.keyID) == .key(try #require(w.store.key)))
        #expect(w.keys.keyReadCount == 0)
    }

    @Test func anotherKidAndTheKeyRowCannotBeRead() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        try w.putKeyInMemory()
        w.keys.answerKeys([.failed])
        #expect(await w.model.recipient(forKid: Self.otherKid) == .readFailed)
        #expect(w.keys.keyReadCount == 1)
        #expect(w.vaultCount == 1)
        #expect(w.store.key != nil)
    }

    @Test func anotherKidAndTheKeyRowIsNowThatKid() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        try w.putKeyInMemory()
        w.keys.answerKeys([.loaded(w.v.row(keyID: Self.otherKid))])
        #expect(await w.model.recipient(forKid: Self.otherKid) == .needsPassphrase)
        // The device key was an old one: gone from the Keychain and from memory.
        #expect(w.vaultCount == 0)
        #expect(w.store.key == nil)
        #expect(w.model.phase == .needsPassphrase)
    }

    @Test func anotherKidAndTheKeyRowIsStillOursIsAnOldMail() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        try w.putKeyInMemory()
        w.keys.answerKeys([.loaded(w.v.row())])
        #expect(await w.model.recipient(forKid: Self.otherKid) == .oldKey)
        #expect(w.vaultCount == 1)
        #expect(w.store.key?.keyID == w.v.keyID)
    }

    @Test func noKeyAndFaceIDCancelledNeedsThePassphrase() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        w.keychain.forceRead(errSecUserCanceled)
        #expect(await w.model.recipient(forKid: w.v.keyID) == .needsPassphrase)
        #expect(w.vaultCount == 1)
    }

    // MARK: the orders fixed with Gates (CX2, CX3, task 16)

    @Test func theBackgroundWhilePBKDF2RunsKeepsNoKey() async throws {
        let w = try UnlockWorld()
        let gate = Gate()
        w.deriver.hold(on: gate)
        let run = Task { await w.model.submit(passphrase: w.v.passphrase) }
        defer { gate.open() }
        let deriver = w.deriver
        #expect(await waitFor { deriver.calls == 1 })
        w.store.wentToBackground()
        gate.open()
        #expect(await run.value == false)
        #expect(w.store.key == nil)
        #expect(w.keychain.adds.isEmpty)
        #expect(w.vaultCount == 0)
    }

    @Test func turnedOffWhilePBKDF2RunsNoItemIsMade() async throws {
        let w = try UnlockWorld()
        // An older item from before, then the switch is turned off mid-way.
        w.plantVaultKey(kid: Self.otherKid)
        let toggle = FaceIDSwitch(policy: w.policy, vault: w.vault)
        let gate = Gate()
        w.deriver.hold(on: gate)
        let run = Task { await w.model.submit(passphrase: w.v.passphrase) }
        defer { gate.open() }
        let deriver = w.deriver
        #expect(await waitFor { deriver.calls == 1 })
        toggle.set(false)
        #expect(w.vaultCount == 0)
        gate.open()
        _ = await run.value
        #expect(w.keychain.adds.isEmpty)
        #expect(w.vaultCount == 0)
        #expect(w.model.saveResult != .saved)
    }

    @Test func signingOutWhileTheKeyIsMadeKeepsAndShowsNothing() async throws {
        let fake = FakeSupabase.make()
        let (_, auth) = try await TestSession.signedIn(fake)
        let w = try UnlockWorld(session: auth.session)
        auth.cleanup = w.store
        let gate = Gate()
        w.deriver.hold(on: gate)
        let run = Task { await w.model.submit(passphrase: w.v.passphrase) }
        defer { gate.open() }
        let deriver = w.deriver
        #expect(await waitFor { deriver.calls == 1 })
        await auth.signOut()
        gate.open()
        #expect(await run.value == false)
        #expect(w.store.key == nil)
        #expect(w.keychain.adds.isEmpty)
        #expect(w.vaultCount == 0)
    }

    @Test func anAccountSwitchWhileFaceIDWaitsKeepsAndShowsNothing() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        let gate = Gate()
        w.keychain.holdReads(on: gate)
        let run = Task { await w.model.key() }
        defer { gate.open() }
        let keychain = w.keychain
        #expect(await waitFor { keychain.readsEntered == 1 })
        w.session.update(userID: FakeSupabase.other)
        gate.open()
        #expect(await run.value == nil)
        #expect(w.store.key == nil)
        #expect(w.keychain.adds.isEmpty)
    }

    @Test func theBackgroundWhileFaceIDWaitsKeepsNoKey() async throws {
        let w = try UnlockWorld()
        w.plantVaultKey()
        let gate = Gate()
        w.keychain.holdReads(on: gate)
        let run = Task { await w.model.key() }
        defer { gate.open() }
        let keychain = w.keychain
        #expect(await waitFor { keychain.readsEntered == 1 })
        w.store.wentToBackground()
        gate.open()
        #expect(await run.value == nil)
        #expect(w.store.key == nil)
        // The background is not a reason to delete the device key.
        #expect(w.vaultCount == 1)
    }
}
