import Foundation
import Testing
@testable import Otodoke

/// RB-5: a delayed password-recovery sign-in must not write the app's shared SDK session.
@Suite("Password recovery keeps the shared session (RB-5)")
@MainActor
struct PasswordRecoverySessionTests {
    @Test func aDelayedRecoveryCannotRestoreASignedOutAccount() async throws {
        let w = try await RecoverySessionWorld(), release = Gate()
        defer { release.open() }
        let run = try await holdRecovery(w, until: release)
        // PasswordRecoveryView.onDisappear clears the fields; its unstructured task still exists.
        w.model.clearPasswords()
        await w.auth.signOut()
        #expect(w.auth.state == .signedOut && w.storage.isEmpty)
        #expect(w.original.keys.store.key == nil && w.original.keys.vaultCount == 0)
        #expect(w.original.plaintext.drops == 1 && w.original.screens.list.rows.isEmpty)

        release.open()
        await run.value

        // Check SDK storage immediately: waiting for the old expected state could pass before its event arrives.
        #expect(w.auth.provider.auth.currentSession == nil && w.storage.isEmpty)
        await settle(w.auth)
        #expect(w.auth.state == .signedOut && RootScreen.of(w.auth.state) == .login)
        #expect(w.auth.session.stamp() == nil && w.auth.signedInObject() == nil)
        #expect(w.original.keys.store.key == nil && w.original.keys.vaultCount == 0)
        #expect(w.original.plaintext.drops == 1 && w.original.screens.list.rows.isEmpty)
        #expect(await w.api.tokens.isEmpty && w.completion.calls == 0)
        #expect(!w.model.opened && !w.model.isWorking)
        #expect(w.model.current.isEmpty && w.model.other.isEmpty)
    }

    @Test(arguments: ["another-account", "same-account"])
    func aDelayedRecoveryCannotReplaceANewerLogin(_ replacement: String) async throws {
        let w = try await RecoverySessionWorld(), release = Gate()
        defer { release.open() }
        let originalStamp = try #require(w.auth.session.stamp())
        let run = try await holdRecovery(w, until: release)
        w.model.clearPasswords()
        await w.auth.signOut()
        let another = replacement == "another-account"
        let userID = another ? FakeSupabase.other : FakeSupabase.me
        let email = another ? RecoverySessionWorld.otherEmail : FakeSupabase.email
        await w.fake.setUserEmail(email)
        try await w.auth.signIn(email: email, password: PW.good, captchaToken: nil)
        let currentStamp = try #require(w.auth.session.stamp())
        let currentSession = try #require(w.auth.provider.auth.currentSession)
        let currentBytes = try #require(try w.storedSession())
        #expect(currentStamp != originalStamp && currentStamp.userID == userID)
        let current = try await RecoveryLoadedGeneration(auth: w.auth)
        #expect(current.keys.store.key?.userID == userID && current.keys.vaultCount == 1)
        #expect(!current.screens.list.rows.isEmpty)

        release.open()
        await run.value

        #expect(w.auth.provider.auth.currentSession?.accessToken == currentSession.accessToken)
        #expect(w.auth.provider.auth.currentSession?.refreshToken == currentSession.refreshToken)
        #expect(try w.storedSession() == currentBytes)
        await settle(w.auth)
        #expect(w.auth.state == .signedIn(userID: userID) && RootScreen.of(w.auth.state) == .main)
        #expect(w.auth.session.isCurrent(currentStamp))
        #expect(w.auth.signedInEmail == email && w.auth.signedInObject() === current.screens)
        #expect(current.keys.store.key?.userID == userID && current.keys.vaultCount == 1)
        #expect(current.plaintext.drops == 0 && !current.screens.list.rows.isEmpty)
        #expect(w.auth.takeSignInSecret()?.master == PW.master(email: email, password: PW.good))
        #expect(w.original.keys.store.key == nil && w.original.keys.vaultCount == 0)
        #expect(w.original.plaintext.drops == 1 && w.original.screens.list.rows.isEmpty)
        #expect(await w.api.tokens.isEmpty && w.completion.calls == 0)
        #expect(!w.model.opened && !w.model.isWorking)
    }

