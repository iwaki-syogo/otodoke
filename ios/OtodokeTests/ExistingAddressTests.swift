import Foundation
import Testing
@testable import Otodoke

/// [existing address] Supabase answers a sign-up for a registered address with "sent" and sets no new password. The
/// waiting screen's sign-in (by itself or by the button) is then refused for credentials: the sign-in form comes
/// back with the address kept and a sentence that says the address is registered, the link to the reset and
/// RESET_LOSES_MAIL. Every other credentials answer keeps the Web's 「メールアドレスかパスワードが違います。」.
@Suite("Onboarding: the address was already registered")
@MainActor
struct ExistingAddressTests {
    private let clock = TestClock(Date(timeIntervalSince1970: 1_793_000_000))

    /// Held by the suite value so the fake server outlives the whole test (its stub goes with it).
    private let fake = FakeSupabase.make()

    private func make(
        _ fake: FakeSupabase, token: TurnstileToken? = nil,
        timerSleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> LoginModel {
        let auth = PW.auth(fake, storage: InMemorySessionStorage())
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: []), now: clock.function, turnstile: token, tokenWait: .milliseconds(100), timerSleep: timerSleep)
        model.email = FakeSupabase.email
        return model
    }

    /// A model that made an account and waits, for an address that already had one with another password.
    private func waitingOnRegisteredAddress() async -> (LoginModel, FakeSupabase) {
        let model = make(fake)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        return (model, fake)
    }

    private func expectExistingAddress(_ model: LoginModel) {
        #expect(!model.isWaitingForConfirmation)
        #expect(model.mode == .signIn)
        #expect(model.email == FakeSupabase.email)
        #expect(model.password.isEmpty)
        #expect(model.isExistingAddress)
        #expect(model.errorMessage == nil)
        #expect(model.notice == nil)
        #expect(model.shownNotice == nil)
        #expect(!model.isHoldingPassword)
    }

    /// A fixed copy only; the words' source of truth is the Web's EXISTING_ACCOUNT_NOTICE and RESET_LOSES_MAIL,
    /// compared by src/lib/__tests__/ios-onboarding.test.ts.
    @Test func theWordsAreTheWebs() {
        #expect(OnboardingText.existingAddress == "このアドレスは、もう登録されています。前に決めたパスワードでログインしてください。")
        #expect(OnboardingText.resetLosesMail == "パスワードを決め直すと、前に暗号化して保存したメールは開けなくなります。荷物は残ります。")
    }

    @Test func aTryByItselfRefusedForCredentialsSaysTheAddressIsRegistered() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        expectExistingAddress(model)
    }

    @Test func thePressedButtonSaysTheSame() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation(pressed: true)
        expectExistingAddress(model)
    }

    @Test func anOrdinarySignInWithAWrongPasswordKeepsTheWebsWords() async {
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        let model = make(fake)
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == LoginText.credentials)
        #expect(!model.isExistingAddress)
    }

    @Test func aSignInPressedAfterTheGuidanceClearsItAndSaysTheOrdinaryWords() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        #expect(model.isExistingAddress)
        model.password = PW.good
        await model.submit()
        #expect(!model.isExistingAddress)
        #expect(model.errorMessage == LoginText.credentials)
    }

    @Test func changingTheAddressClearsIt() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        // The same address in other letters or with spaces is the same address.
        model.email = "  " + FakeSupabase.email.uppercased() + " "
        #expect(model.isExistingAddress)
        model.email = "other@example.com"
        #expect(!model.isExistingAddress)
    }

    @Test func switchingTheFormClearsIt() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        model.setMode(.signUp)
        #expect(!model.isExistingAddress)
    }

    @Test func startingOverClearsIt() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        model.startOver()
        #expect(!model.isExistingAddress)
    }

    @Test func leavingTheScreenClearsIt() async {
        let (model, _) = await waitingOnRegisteredAddress()
        await model.checkConfirmation()
        model.leaveWait()
        #expect(!model.isExistingAddress)
    }

    /// Waiting with a widget: a try by itself is refused for its token (captcha), tried once more with the token the
    /// widget renewed meanwhile, and that one is refused for credentials.
    private func captchaThenCredentials(
        token: TurnstileToken, start: @escaping @MainActor () async -> Void, model: LoginModel
    ) async {
        let task = Task { await start() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        token.receive(.token("tok-2"), generation: token.generation)
        // The first answer is already the captcha refusal (.delay computes it first); the one more try meets the fake's own answer (credentials).
        await fake.clearForcedAuth("password")
        gate.open()
        await task.value
        _ = await waitFor(.seconds(3)) { await MainActor.run { !model.isWaitingForConfirmation } }
        // Two sends: the refused one, and the one more try that was answered for credentials.
        #expect(await fake.count("POST", "token") == 2)
        #expect(await fake.requests("POST", "token").map { PW.captcha($0) } == ["tok-1", "tok-2"])
    }

    private let gate = Gate()

    @Test func aTokenTryRefusedForItsTokenThenForCredentialsSaysTheAddressIsRegistered() async {
        let token = TurnstileToken(now: clock.function)
        let model = make(fake, token: token)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        await fake.fail("POST", "token", with: .delay(gate))
        clock.advance(seconds: 21)
        token.receive(.token("tok-1"), generation: token.generation)
        await captchaThenCredentials(token: token, start: { await model.tokenArrived() }, model: model)
        expectExistingAddress(model)
    }

    @Test func aTimedTryRefusedForItsTokenThenForCredentialsSaysTheAddressIsRegistered() async {
        let token = TurnstileToken(now: clock.function)
        let sleeper = ControlledSleeper()
        let model = make(fake, token: token, timerSleep: sleeper.sleep)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        await fake.fail("POST", "token", with: .delay(gate))
        token.receive(.token("tok-1"), generation: token.generation)
        clock.advance(seconds: 20)
        await captchaThenCredentials(token: token, start: { _ = sleeper.fireOldest() }, model: model)
        expectExistingAddress(model)
    }

    // MARK: negative controls: only a credentials refusal of the wait says it

    private func waitingWithWidget(confirmed: Bool?) async -> (LoginModel, TurnstileToken) {
        let token = TurnstileToken(now: clock.function)
        let model = make(fake, token: token)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        if let confirmed {
            await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good), confirmed: confirmed)
        }
        return (model, token)
    }

    @Test func notConfirmedDoesNotSayIt() async {
        let (model, token) = await waitingWithWidget(confirmed: false)
        token.receive(.token("tok-1"), generation: token.generation)
        await model.checkConfirmation(pressed: true)
        #expect(!model.isExistingAddress)
        #expect(model.isWaitingForConfirmation)
        clock.advance(seconds: 21)
        token.receive(.token("tok-2"), generation: token.generation)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
        #expect(!model.isExistingAddress)
        #expect(model.isWaitingForConfirmation)
    }

    @Test func aCaptchaRefusalOfAPressDoesNotSayIt() async {
        let (model, token) = await waitingWithWidget(confirmed: nil)
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        token.receive(.token("tok-1"), generation: token.generation)
        await model.checkConfirmation(pressed: true)
        #expect(!model.isExistingAddress)
        #expect(model.isWaitingForConfirmation)
        #expect(model.errorMessage == LoginText.captcha)
    }

    @Test func aCaptchaRefusalOfATryByItselfDoesNotSayIt() async {
        let (model, token) = await waitingWithWidget(confirmed: nil)
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        token.receive(.token("tok-1"), generation: token.generation)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        #expect(!model.isExistingAddress)
        #expect(model.isWaitingForConfirmation)
        #expect(model.errorMessage == nil)
    }

    @Test func otherRefusalsOfTheWaitDoNotSayIt() async {
        let model = make(fake)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        await model.checkConfirmation(pressed: true)
        #expect(!model.isExistingAddress)
        #expect(model.isWaitingForConfirmation)
    }
}
