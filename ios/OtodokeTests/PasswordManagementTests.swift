import Foundation
import Testing
@testable import Otodoke

actor PasswordStub: PasswordAccountAPI {
    var changes: [PasswordChangeInput] = []
    var wraps: [PasswordRewrap] = []
    var code: String?
    private var changeStarted: Gate?
    private var changeGate: Gate?
    func setCode(_ code: String?) { self.code = code }
    func holdChange(started: Gate, until gate: Gate) { changeStarted = started; changeGate = gate }
    func change(_ input: PasswordChangeInput, accessToken: String) async -> String? {
        changes.append(input)
        let answer = code
        changeStarted?.open()
        if let changeGate { await changeGate.wait() }
        return answer
    }
    func rewrap(_ input: PasswordRewrap, accessToken: String) async -> String? { wraps.append(input); return code }
}

struct PasswordKeys: MailKeyReading {
    let row: StoredKeyRow?
    func currentKey() async -> LoadResult<StoredKeyRow?> { .loaded(row) }
    func envelope(emailID: String) async -> LoadResult<Data?> { .loaded(nil) }
}

@Suite("Native password management")
@MainActor
struct PasswordManagementTests {
    private let user = "00000000-0000-4000-8000-000000000001"
    private let email = "sample@example.invalid"
    private let current = "A quiet river in autumn"
    private let next = "A bright lake in spring"
    private var deriver: PasswordV1Deriver {
        PasswordV1Deriver(kdf: { password, _, _ in CryptoBytes.sha256(password) })
    }

    private func stored(_ master: Data) throws -> StoredKeyRow {
        let row = try KeyGeneration.generate(master: master, userID: user).row
        return StoredKeyRow(keyId: row.keyID, publicKey: row.publicKey, wrappedPrivateKey: row.wrappedPrivateKey, wrapIv: row.wrapIv, kdfSalt: row.kdfSalt, kdfIterations: row.kdfIterations)
    }

    private func makeModel(_ row: StoredKeyRow?, api: PasswordStub, signOut: @escaping @MainActor () async -> Void = {}) -> PasswordChangeModel {
        let model = PasswordChangeModel(keys: PasswordKeys(row: row), api: api, deriver: deriver, identity: { [user, email] in (user, email) }, accessToken: { "test-token" }, signOut: signOut)
        model.current = current; model.next = next; model.again = next
        model.turnstile.receive(.token("test-captcha"), generation: 0)
        return model
    }

    @Test func changingKeepsTheSameKeyAndOpensTheNewWrapBeforeSending() async throws {
        let old = try await deriver.master(password: current, email: email)
        let new = try await deriver.master(password: next, email: email)
        let row = try stored(old)
        let api = PasswordStub(), model = makeModel(row, api: api)
        await model.submit()
        let input = try #require(await api.changes.first)
        let wrap = try #require(input.rewrap)
        #expect(wrap.keyId == row.keyId)
        #expect(wrap.previousWrappedPrivateKey == row.wrappedPrivateKey)
        #expect(wrap.kdfSalt != row.kdfSalt); #expect(wrap.wrapIv != row.wrapIv)
        let changed = StoredKeyRow(keyId: row.keyId, publicKey: row.publicKey, wrappedPrivateKey: wrap.wrappedPrivateKey, wrapIv: wrap.wrapIv, kdfSalt: wrap.kdfSalt, kdfIterations: wrap.kdfIterations)
        let after = try PasswordV1.openStoredKey(changed, master: new, userID: user)
        let before = try PasswordV1.openStoredKey(row, master: old, userID: user)
        #expect(after.privateKey.rawRepresentation == before.privateKey.rawRepresentation)
        #expect(throws: CryptoError.wrongPassword) { try PasswordV1.openStoredKey(changed, master: old, userID: user) }
        #expect(input.currentAuthSecret == PasswordV1.authSecret(master: old))
        #expect(input.newAuthSecret == PasswordV1.authSecret(master: new))
        #expect(input.captchaToken == "test-captcha")
        #expect(model.current.isEmpty && model.next.isEmpty && model.again.isEmpty)
        #expect(model.succeeded && model.message == PasswordChangeText.changed)
    }

