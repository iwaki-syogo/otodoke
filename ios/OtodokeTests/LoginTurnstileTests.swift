import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 2] The login screen with Turnstile, as the Web's login of 2541793 (submit-button.tsx,
/// login-errors.ts): a press takes the token (each token is sent once), waits up to 10 seconds for one
/// when there is none (not when the widget could not load), never sends twice at once, resets the
/// widget after every send, and words a refused captcha by whether this press sent a token.
/// iOS-11: the code field is read through NFKC (full-width digits pass). Everything stays in FakeSupabase.
@Suite("Login with Turnstile (batch 2, task 2)")
@MainActor
struct LoginTurnstileTests {
    static let missing = "確認が終わりませんでした。ページを読み込み直すか、別のブラウザでお試しください。"
    /// captcha_refused: the Web's 「リンク」 said as 「コード」 on iOS (the owner's decision, 11/6).
    static let refused = "確認が切れました。もう一度コードを送ってください。"

    private let start = Date(timeIntervalSince1970: 1_793_000_000)

    private func make(_ fake: FakeSupabase, wait: Duration = .milliseconds(300), clock: TestClock? = nil) -> (LoginModel, TurnstileToken) {
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()))
        let token = TurnstileToken()
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: ["Otodoke"]), now: (clock ?? TestClock(start)).function, turnstile: token, tokenWait: wait)
        model.email = FakeSupabase.email
        return (model, token)
    }

    /// gotrue_meta_security.captcha_token of the nth OTP request (1-based); nil when absent.
    private func sentToken(_ fake: FakeSupabase, _ nth: Int = 1) async -> String? {
        let otp = await fake.requests("POST", "otp")
        guard otp.count >= nth else { return nil }
        let security = otp[nth - 1].jsonDictionary?["gotrue_meta_security"] as? [String: Any]
        return security?["captcha_token"] as? String
    }

    // MARK: the words

    @Test func theCaptchaWordsAreTheWebs() {
        #expect(CaptchaText.missing == Self.missing)
        #expect(CaptchaText.refused == Self.refused)
        #expect(LoginError.captchaMissing.message == Self.missing)
        #expect(LoginError.captchaRefused.message == Self.refused)
    }

    // MARK: AuthService

    @Test func theTokenGoesInGotrueMetaSecurity() async throws {
        let fake = FakeSupabase.make()
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()))
        try await auth.sendCode(email: FakeSupabase.email, captchaToken: "tok-1")
        #expect(await sentToken(fake) == "tok-1")
        let body = await fake.requests("POST", "otp").first?.jsonDictionary
        #expect(body?["email"] as? String == FakeSupabase.email)
    }

    @Test func noTokenSendsNoCaptchaField() async throws {
        let fake = FakeSupabase.make()
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()))
        try await auth.sendCode(email: FakeSupabase.email, captchaToken: nil)
        #expect(await fake.count("POST", "otp") == 1)
        #expect(await sentToken(fake) == nil)
    }

    @Test func aRefusedCaptchaIsToldByWhetherATokenWasSent() async {
        let fake = FakeSupabase.make()
        await fake.setOTP(.captchaFailed)
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()))
        do {
            try await auth.sendCode(email: FakeSupabase.email, captchaToken: nil)
            Issue.record("expected captchaMissing")
        } catch {
            #expect(error == .captchaMissing)
        }
        do {
            try await auth.sendCode(email: FakeSupabase.email, captchaToken: "tok")
            Issue.record("expected captchaRefused")
        } catch {
            #expect(error == .captchaRefused)
        }
    }

    @Test func aFailedCheckAtCloudflareStaysASendFailure() async {
        let fake = FakeSupabase.make()
        await fake.setOTP(.cloudflareDown)
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()))
        do {
            try await auth.sendCode(email: FakeSupabase.email, captchaToken: "tok")
            Issue.record("expected a failure")
        } catch {
            #expect(error == .other)
        }
        // Sent once (a 500 on the code is never retried).
        #expect(await fake.count("POST", "otp") == 1)
    }

    // MARK: LoginModel: the token at a press

    @Test func aPressTakesTheTokenAndResetsTheWidget() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake)
        token.receive(.token("tok-1"), generation: 0)
        await model.sendCode()
        #expect(await sentToken(fake) == "tok-1")
        #expect(model.step == .code(email: FakeSupabase.email))
        #expect(token.hasToken == false)
        #expect(token.resetCount == 1)
        #expect(token.generation == 1)
    }

    @Test func theSameTokenIsNeverSentTwice() async {
        let fake = FakeSupabase.make()
        let clock = TestClock(start)
        let (model, token) = make(fake, wait: .milliseconds(100), clock: clock)
        token.receive(.token("tok-1"), generation: 0)
        await model.sendCode()
        clock.advance(seconds: 61)
        await model.resend()
        #expect(await fake.count("POST", "otp") == 2)
        #expect(await sentToken(fake, 1) == "tok-1")
        #expect(await sentToken(fake, 2) == nil)
        #expect(token.resetCount == 2)
    }

    @Test func aFailedSendAlsoResetsTheWidget() async {
        let fake = FakeSupabase.make()
        await fake.setOTP(.rateLimited)
        let (model, token) = make(fake)
        token.receive(.token("tok-1"), generation: 0)
        await model.sendCode()
        #expect(model.errorMessage == "しばらく待ってから、もう一度お試しください")
        #expect(token.hasToken == false)
        #expect(token.resetCount == 1)
    }

    @Test func aPressWaitsForTheTokenWithTheSpinner() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .seconds(5))
        let press = Task { await model.sendCode() }
        #expect(await waitFor { await MainActor.run { model.isWorking } })
        try? await Task.sleep(for: .milliseconds(100))
        #expect(await fake.count("POST", "otp") == 0)
        token.receive(.token("late-tok"), generation: 0)
        await press.value
        #expect(await fake.count("POST", "otp") == 1)
        #expect(await sentToken(fake) == "late-tok")
        #expect(model.isWorking == false)
    }

    @Test func withoutATokenItSendsAfterTheWait() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake, wait: .milliseconds(200))
        let clock = ContinuousClock()
        let started = clock.now
        await model.sendCode()
        #expect(clock.now - started >= .milliseconds(150))
        #expect(await fake.count("POST", "otp") == 1)
        #expect(await sentToken(fake) == nil)
        // CAPTCHA is off today: the code is sent and asked for.
        #expect(model.step == .code(email: FakeSupabase.email))
    }

    @Test func anUnavailableWidgetSendsAtOnce() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .seconds(30))
        token.receive(.unavailable, generation: 0)
        let clock = ContinuousClock()
        let started = clock.now
        await model.sendCode()
        #expect(clock.now - started < .seconds(5))
        #expect(await fake.count("POST", "otp") == 1)
        #expect(await sentToken(fake) == nil)
    }

    @Test func aSecondPressWhileWaitingSendsNothing() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .seconds(5))
        let first = Task { await model.sendCode() }
        #expect(await waitFor { await MainActor.run { model.isWorking } })
        await model.sendCode()
        token.receive(.token("tok"), generation: 0)
        await first.value
        #expect(await fake.count("POST", "otp") == 1)
    }

    @Test func aSecondPressWhileTheCodeIsOnTheWaySendsNothing() async {
        let fake = FakeSupabase.make()
        let gate = Gate()
        await fake.fail("POST", "otp", with: .hold(gate))
        let (model, token) = make(fake)
        token.receive(.token("tok"), generation: 0)
        let first = Task { await model.sendCode() }
        #expect(await waitFor { await fake.count("POST", "otp") == 1 })
        await model.sendCode()
        gate.open()
        await first.value
        #expect(await fake.count("POST", "otp") == 1)
    }

    @Test func aTokenOfAnOldWidgetIsNotSent() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .milliseconds(100))
        token.reset()
        token.receive(.token("old"), generation: 0)
        await model.sendCode()
        #expect(await sentToken(fake) == nil)
    }

    @Test func anExpiredTokenIsNotSent() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake, wait: .milliseconds(100))
        token.receive(.token("tok"), generation: 0)
        token.receive(.expired, generation: 0)
        await model.sendCode()
        #expect(await sentToken(fake) == nil)
    }

    @Test func aRefusedCaptchaWithoutATokenSaysTheCheckDidNotFinish() async {
        let fake = FakeSupabase.make()
        await fake.setOTP(.captchaFailed)
        let (model, token) = make(fake, wait: .seconds(30))
        token.receive(.unavailable, generation: 0)
        await model.sendCode()
        #expect(model.errorMessage == Self.missing)
        #expect(model.step == .email)
    }

    @Test func aRefusedCaptchaWithATokenSaysItExpired() async {
        let fake = FakeSupabase.make()
        await fake.setOTP(.captchaFailed)
        let (model, token) = make(fake)
        token.receive(.token("tok"), generation: 0)
        await model.sendCode()
        #expect(model.errorMessage == Self.refused)
        #expect(token.hasToken == false)
        #expect(token.resetCount == 1)
    }

    // MARK: iOS-11: the code through NFKC

    @Test func fullWidthDigitsAreACode() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake)
        token.receive(.token("tok"), generation: 0)
        await model.sendCode()
        model.code = "１２３４５６７８"
        #expect(model.canVerify)
        await model.verify()
        #expect(model.errorMessage == nil)
        #expect(model.auth.state == .signedIn(userID: FakeSupabase.me))
        let verify = await fake.requests("POST", "verify").first
        #expect(verify?.jsonDictionary?["token"] as? String == FakeSupabase.goodCode)
    }

    @Test func mixedWidthDigitsAreACodeToo() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake)
        token.receive(.token("tok"), generation: 0)
        await model.sendCode()
        model.code = "1234５６７８"
        #expect(model.canVerify)
    }

    @Test func otherCharactersAreNotACode() async {
        let fake = FakeSupabase.make()
        let (model, token) = make(fake)
        token.receive(.token("tok"), generation: 0)
        await model.sendCode()
        for code in ["１２３４５６７", "１２３４５６７８９", "ＡＢＣＤ１２３４", "١٢٣٤٥٦٧٨", "1234 5678"] {
            model.code = code
            #expect(model.canVerify == false, "\(code)")
        }
    }
}
