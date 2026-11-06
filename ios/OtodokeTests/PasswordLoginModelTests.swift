import Foundation
import Testing
@testable import Otodoke

/// [password-login] The login screen's model: sign in with the password, or make an account; one press at a
/// time; the Turnstile token of each press (the M1 rules: taken once, reset after every press, sent without one
/// when none came); the words of the Web for each category; after making an account 「確認のメールを送りました。…」;
/// after not_confirmed the confirmation mail can be sent again; 「パスワードを忘れた」 is https://otodoke.app/login/forgot.
/// The rule of a new password is checked on the password as typed, before anything is sent.
@Suite("Password login: LoginModel (password-login)")
@MainActor
struct PasswordLoginModelTests {
    private let start = Date(timeIntervalSince1970: 1_793_000_000)

    private func make(_ fake: FakeSupabase, token: TurnstileToken? = nil, wait: Duration = .milliseconds(200)) -> (LoginModel, AuthService) {
        let auth = PW.auth(fake)
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: ["Otodoke"]), now: TestClock(start).function, turnstile: token, tokenWait: wait)
        model.email = FakeSupabase.email
        return (model, auth)
    }

    private func account(_ fake: FakeSupabase, confirmed: Bool = true) async {
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good), confirmed: confirmed)
    }

    // MARK: the form

    @Test func beginsOnSignInWithEmptyFields() {
        let (model, _) = make(FakeSupabase.make())
        #expect(model.mode == .signIn)
        #expect(model.password.isEmpty)
        #expect(model.passwordAgain.isEmpty)
        #expect(model.errorMessage == nil)
        #expect(model.notice == nil)
        #expect(!model.canResendConfirmation)
    }

    @Test func switchingTheFormKeepsTheAddressAndClearsTheRest() async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: 400, code: "invalid_credentials")
        let token = TurnstileToken()
        let (model, _) = make(fake, token: token)
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == LoginText.credentials)
        let resets = token.resetCount
        model.password = "something"
        model.passwordAgain = "something"
        model.setMode(.signUp)
        #expect(model.mode == .signUp)
        #expect(model.email == FakeSupabase.email)
        #expect(model.password.isEmpty)
        #expect(model.passwordAgain.isEmpty)
        #expect(model.errorMessage == nil)
        #expect(model.notice == nil)
        #expect(token.resetCount == resets + 1)
        model.setMode(.signIn)
        #expect(model.mode == .signIn)
    }

    @Test func theButtonNeedsAnAddressAndAPassword() {
        let (model, _) = make(FakeSupabase.make())
        model.email = ""
        model.password = PW.good
        #expect(!model.canSubmit)
        model.email = FakeSupabase.email
        model.password = ""
        #expect(!model.canSubmit)
        model.password = PW.good
        #expect(model.canSubmit)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        #expect(model.canSubmit)
        model.passwordAgain = PW.good + "x"
        #expect(!model.canSubmit)
    }

    // MARK: signing in

    @Test func signingInSignsInAndClearsThePassword() async {
        let fake = FakeSupabase.make()
        await account(fake)
        let (model, auth) = make(fake)
        model.password = PW.good
        await model.submit()
        #expect(auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(model.password.isEmpty)
        #expect(model.errorMessage == nil)
        #expect(!PW.text(await fake.requests()).contains(PW.good))
        // The key step gets the sign-in (MainScreens takes it once the main screens are up).
        #expect(auth.takeSignInSecret()?.userID == FakeSupabase.me)
    }

    @Test(arguments: [
        ("invalid_credentials", 400, LoginText.credentials),
        ("captcha_failed", 400, LoginText.captcha),
        ("over_request_rate_limit", 429, LoginText.rate),
        ("unexpected_failure", 400, LoginText.other),
    ])
    func eachCategoryHasTheWebsWords(code: String, status: Int, words: String) async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: status, code: code)
        let (model, _) = make(fake)
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == words)
        #expect(model.password.isEmpty)
        #expect(!model.canResendConfirmation)
    }

    @Test func noAnswerHasTheNetworkWords() async {
        let fake = FakeSupabase.make()
        await fake.fail("POST", "token", with: .transport(.notConnectedToInternet))
        let (model, _) = make(fake)
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == LoginText.network)
    }

    @Test func anInvalidAddressSendsNothing() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        model.email = "qa@example"
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == LoginText.invalidEmail)
        #expect(await fake.requests().isEmpty)
    }

    @Test func twoPressesSignInOnce() async {
        let fake = FakeSupabase.make()
        await account(fake)
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        let (model, _) = make(fake)
        model.password = PW.good
        let first = Task { await model.submit() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        #expect(model.isWorking)
        await model.submit()
        gate.open()
        await first.value
        #expect(await fake.count("POST", "token") == 1)
        #expect(!model.isWorking)
    }

    // MARK: not confirmed

    @Test func notConfirmedOffersTheConfirmationMailAgain() async {
        let fake = FakeSupabase.make()
        await account(fake, confirmed: false)
        let token = TurnstileToken()
        let (model, _) = make(fake, token: token)
        model.password = PW.good
        await model.submit()
        #expect(model.errorMessage == LoginText.notConfirmed)
        #expect(model.canResendConfirmation)
        token.receive(.token("tok-r"), generation: token.generation)
        await model.resendConfirmation()
        let request = await fake.requests("POST", "resend").first
        #expect(request?.jsonDictionary?["type"] as? String == "signup")
        #expect(PW.redirect(request) == PW.confirmRedirect)
        #expect(PW.captcha(request) == "tok-r")
        #expect(model.notice == LoginText.confirmationSent)
        #expect(model.errorMessage == nil)
    }

    @Test func theConfirmationMailIsNotOfferedBeforeNotConfirmed() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await model.resendConfirmation()
        #expect(await fake.count("POST", "resend") == 0)
    }

    // MARK: making an account

    @Test func makingAnAccountSaysTheMailWasSentAndStaysOnTheForm() async {
        let fake = FakeSupabase.make()
        let (model, auth) = make(fake)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        #expect(await fake.count("POST", "signup") == 1)
        #expect(model.notice == LoginText.signupExistsOrSent)
        #expect(model.errorMessage == nil)
        #expect(model.password.isEmpty)
        #expect(model.passwordAgain.isEmpty)
        #expect(auth.state != .signedIn(userID: FakeSupabase.me))
    }

    @Test func anAddressWithAnAccountGetsTheSameWords() async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("signup", status: 422, code: "user_already_exists")
        let (model, _) = make(fake)
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        #expect(model.notice == LoginText.signupExistsOrSent)
        #expect(model.errorMessage == nil)
    }

    @Test func aNonASCIIAddressIsRefusedWithTheWebsWords() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        model.setMode(.signUp)
        model.email = "ユーザー@example.test"
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        #expect(model.errorMessage == LoginText.emailNotAscii)
        #expect(model.errorMessage == "半角の英数字と記号だけのメールアドレスをお使いください。")
        #expect(await fake.requests().isEmpty)
    }

    /// The rule is checked on the password as typed (NFKC), never on auth_secret (which always passes).
    @Test(arguments: [
        ("short1", "short1", "10 文字以上にしてください"),
        ("password1234", "password1234", "推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください"),
        ("aaaaaaaaaaaa", "aaaaaaaaaaaa", "推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください"),
        ("1234567890", "1234567890", "推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください"),
        ("ｐａｓｓｗｏｒｄ！！", "ｐａｓｓｗｏｒｄ！！", "推測されやすいパスワードです。同じ文字のくり返し・連番・よくある言葉は避けてください"),
        (PW.good, PW.good + "x", "2 回の入力が違います"),
    ])
    func aWeakPasswordIsRefusedBeforeSending(password: String, again: String, words: String) async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        model.setMode(.signUp)
        model.password = password
        model.passwordAgain = again
        #expect(model.passwordProblem == words)
        await model.submit()
        #expect(await fake.requests().isEmpty)
    }

    @Test func theRuleIsTheWebs() {
        #expect(PasswordRule.minLength == 10)
        #expect(PasswordRule.problem(password: PW.good, again: PW.good) == nil)
        // NFKC: full-width letters count as their ASCII form, and the two fields are compared after NFKC.
        #expect(PasswordRule.problem(password: "ｋｕｍｏ-no-ue-2026", again: PW.good) == nil)
        #expect(PasswordRule.problem(password: "abcdefghij", again: "abcdefghij") == LoginText.passwordWeak)
        #expect(PasswordRule.problem(password: "9876543210", again: "9876543210") == LoginText.passwordWeak)
        #expect(PasswordRule.problem(password: "abcabcabcabc", again: "abcabcabcabc") == LoginText.passwordWeak)
        #expect(PasswordRule.problem(password: "qwerty!!!!!!", again: "qwerty!!!!!!") == LoginText.passwordWeak)
        #expect(PasswordRule.problem(password: "あいうえおかきくけ", again: "あいうえおかきくけ") == LoginText.passwordTooShort)
        #expect(LoginText.passwordTooShort == "10 文字以上にしてください")
        #expect(LoginText.passwordMismatch == "2 回の入力が違います")
        #expect(PasswordRule.isWeak("password2026"))
        #expect(!PasswordRule.isWeak("kumo-no-ue-2026"))
    }

    // MARK: Turnstile

    @Test func aPressSendsTheTokenOnceAndResetsTheWidget() async {
        let fake = FakeSupabase.make()
        await account(fake)
        let token = TurnstileToken()
        let (model, _) = make(fake, token: token)
        token.receive(.token("tok-1"), generation: token.generation)
        let resets = token.resetCount
        model.password = PW.good
        await model.submit()
        #expect(PW.captcha(await fake.requests("POST", "token").first) == "tok-1")
        #expect(token.resetCount == resets + 1)
        #expect(!token.hasToken)
    }

    @Test func noTokenStillSendsAfterTheWait() async {
        let fake = FakeSupabase.make()
        await account(fake)
        let token = TurnstileToken()
        let (model, auth) = make(fake, token: token, wait: .milliseconds(100))
        model.password = PW.good
        await model.submit()
        #expect(await fake.count("POST", "token") == 1)
        #expect(PW.captcha(await fake.requests("POST", "token").first) == nil)
        #expect(auth.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test func makingAnAccountSendsTheToken() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken()
        let (model, _) = make(fake, token: token)
        model.setMode(.signUp)
        token.receive(.token("tok-s"), generation: token.generation)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        #expect(PW.captcha(await fake.requests("POST", "signup").first) == "tok-s")
    }

    // MARK: forgot

    @Test func forgotOpensTheWebsPageOverHTTPS() {
        let (model, _) = make(FakeSupabase.make())
        #expect(model.forgotPasswordURL == URL(string: "https://otodoke.app/login/forgot"))
        #expect(LoginText.forgotPasswordURL.scheme == "https")
        #expect(LoginText.forgotPasswordURL.host == "otodoke.app")
        #expect(LoginText.forgotPasswordURL.path == "/login/forgot")
    }
}
