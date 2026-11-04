import Foundation
import Testing
@testable import Otodoke

/// [Task 3] LoginView's model: e-mail → code, the error words, the 60-second wait, the spinner, and the
/// DEBUG-only start at code entry (used by UI tests, which must never send a login mail).
@Suite("LoginModel (task 3)")
@MainActor
struct LoginModelTests {
    private let start = Date(timeIntervalSince1970: 1_793_000_000)

    private func make(_ fake: FakeSupabase, launch: LaunchOptions = LaunchOptions(arguments: ["Otodoke"]), clock: TestClock? = nil) -> LoginModel {
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()))
        let clock = clock ?? TestClock(start)
        return LoginModel(auth: auth, launch: launch, now: clock.function)
    }

    @Test func beginsAtTheAddress() {
        let model = make(FakeSupabase.make())
        #expect(model.step == .email)
        #expect(model.errorMessage == nil)
        #expect(model.isWorking == false)
    }

    @Test func sendingMovesToTheCode() async {
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.email = " QA@example.com"
        await model.sendCode()
        #expect(model.step == .code(email: "qa@example.com"))
        #expect(model.errorMessage == nil)
        #expect(model.isWorking == false)
        #expect(await fake.count("POST", "otp") == 1)
    }

    @Test func anInvalidAddressSendsNothing() async {
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.email = "qa@"
        await model.sendCode()
        #expect(model.step == .email)
        #expect(model.errorMessage == "メールアドレスの形式を確認してください")
        #expect(await fake.count("POST", "otp") == 0)
    }

    @Test func showsTheSpinnerFromThePress() async {
        let fake = FakeSupabase.make()
        let gate = Gate()
        await fake.fail("POST", "otp", with: .hold(gate))
        let model = make(fake)
        model.email = FakeSupabase.email
        let task = Task { await model.sendCode() }
        #expect(await waitFor { await fake.count("POST", "otp") == 1 })
        #expect(model.isWorking == true)
        gate.open()
        await task.value
        #expect(model.isWorking == false)
    }

    @Test func aRateLimitIsShown() async {
        let fake = FakeSupabase.make()
        await fake.setOTP(.rateLimited)
        let model = make(fake)
        model.email = FakeSupabase.email
        await model.sendCode()
        #expect(model.errorMessage == "しばらく待ってから、もう一度お試しください")
        #expect(model.step == .email)
    }

    @Test func resendWaitsSixtySeconds() async {
        let fake = FakeSupabase.make()
        let clock = TestClock(start)
        let model = make(fake, clock: clock)
        model.email = FakeSupabase.email
        await model.sendCode()
        #expect(model.resendWaitSeconds() == 60)
        clock.advance(seconds: 10)
        #expect(model.resendWaitSeconds() == 50)
        clock.advance(seconds: 49.5)
        #expect(model.resendWaitSeconds() == 1)
        await model.resend()
        #expect(await fake.count("POST", "otp") == 1)
        clock.advance(seconds: 0.5)
        #expect(model.resendWaitSeconds() == 0)
        await model.resend()
        #expect(await fake.count("POST", "otp") == 2)
        #expect(model.resendWaitSeconds() == 60)
    }

    @Test func onlyEightDigitsCanBeVerified() async {
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.email = FakeSupabase.email
        await model.sendCode()
        model.code = "1234567"
        #expect(model.canVerify == false)
        await model.verify()
        #expect(await fake.count("POST", "verify") == 0)
        model.code = "12a45678"
        #expect(model.canVerify == false)
        model.code = "123456789"
        #expect(model.canVerify == false)
        model.code = "12345678"
        #expect(model.canVerify == true)
    }

    @Test func aWrongCodeIsShownAndStaysOnTheCode() async {
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.email = FakeSupabase.email
        await model.sendCode()
        model.code = "87654321"
        await model.verify()
        #expect(model.errorMessage == "コードが違うか、有効期限が切れています")
        #expect(model.step == .code(email: FakeSupabase.email))
        #expect(model.auth.state != .signedIn(userID: FakeSupabase.me))
    }

    @Test func theRightCodeSignsIn() async {
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.email = FakeSupabase.email
        await model.sendCode()
        model.code = FakeSupabase.goodCode
        await model.verify()
        #expect(model.errorMessage == nil)
        #expect(model.auth.state == .signedIn(userID: FakeSupabase.me))
    }

    // MARK: DEBUG start at code entry

    #if DEBUG
    @Test func theLaunchArgumentNamesTheAddress() {
        #expect(LaunchOptions(arguments: ["Otodoke", "-otodoke-start-at-code", "qa@example.com"]).startAtCodeEntryEmail == "qa@example.com")
        #expect(LaunchOptions(arguments: ["Otodoke"]).startAtCodeEntryEmail == nil)
        #expect(LaunchOptions(arguments: ["Otodoke", "-otodoke-start-at-code"]).startAtCodeEntryEmail == nil)
    }

    @Test func theLaunchArgumentStartsAtTheCodeWithoutSendingAMail() async {
        let fake = FakeSupabase.make()
        let launch = LaunchOptions(arguments: ["Otodoke", "-otodoke-start-at-code", "qa@example.com"])
        let model = make(fake, launch: launch)
        #expect(model.step == .code(email: "qa@example.com"))
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await fake.count("POST", "otp") == 0)
        model.code = FakeSupabase.goodCode
        await model.verify()
        #expect(model.auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(await fake.count("POST", "otp") == 0)
    }
    #endif
}