    @Test func wrongPasswordSendsNothingAndAnUncertainPreviousChangeCanBeReconciled() async throws {
        let row = try stored(Data(repeating: 7, count: 32))
        let api = PasswordStub(), wrong = makeModel(row, api: api)
        await wrong.submit()
        #expect(await api.changes.isEmpty)
        #expect(wrong.message == PasswordChangeText.wrongCurrent)
        let new = try await deriver.master(password: next, email: email)
        let retry = makeModel(try stored(new), api: api)
        await retry.submit()
        #expect(await api.changes.count == 1)
        #expect(retry.succeeded)
    }

    @Test func definiteFailureKeepsFieldsForRecoveryAndUnknownClearsThem() async {
        let api = PasswordStub(), model = makeModel(nil, api: api)
        await api.setCode("secret_change_refused_key_new")
        await model.submit()
        #expect(!model.succeeded && !model.current.isEmpty)
        #expect(model.message == PasswordChangeText.refusedKeyNew)
        model.turnstile.receive(.token("next-captcha"), generation: model.turnstile.generation)
        await api.setCode("secret_change_unknown")
        await model.submit()
        #expect(model.current.isEmpty && model.next.isEmpty && model.again.isEmpty)
        #expect(model.message == PasswordChangeText.unknown && model.offersSignIn)
    }

    @Test(arguments: ["success", "secret_change_unknown"])
    func aFinishedChangeAutomaticallySignsOutOnceAndClearsEveryPassword(_ outcome: String) async {
        let api = PasswordStub(), started = Gate(), release = Gate()
        await api.setCode(outcome == "success" ? nil : outcome)
        await api.holdChange(started: started, until: release)
        var signOuts = 0
        let model = makeModel(nil, api: api, signOut: { signOuts += 1 })
        let run = Task { await model.submit() }
        await started.wait()
        #expect(model.isWorking)
        #expect(signOuts == 0)
        #expect(model.current == current && model.next == next && model.again == next)

        release.open()
        await run.value

        #expect(signOuts == 1)
        #expect(model.current.isEmpty && model.next.isEmpty && model.again.isEmpty)
        #expect(model.succeeded == (outcome == "success"))
        #expect(model.message == (outcome == "success" ? PasswordChangeText.changed : PasswordChangeText.unknown))
        #expect(!model.isWorking)
        #expect(await api.changes.count == 1)
    }

    @Test(arguments: ["secret_change_refused", "secret_change_refused_key_new", "credentials", "wrong_current_password", "network", "unavailable", "rate", "captcha"])
    func aDefiniteChangeFailurePreservesTheSessionAndTheInputs(_ code: String) async {
        let api = PasswordStub()
        await api.setCode(code)
        var signOuts = 0
        let model = makeModel(nil, api: api, signOut: { signOuts += 1 })

        await model.submit()

        #expect(signOuts == 0)
        #expect(model.current == current && model.next == next && model.again == next)
        #expect(!model.succeeded && !model.offersSignIn)
        #expect(model.message == PasswordChangeText.message(code))
        #expect(!model.isWorking)
        #expect(await api.changes.count == 1)
    }

    @Test(arguments: ["success", "secret_change_unknown"], ["another-account", "new-generation"])
    func aLateChangeAnswerNeverSignsOutANewerIdentity(_ outcome: String, _ transition: String) async {
        let api = PasswordStub(), started = Gate(), release = Gate()
        await api.setCode(outcome == "success" ? nil : outcome)
        await api.holdChange(started: started, until: release)
        var identityID = user, currentGeneration = true, signOuts = 0
        let model = PasswordChangeModel(
            keys: PasswordKeys(row: nil), api: api, deriver: deriver,
            identity: { [email] in (identityID, email) }, isCurrent: { currentGeneration },
            accessToken: { "test-token" }, signOut: { signOuts += 1 }
        )
        model.current = current; model.next = next; model.again = next
        model.turnstile.receive(.token("test-captcha"), generation: 0)
        let run = Task { await model.submit() }
        await started.wait()
        #expect(model.isWorking && signOuts == 0)

        if transition == "another-account" { identityID = FakeSupabase.other }
        else { currentGeneration = false }
        release.open()
        await run.value

        #expect(signOuts == 0)
        #expect(!model.succeeded && !model.offersSignIn)
        #expect(model.message == nil)
        #expect(!model.isWorking)
        #expect(await api.changes.count == 1)
    }