    @Test func normalRecoveryUsesAFreshOwnerTokenWithoutChangingTheSharedLogin() async throws {
        let w = try await RecoverySessionWorld()
        let session = try #require(w.auth.provider.auth.currentSession)
        let stamp = try #require(w.auth.session.stamp())
        let bytes = try #require(try w.storedSession())

        await w.model.submit()

        let fresh = try #require(await w.api.tokens.first)
        #expect(fresh != session.accessToken)
        #expect(await w.fake.userID(forAccessToken: fresh) == FakeSupabase.me)
        #expect(await w.api.tokens.count == 1 && w.completion.calls == 1 && w.model.opened)
        #expect(w.auth.provider.auth.currentSession?.accessToken == session.accessToken)
        #expect(w.auth.provider.auth.currentSession?.refreshToken == session.refreshToken)
        #expect(try w.storedSession() == bytes)
        await settle(w.auth)
        #expect(w.auth.session.isCurrent(stamp) && w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.auth.signedInObject() === w.original.screens)
        #expect(w.original.keys.store.key != nil && w.original.keys.vaultCount == 1)
        #expect(w.original.plaintext.drops == 0 && !w.original.screens.list.rows.isEmpty)
        #expect(w.model.current.isEmpty && w.model.other.isEmpty && !w.model.isWorking)
        let request = try #require(await w.fake.requests("POST", "token").last)
        #expect(PW.captcha(request) == "recovery-captcha")
        #expect(await w.fake.count("POST", "token") == 2)
    }

    @Test func aRefusedRecoveryPreservesTheSharedLoginAndNeverWritesTheKey() async throws {
        let w = try await RecoverySessionWorld()
        let session = try #require(w.auth.provider.auth.currentSession)
        let stamp = try #require(w.auth.session.stamp())
        let bytes = try #require(try w.storedSession())
        await w.fake.forceAuth("password", status: 400, code: "invalid_credentials")

        await w.model.submit()

        #expect(w.auth.provider.auth.currentSession?.accessToken == session.accessToken)
        #expect(try w.storedSession() == bytes)
        await settle(w.auth)
        #expect(w.auth.session.isCurrent(stamp) && w.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(w.original.keys.store.key != nil && w.original.keys.vaultCount == 1)
        #expect(w.original.plaintext.drops == 0 && !w.original.screens.list.rows.isEmpty)
        #expect(await w.api.tokens.isEmpty && w.completion.calls == 0)
        #expect(!w.model.opened && w.model.message == LoginText.credentials)
        #expect(w.model.current.isEmpty && w.model.other.isEmpty && !w.model.isWorking)
        #expect(await w.fake.count("POST", "token") == 2)
    }

    @Test(arguments: ["leave", "cancel-task"])
    func cancellingALateRecoveryAllowsANewAttemptWithoutOldCompletion(_ cancellation: String) async throws {
        let w = try await RecoverySessionWorld(), release = Gate()
        defer { release.open() }
        let bytes = try #require(try w.storedSession())
        let stamp = try #require(w.auth.session.stamp())
        let oldRun = try await holdRecovery(w, until: release)
        w.model.cancel()
        if cancellation == "cancel-task" { oldRun.cancel() }
        #expect(!w.model.isWorking && w.model.current.isEmpty && w.model.other.isEmpty)
        #expect(await w.api.tokens.isEmpty && w.completion.calls == 0)
        #expect(try w.storedSession() == bytes)

        // A new sheet can use this same model while the old answer is still delayed.
        w.fillPasswords()
        await w.model.submit()
        #expect(await w.api.tokens.count == 1 && w.completion.calls == 1)
        #expect(w.model.opened && !w.model.isWorking && w.model.message == nil)
        release.open()
        await oldRun.value

        #expect(await w.api.tokens.count == 1 && w.completion.calls == 1)
        #expect(w.model.opened && !w.model.isWorking && w.model.message == nil)
        #expect(w.model.current.isEmpty && w.model.other.isEmpty)
        #expect(try w.storedSession() == bytes)
        #expect(w.auth.session.isCurrent(stamp) && w.original.keys.store.key != nil)
        #expect(w.original.plaintext.drops == 0)
    }

