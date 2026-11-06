import Foundation
import Testing
@testable import Otodoke

/// [password-login, the owner's decision 11/6 23:4x] When the key cannot be opened or was never made:
///  - the key in use does not open with the password that signed in (a password change on the Web stopped
///    half-way): KeySetup makes nothing and keeps nothing (.needsWebLogin); the unlock shows the Web's sentence
///    and the app's 「Web でログインしてください。」 (LoginText.keyNeedsWebLogin) with 「Web でログイン」, a button that opens https://otodoke.app/login in Safari. No other password
///    is asked for, and nothing is rewrapped or restored.
///  - no key row (the key step did not finish): the unlock says so (LoginText.noKeyYet) with 「ログインし直す」
///    (sign out, then the login screen), instead of 「読み込めませんでした」, which stays for a read that failed.
@Suite("Password login: when the key does not open or was never made (password-login)")
@MainActor
struct KeyHelpTests {
    // MARK: the words

    @Test func theWordsAndTheWebsLoginPage() {
        // The Web's sentence (to be in LOGIN_MESSAGES under a key not named yet), then the app's own.
        #expect(LoginText.keyDoesNotOpen == "このパスワードでは、メールの鍵を開けませんでした。")
        #expect(LoginText.webLoginPrompt == "Web でログインしてください。")
        #expect(LoginText.keyNeedsWebLogin == "このパスワードでは、メールの鍵を開けませんでした。Web でログインしてください。")
        #expect(LoginText.openWebLogin == "Web でログイン")
        #expect(LoginText.noKeyYet == "メールの鍵がまだできていません。ログインし直すと作れます。")
        #expect(LoginText.signInAgain == "ログインし直す")
        #expect(LoginText.webLoginURL == URL(string: "https://otodoke.app/login"))
        #expect(LoginText.webLoginURL.scheme == "https")
    }

    // MARK: KeySetup

    @Test func aKeyInUseThatDoesNotOpenAsksForTheWebsLogin() async throws {
        let w = try await KeySetupTests.World()
        _ = try await w.plantKeyInUse(master: Data(repeating: 9, count: 32))
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .needsWebLogin)
        #expect(w.setup.lastOutcome == .needsWebLogin)
        #expect(await w.server.requests.isEmpty)
        #expect(w.store.key == nil)
        #expect(w.vaultCount == 0)
    }

    @Test func anotherDevicesKeyThatDoesNotOpenAsksForTheWebsLoginToo() async throws {
        let w = try await KeySetupTests.World()
        let other = try KeyGeneration.generate(master: Data(repeating: 9, count: 32), userID: FakeSupabase.me).row
        let fake = w.fake
        await w.server.before("register") {
            await fake.insert("user_keys", [[
                "user_id": .string(FakeSupabase.me), "key_id": .string(other.keyID), "public_key": .string(other.publicKey),
                "wrapped_private_key": .string(other.wrappedPrivateKey), "wrap_iv": .string(other.wrapIv), "kdf_salt": .string(other.kdfSalt),
                "kdf_iterations": 600_000, "activated_at": "2026-11-06T00:00:00.000000+00:00", "retired_at": nil,
            ]])
        }
        let outcome = await w.setup.run(w.signIn)
        #expect(outcome == .needsWebLogin)
        #expect(await w.server.count("activate") == 0)
        #expect(w.store.key == nil)
    }

    // MARK: the unlock

    /// Negative control (the orchestrator's decision 11/6): a typed password that does not open is a typo as far as
    /// the unlock can tell: 「パスワードが違います」 only, never the Web's login.
    @Test func aPasswordThatDoesNotOpenOffersTheWebsLogin() async throws {
        let w = try UnlockWorld()
        _ = await w.model.key()
        #expect(await w.model.submit(password: "ちがうパスワードです", email: UnlockWorld.email) == false)
        #expect(w.model.message == UnlockModel.wrongPassphraseText)
        #expect(w.model.help == nil)
        #expect(w.model.shownHelp == nil)
    }

    /// The Web's login is offered only from the key step: the password that signed in was checked by the server,
    /// so a key it does not open is wrapped for another password. A typo afterwards does not take it away.
    @Test func onlyTheKeyStepOffersTheWebsLogin() async throws {
        let k = try await KeySetupTests.World()
        _ = try await k.plantKeyInUse(master: Data(repeating: 9, count: 32))
        #expect(await k.setup.run(k.signIn) == .needsWebLogin)
        let w = try UnlockWorld()
        w.model.keySetup = k.setup
        _ = await w.model.key()
        #expect(w.model.shownHelp == .webLogin)
        _ = await w.model.submit(password: "ちがうパスワードです", email: UnlockWorld.email)
        #expect(w.model.message == UnlockModel.wrongPassphraseText)
        #expect(w.model.shownHelp == .webLogin)
    }

    @Test func theRightPasswordClearsTheHelp() async throws {
        let w = try UnlockWorld()
        _ = await w.model.key()
        _ = await w.model.submit(password: "ちがうパスワードです", email: UnlockWorld.email)
        #expect(await w.model.submit(password: w.v.passphrase, email: UnlockWorld.email))
        #expect(w.model.help == nil)
        #expect(w.model.message == nil)
    }

    @Test func noKeyRowSaysSignInAgainAndRunsNoPBKDF2() async throws {
        let w = try UnlockWorld(key: .loaded(nil))
        #expect(await w.model.submit(password: w.v.passphrase, email: UnlockWorld.email) == false)
        #expect(w.model.message == LoginText.noKeyYet)
        #expect(w.model.help == .signInAgain)
        #expect(w.deriver.calls == 0)
        #expect(w.model.phase == .needsPassphrase)
    }

    @Test func aKeyRowThatCannotBeReadStaysReadFailed() async throws {
        let w = try UnlockWorld(key: .failed)
        #expect(await w.model.submit(password: w.v.passphrase, email: UnlockWorld.email) == false)
        #expect(w.model.message == UnlockModel.readFailedText)
        #expect(w.model.help == nil)
    }

    @Test func signInAgainSignsOut() async throws {
        let w = try UnlockWorld(key: .loaded(nil))
        let counter = SignOutCounter()
        w.model.signOut = { counter.n += 1 }
        await w.model.signInAgain()
        #expect(counter.n == 1)
    }

    @Test func theKeyStepsOutcomeReachesTheUnlock() async throws {
        let k = try await KeySetupTests.World()
        _ = try await k.plantKeyInUse(master: Data(repeating: 9, count: 32))
        await k.setup.run(k.signIn)
        let w = try UnlockWorld()
        #expect(w.model.shownHelp == nil)
        w.model.keySetup = k.setup
        #expect(w.model.shownHelp == .webLogin)
    }
}

@MainActor
final class SignOutCounter {
    var n = 0
}