    @Test(arguments: ["weak", "mismatch", "same"])
    func changeInputErrorAfterASuccessDoesNotKeepSuccess(_ secondInput: String) async {
        let api = PasswordStub(), model = makeModel(nil, api: api)
        await model.submit()
        #expect(model.succeeded && model.offersSignIn)
        #expect(model.message == PasswordChangeText.changed)
        #expect(await api.changes.count == 1)

        // Refill the current password so the second press reaches input validation on the same model.
        model.current = current
        let expected: String
        switch secondInput {
        case "weak":
            model.next = "password123"; model.again = model.next
            expected = LoginText.passwordWeak
        case "mismatch":
            model.next = next; model.again = next + "different"
            expected = LoginText.passwordMismatch
        default:
            model.next = current; model.again = current
            expected = PasswordChangeText.same
        }
        await model.submit()

        #expect(!model.succeeded)
        #expect(!model.offersSignIn)
        #expect(model.message == expected)
        #expect(await api.changes.count == 1)
        #expect(!model.isWorking)
    }

    @Test func recoveryWrapsTheExistingKeyForTheCurrentLoginWithoutChangingAuth() async throws {
        let login = try await deriver.master(password: current, email: email)
        let other = try await deriver.master(password: next, email: email)
        let row = try stored(other)
        let api = PasswordStub()
        var checked = false, completed = false
        let model = PasswordRecoveryModel(keys: PasswordKeys(row: row), api: api, deriver: deriver, identity: { [user, email] in (user, email) }, isCurrent: { true }, authenticate: { secret, token throws(LoginFailure) in
            checked = secret == PasswordV1.authSecret(master: login) && token == "test-captcha"
            return "test-token"
        }, complete: { password in completed = password == current; return completed })
        model.current = current; model.other = next
        model.turnstile.receive(.token("test-captcha"), generation: 0)
        await model.submit()
        #expect(checked && completed && model.opened)
        #expect(await api.changes.isEmpty)
        let wrap = try #require(await api.wraps.first)
        #expect(wrap.keyId == row.keyId)
        let updated = StoredKeyRow(keyId: row.keyId, publicKey: row.publicKey, wrappedPrivateKey: wrap.wrappedPrivateKey, wrapIv: wrap.wrapIv, kdfSalt: wrap.kdfSalt, kdfIterations: wrap.kdfIterations)
        #expect(try PasswordV1.openStoredKey(updated, master: login, userID: user).keyID == row.keyId)
        #expect(model.current.isEmpty && model.other.isEmpty)
    }

    @Test(arguments: ["authentication", "rewrap"])
    func recoveryFailureAfterASuccessDoesNotKeepOpened(_ secondFailure: String) async throws {
        let otherMaster = try await deriver.master(password: next, email: email)
        let row = try stored(otherMaster)
        let api = PasswordStub()
        var authenticationCalls = 0
        var completeCalls = 0
        var refuseAuthentication = false
        let model = PasswordRecoveryModel(
            keys: PasswordKeys(row: row), api: api, deriver: deriver,
            identity: { [user, email] in (user, email) }, isCurrent: { true },
            authenticate: { (_: String, _: String?) async throws(LoginFailure) -> String in
                authenticationCalls += 1
                if refuseAuthentication { throw .credentials }
                return "test-token"
            },
            complete: { _ in completeCalls += 1; return true }
        )

        model.current = current; model.other = next
        model.turnstile.receive(.token("first-captcha"), generation: model.turnstile.generation)
        await model.submit()
        #expect(model.opened)
        #expect(model.message == nil)
        #expect(authenticationCalls == 1 && completeCalls == 1)
        #expect(await api.wraps.count == 1)

        // The same instance is kept when the sheet is opened again. A failed second attempt must
        // not make PasswordRecoveryView dismiss and call onOpened with the first attempt's flag.
        refuseAuthentication = secondFailure == "authentication"
        if secondFailure == "rewrap" { await api.setCode("key_wrap_changed") }
        model.current = current; model.other = next
        model.turnstile.receive(.token("second-captcha"), generation: model.turnstile.generation)
        await model.submit()

        #expect(!model.opened)
        #expect(model.message == (secondFailure == "authentication" ? LoginText.credentials : LoginText.keyWrapChanged))
        #expect(authenticationCalls == 2)
        #expect(completeCalls == 1)
        #expect(await api.wraps.count == (secondFailure == "authentication" ? 1 : 2))
        #expect(!model.isWorking)
        #expect(model.current.isEmpty && model.other.isEmpty)
    }
}