    @Test(arguments: ["shared-owner-before", "reply-owner", "reply-email"])
    func recoveryRejectsAnInconsistentOwnerOrEmailWithoutChangingSharedStorage(_ mismatch: String) async throws {
        // Without the listener this represents the window where SDK storage changed before AuthService consumed its event.
        let w = try await RecoverySessionWorld(startEvents: mismatch != "shared-owner-before")
        if mismatch == "shared-owner-before" {
            await w.fake.setUserEmail(RecoverySessionWorld.otherEmail)
            try await w.auth.provider.auth.signIn(email: RecoverySessionWorld.otherEmail, password: PW.secret(email: RecoverySessionWorld.otherEmail, password: PW.good))
            #expect(w.auth.state == .signedIn(userID: FakeSupabase.me))
            #expect(w.auth.provider.auth.currentSession?.user.id.uuidString.lowercased() == FakeSupabase.other)
        } else if mismatch == "reply-owner" {
            await w.fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good), userID: FakeSupabase.other)
        } else {
            await w.fake.setUserEmail(RecoverySessionWorld.otherEmail)
        }
        let current = try #require(w.auth.provider.auth.currentSession)
        let bytes = try #require(try w.storedSession())

        await w.model.submit()

        #expect(await w.api.tokens.isEmpty && w.completion.calls == 0)
        #expect(!w.model.opened && w.model.message == LoginText.other)
        #expect(w.auth.provider.auth.currentSession?.accessToken == current.accessToken)
        #expect(try w.storedSession() == bytes)
        // Initial login plus either the mismatched shared login or one private confirmation, never a retry.
        #expect(await w.fake.count("POST", "token") == 2)
    }

    @Test(arguments: ["normalized-email", "same-owner-refresh"])
    func legitimateEmailPresentationAndSameOwnerRefreshRemainAllowed(_ variation: String) async throws {
        let w = try await RecoverySessionWorld(), release = Gate()
        defer { release.open() }
        let stamp = try #require(w.auth.session.stamp())
        if variation == "normalized-email" { await w.fake.setUserEmail(" QA@EXAMPLE.COM\t ") }
        let run = try await holdRecovery(w, until: release)
        if variation == "same-owner-refresh" { _ = try await w.auth.provider.auth.refreshSession() }
        let shared = try #require(w.auth.provider.auth.currentSession)
        let bytes = try #require(try w.storedSession())
        release.open()
        await run.value

        #expect(w.model.opened && w.model.message == nil && w.completion.calls == 1)
        let fresh = try #require(await w.api.tokens.first)
        #expect(await w.fake.userID(forAccessToken: fresh) == FakeSupabase.me)
        #expect(fresh != shared.accessToken)
        #expect(w.auth.provider.auth.currentSession?.accessToken == shared.accessToken)
        #expect(try w.storedSession() == bytes)
        #expect(w.auth.session.isCurrent(stamp) && w.original.keys.store.key != nil)
        #expect(w.original.plaintext.drops == 0)
    }

    @Test(arguments: ["server", "transport"])
    func failedRecoveryConfirmationIsOnePOSTAndPreservesTheSharedLogin(_ failure: String) async throws {
        let w = try await RecoverySessionWorld()
        let shared = try #require(w.auth.provider.auth.currentSession)
        let bytes = try #require(try w.storedSession())
        if failure == "server" { await w.fake.fail("POST", "token", nth: 2, with: .http(500)) }
        else { await w.fake.fail("POST", "token", nth: 2, with: .transport(.timedOut)) }

        await w.model.submit()

        #expect(await w.fake.count("POST", "token") == 2)
        #expect(await w.api.tokens.isEmpty && w.completion.calls == 0)
        #expect(w.model.message == LoginText.network && !w.model.opened)
        #expect(w.auth.provider.auth.currentSession?.accessToken == shared.accessToken)
        #expect(try w.storedSession() == bytes)
        #expect(w.original.keys.store.key != nil && w.original.plaintext.drops == 0)
    }

    @Test(arguments: ["success", "wrong-password"])
    func cancellingRecoveryWhileTheLocalKeyDerivesKeepsNoCache(_ outcome: String) async throws {
        let w = try UnlockWorld(), release = Gate()
        defer { release.open() }
        if outcome == "wrong-password" { w.deriver.fail(with: .wrongPassword) }
        w.deriver.hold(on: release)
        let deriving = w.deriver
        let run = Task { await w.model.recovered(password: w.v.passphrase) }
        try #require(await waitFor { deriving.calls == 1 })
        #expect(w.model.phase == .opening && w.store.key == nil)

        run.cancel()
        release.open()

        #expect(await run.value == false)
        #expect(w.store.key == nil && w.vaultCount == 0)
        #expect(w.keychain.adds.isEmpty)
        #expect(w.model.phase != .opening)
        #expect(w.model.message == nil)
        // Cancellation does not retire the signed-in generation or prevent a fresh unlock.
        w.deriver.fail(with: nil)
        #expect(await w.model.recovered(password: w.v.passphrase))
        #expect(w.store.key?.keyID == w.v.keyID)
    }

    private func holdRecovery(_ w: RecoverySessionWorld, until release: Gate) async throws -> Task<Void, Never> {
        // .delay builds A's success response before yielding; B cannot change the held identity later.
        await w.fake.fail("POST", "token", nth: 2, with: .delay(release))
        let run = Task { await w.model.submit() }
        try #require(await waitFor { await w.fake.count("POST", "token") == 2 })
        #expect(w.model.isWorking)
        #expect(await w.api.tokens.isEmpty)
        return run
    }

    private func settle(_ auth: AuthService) async {
        // SDK emit occurs before the awaited sign-in returns. Allow the subscribed stream to drain,
        // then perform the same public session check used when the app comes back to the foreground.
        try? await Task.sleep(for: .milliseconds(100))
        await auth.checkSession()
    }
}

