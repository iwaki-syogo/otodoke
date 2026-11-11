import Foundation
import Testing
@testable import Otodoke

actor PasswordStub: PasswordAccountAPI {
    var changes: [PasswordChangeInput] = []
    var wraps: [PasswordRewrap] = []
    var code: String?
    func setCode(_ code: String?) { self.code = code }
    func change(_ input: PasswordChangeInput, accessToken: String) async -> String? { changes.append(input); return code }
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

    private func makeModel(_ row: StoredKeyRow?, api: PasswordStub) -> PasswordChangeModel {
        let model = PasswordChangeModel(keys: PasswordKeys(row: row), api: api, deriver: deriver, identity: { [user, email] in (user, email) }, accessToken: { "test-token" }, signOut: {})
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
}
