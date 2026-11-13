import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 2; password-v1] The login screen with Turnstile, as the Web's login (submit-button.tsx,
/// login-errors.ts of integrate/password-v1): a press takes the token (each token is sent once), waits up to 10
/// seconds for one when there is none (not when the widget could not load), never sends twice at once, resets
/// the widget after every press, and a refused captcha has the Web's one sentence. The press is the password
/// sign-in now (the 8-digit code is gone). Everything stays in FakeSupabase.
@Suite("Login with Turnstile (batch 2, task 2)")
@MainActor
struct LoginTurnstileTests {
    /// LOGIN_MESSAGES.captcha (the Web now has one sentence for a refused check, with or without a token).
    static let captcha = "確認が切れました。もう一度お試しください。"

    private let start = Date(timeIntervalSince1970: 1_793_000_000)

    private func make(_ fake: FakeSupabase, wait: Duration = .milliseconds(300), clock: TestClock? = nil) -> (LoginModel, TurnstileToken) {
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()), deriver: PW.fastDeriver(), userDefaults: TestDefaults.fresh())
        let token = TurnstileToken()
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: ["Otodoke"]), now: (clock ?? TestClock(start)).function, turnstile: token, tokenWait: wait)
        model.email = FakeSupabase.email
        model.password = PW.good
        return (model, token)
    }

    private func account(_ fake: FakeSupabase) async {
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
    }

    /// gotrue_meta_security.captcha_token of the nth password sign-in (1-based); nil when absent.
    private func sentToken(_ fake: FakeSupabase, _ nth: Int = 1) async -> String? {
        let sent = await fake.requests("POST", "token")
        guard sent.count >= nth else { return nil }
        return PW.captcha(sent[nth - 1])
    }

    // MARK: the words

    @Test func theCaptchaWordsAreTheWebs() {
        #expect(LoginText.captcha == Self.captcha)
        #expect(LoginFailure.captcha.message == Self.captcha)
    }

    // MARK: AuthService

    @Test func theTokenGoesInGotrueMetaSecurity() async throws {
        let fake = FakeSupabase.make()
        await account(fake)
        let auth = PW.auth(fake)
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: "tok-1")
        #expect(await sentToken(fake) == "tok-1")
        let body = await fake.requests("POST", "token").first?.jsonDictionary
        #expect(body?["email"] as? String == FakeSupabase.email)
    }

    @Test func noTokenSendsNoCaptchaField() async throws {
        let fake = FakeSupabase.make()
        await account(fake)
        let auth = PW.auth(fake)
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        #expect(await fake.count("POST", "token") == 1)
        #expect(await sentToken(fake) == nil)
    }

    @Test func aRefusedCaptchaIsToldByWhetherATokenWasSent() async {
        // password-v1: the Web's one word for captcha_failed, whether this press sent a token or not.
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.captcha) { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
        await #expect(throws: LoginFailure.captcha) { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: "tok") }
    }

    @Test func aFailedCheckAtCloudflareStaysASendFailure() async {
        // GoTrue answers 500 without a code when the check itself failed: an outage (the network words), sent once.
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: 500, code: nil)
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.network) { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: "tok") }
        #expect(await fake.count("POST", "token") == 1)
    }

    // MARK: LoginModel: the token at a press

    @Test func aPressTakesTheTokenAndResetsTheWidget() async {
        let fake = FakeSupabase.make()
        await account(fake)
        let (model, token) = make(fake)
        token.receive(.token("tok-1"), generation: 0)
        await model.submit()
        #expect(await sentToken(fake) == "tok-1")
        #expect(model.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(token.hasToken == false)
        #expect(token.resetCount == 1)
        #expect(token.generation == 1)
    }

    @Test func theSameTokenIsNeverSentTwice() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .milliseconds(100))
        token.receive(.token("tok-1"), generation: 0)
        await model.submit()
        model.password = PW.good
        await model.submit()
        #expect(await fake.count("POST", "token") == 2)
        #expect(await sentToken(fake, 1) == "tok-1")
        #expect(await sentToken(fake, 2) == nil)
        #expect(token.resetCount == 2)
    }

    @Test func aFailedSendAlsoResetsTheWidget() async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        let (model, token) = make(fake)
        token.receive(.token("tok-1"), generation: 0)
        await model.submit()
        #expect(model.errorMessage == LoginText.rate)
        #expect(token.hasToken == false)
        #expect(token.resetCount == 1)
    }

    @Test func aPressWaitsForTheTokenWithTheSpinner() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .seconds(5))
        let press = Task { await model.submit() }
        #expect(await waitFor { await MainActor.run { model.isWorking } })
        try? await Task.sleep(for: .milliseconds(100))
        #expect(await fake.count("POST", "token") == 0)
        token.receive(.token("late-tok"), generation: 0)
        await press.value
        #expect(await fake.count("POST", "token") == 1)
        #expect(await sentToken(fake) == "late-tok")
        #expect(model.isWorking == false)
    }

    @Test func withoutATokenItSendsAfterTheWait() async {
        let fake = FakeSupabase.make()
        await account(fake)
        let (model, _) = make(fake, wait: .milliseconds(200))
        let clock = ContinuousClock()
        let started = clock.now
        await model.submit()
        #expect(clock.now - started >= .milliseconds(150))
        #expect(await fake.count("POST", "token") == 1)
        #expect(await sentToken(fake) == nil)
        // CAPTCHA is off today: the sign-in goes through without a token.
        #expect(model.auth.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test func anUnavailableWidgetSendsAtOnce() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .seconds(30))
        token.receive(.unavailable, generation: 0)
        let clock = ContinuousClock()
        let started = clock.now
        await model.submit()
        #expect(clock.now - started < .seconds(5))
        #expect(await fake.count("POST", "token") == 1)
        #expect(await sentToken(fake) == nil)
    }

    @Test func aSecondPressWhileWaitingSendsNothing() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .seconds(5))
        let first = Task { await model.submit() }
        #expect(await waitFor { await MainActor.run { model.isWorking } })
        await model.submit()
        token.receive(.token("tok"), generation: 0)
        await first.value
        #expect(await fake.count("POST", "token") == 1)
    }

    @Test func aSecondPressWhileTheSignInIsOnTheWaySendsNothing() async {
        let fake = FakeSupabase.make()
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        let (model, token) = make(fake)
        token.receive(.token("tok"), generation: 0)
        let first = Task { await model.submit() }
        #expect(await waitFor { await fake.count("POST", "token") == 1 })
        await model.submit()
        gate.open()
        await first.value
        #expect(await fake.count("POST", "token") == 1)
    }

    @Test func aTokenOfAnOldWidgetIsNotSent() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .milliseconds(100))
        token.reset()
        token.receive(.token("old"), generation: 0)
        await model.submit()
        #expect(await sentToken(fake) == nil)
    }

    @Test func anExpiredTokenIsNotSent() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .milliseconds(100))
        token.receive(.token("tok"), generation: 0)
        token.receive(.expired, generation: 0)
        await model.submit()
        #expect(await sentToken(fake) == nil)
    }

    @Test func aRefusedCaptchaWithoutATokenSaysTheCheckDidNotFinish() async {
        // password-v1: the Web's one sentence (captcha), also without a token.
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        let (model, token) = make(fake, wait: .seconds(30))
        token.receive(.unavailable, generation: 0)
        await model.submit()
        #expect(model.errorMessage == Self.captcha)
        #expect(model.mode == .signIn)
    }

    @Test func aRefusedCaptchaWithATokenSaysItExpired() async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        let (model, token) = make(fake)
        token.receive(.token("tok"), generation: 0)
        await model.submit()
        #expect(model.errorMessage == Self.captcha)
        #expect(token.hasToken == false)
        #expect(token.resetCount == 1)
    }
}