private actor RecoveryRewrapProbe: PasswordAccountAPI {
    private(set) var tokens: [String] = []
    func change(_ input: PasswordChangeInput, accessToken: String) async -> String? { "unexpected-change" }
    func rewrap(_ input: PasswordRewrap, accessToken: String) async -> String? { tokens.append(accessToken); return nil }
}

@MainActor
private final class RecoveryCompletionProbe { var calls = 0 }

@MainActor
private struct RecoveryLoadedGeneration {
    let screens: MainScreens
    let keys: UnlockWorld
    let plaintext: PlaintextProbe

    init(auth: AuthService) async throws {
        let stamp = try require_(auth.session.stamp())
        let screens = try require_(auth.signedInObject() as? MainScreens)
        let keys = try UnlockWorld(session: auth.session)
        keys.plantVaultKey(user: stamp.userID)
        let opened = OpenedKey(userID: stamp.userID, recipient: try keys.v.testRecipient())
        #expect(keys.store.put(opened, stamp: try require_(keys.store.stamp())))
        let plaintext = PlaintextProbe()
        keys.store.hold(plaintext)
        auth.cleanup = keys.store
        auth.clearLoadedData = { screens.clearForSignOut() }
        await screens.list.load(); await screens.settings.load()
        self.screens = screens; self.keys = keys; self.plaintext = plaintext
    }
}

@MainActor
private struct RecoverySessionWorld {
    static let otherEmail = "other@example.com"
    static let oldPassword = "A quiet river in autumn"
    let fake: FakeSupabase
    let storage: InMemorySessionStorage
    let auth: AuthService
    let original: RecoveryLoadedGeneration
    let api: RecoveryRewrapProbe
    let completion: RecoveryCompletionProbe
    let model: PasswordRecoveryModel

    init(startEvents: Bool = true) async throws {
        let fake = FakeSupabase.make(), storage = InMemorySessionStorage()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        await fake.addPasswordAccount(email: Self.otherEmail, secret: PW.secret(email: Self.otherEmail, password: PW.good), userID: FakeSupabase.other)
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped"]), Rows.parcel(2, ["user_id": .string(FakeSupabase.other), "status": "shipped"])])
        let auth = PW.auth(fake, storage: storage)
        auth.makeSignedIn = { MainScreens.live(auth: $0, readingConsent: .allowedForTests(), withKeys: false) }
        if startEvents { await auth.start() }
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        let original = try await RecoveryLoadedGeneration(auth: auth)
        let stamp = try require_(auth.session.stamp())
        let row = try KeyGeneration.generate(master: PW.master(email: FakeSupabase.email, password: Self.oldPassword), userID: FakeSupabase.me).row
        let stored = StoredKeyRow(keyId: row.keyID, publicKey: row.publicKey, wrappedPrivateKey: row.wrappedPrivateKey, wrapIv: row.wrapIv, kdfSalt: row.kdfSalt, kdfIterations: row.kdfIterations)
        let api = RecoveryRewrapProbe(), completion = RecoveryCompletionProbe()
        let model = PasswordRecoveryModel(
            keys: PasswordKeys(row: stored), api: api, deriver: auth.deriver,
            identity: {
                guard case let .signedIn(id) = auth.state, let email = auth.signedInEmail else { return nil }
                return (id, email)
            },
            isCurrent: { auth.session.isCurrent(stamp) },
            authenticate: { secret, captcha throws(LoginFailure) in try await auth.authenticateForKeyRecovery(authSecret: secret, captchaToken: captcha) },
            complete: { _ in completion.calls += 1; return true }
        )
        model.current = PW.good; model.other = Self.oldPassword
        model.turnstile.receive(.token("recovery-captcha"), generation: 0)
        self.fake = fake; self.storage = storage; self.auth = auth; self.original = original
        self.api = api; self.completion = completion; self.model = model
    }

    func storedSession() throws -> Data? { try storage.retrieve(key: SupabaseProvider.storageKey(for: fake.config)) }

    func fillPasswords() {
        model.current = PW.good; model.other = Self.oldPassword
        model.turnstile.receive(.token("recovery-captcha"), generation: model.turnstile.generation)
    }
}
