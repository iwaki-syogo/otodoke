import Foundation
import Testing
@testable import Otodoke

/// [Task 3; password-v1] LoginView's model: the address and the password (the 8-digit code is gone), the error
/// words, the spinner, and making an account.
@Suite("LoginModel (task 3)")
@MainActor
struct LoginModelTests {
    private let start = Date(timeIntervalSince1970: 1_793_000_000)

    private func make(_ fake: FakeSupabase, launch: LaunchOptions = LaunchOptions(arguments: ["Otodoke"]), clock: TestClock? = nil) -> LoginModel {
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()), deriver: PW.fastDeriver())
        let clock = clock ?? TestClock(start)
        return LoginModel(auth: auth, launch: launch, now: clock.function)
    }

    private func account(_ fake: FakeSupabase) async {
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
    }

    @Test func beginsAtTheAddress() {
        let model = make(FakeSupabase.make())
        #expect(model.mode == .signIn)
        #expect(model.errorMessage == nil)
        #expect(model.isWorking == false)
    }

    @Test func sendingMovesToTheCode() async {
        // password-v1: making an account sends the confirmation mail and says so.
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.setMode(.signUp)
        model.email = " QA@example.com"
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        #expect(model.notice == LoginText.signupExistsOrSent)
        #expect(model.errorMessage == nil)
        #expect(model.isWorking == false)
        #expect(await fake.count("POST", "signup") == 1)
        #expect(await fake.requests("POST", "signup").first?.jsonDictionary?["email"] as? String == "qa@example.com")
    }

    @Test func anInvalidAddressSendsNothing() async {
        let fake = FakeSupabase.make()
        let model = make(fake)
        model.email = "qa@"
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == "メールアドレスの形式を確認してください。")
        #expect(await fake.requests().isEmpty)
    }

    @Test func showsTheSpinnerFromThePress() async {
        let fake = FakeSupabase.make()
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        let model = make(fake)
        model.email = FakeSupabase.email
        model.password = PW.good
        let task = Task { await model.submit() }
        #expect(await waitFor { await fake.count("POST", "token") == 1 })
        #expect(model.isWorking == true)
        gate.open()
        await task.value
        #expect(model.isWorking == false)
    }

    @Test func aRateLimitIsShown() async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        let model = make(fake)
        model.email = FakeSupabase.email
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == "回数が多いため、しばらく時間をおいてから、もう一度お試しください。")
        #expect(model.mode == .signIn)
    }

    @Test func aWrongCodeIsShownAndStaysOnTheCode() async {
        // password-v1: a wrong password is told, and the form stays (the address kept).
        let fake = FakeSupabase.make()
        await account(fake)
        let model = make(fake)
        model.email = FakeSupabase.email
        model.password = "another-password-9"
        await model.submit()
        #expect(model.errorMessage == "メールアドレスかパスワードが違います。")
        #expect(model.mode == .signIn)
        #expect(model.email == FakeSupabase.email)
        #expect(model.auth.state != .signedIn(userID: FakeSupabase.me))
    }

    @Test func theRightCodeSignsIn() async {
        // password-v1: the right password signs in.
        let fake = FakeSupabase.make()
        await account(fake)
        let model = make(fake)
        model.email = FakeSupabase.email
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == nil)
        #expect(model.auth.state == .signedIn(userID: FakeSupabase.me))
    }
}
