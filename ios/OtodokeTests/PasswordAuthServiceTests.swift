import Foundation
import Testing
@testable import Otodoke

/// [password-login] AuthService with password-v1 (login-auth.ts of integrate/password-v1 3449af0, as the app does it
/// against Supabase directly):
///  - signUp / signInWithPassword carry email_norm and auth_secret (64 lowercase hex), never the password;
///  - signUp and the confirmation again carry redirect_to = https://otodoke.app/auth/confirm?next=%2Fapp (with its
///    `?`: the mail's link is `{{ .RedirectTo }}&token_hash=…`), and answer "sent" whether or not the address has
///    an account (user_already_exists, email_exists, over_email_send_rate_limit, a 429 without a code);
///  - a non-ASCII address is refused at sign-up only (email_not_ascii), before anything is sent;
///  - gotrue_meta_security.captcha_token when a token is given, nothing when not (CAPTCHA is off in production);
///  - Supabase's errors by code and status: credentials, not_confirmed, rate, captcha, network, other;
///  - after a sign-in: the session, signedInEmail (the session's user.email) and, once, the PasswordSignIn for the
///    key step.
@Suite("Password login: AuthService (password-login)")
@MainActor
struct PasswordAuthServiceTests {
    // MARK: sign-up

    @Test func signUpSendsEmailNormAndTheAuthSecretNeverThePassword() async throws {
        let fake = FakeSupabase.make()
        let auth = PW.auth(fake)
        try await auth.signUp(email: "  QA@Example.com ", password: PW.good, captchaToken: "tok-1")
        let sent = await fake.requests("POST", "signup")
        #expect(sent.count == 1)
        let body = try #require(sent.first?.jsonDictionary)
        #expect(body["email"] as? String == "qa@example.com")
        let secret = try #require(body["password"] as? String)
        #expect(secret == PW.secret(email: "qa@example.com", password: PW.good))
        #expect(secret.wholeMatch(of: /[0-9a-f]{64}/) != nil)
        #expect(!PW.text(await fake.requests()).contains(PW.good))
    }

    @Test func signUpCarriesTheConfirmRedirectWithItsQuery() async throws {
        let fake = FakeSupabase.make()
        let auth = PW.auth(fake)
        try await auth.signUp(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        let request = await fake.requests("POST", "signup").first
        #expect(PW.redirect(request) == PW.confirmRedirect)
        #expect(AppConfig.authRedirect.absoluteString == PW.confirmRedirect)
    }

    @Test func signUpCarriesTheCaptchaTokenOnlyWhenThereIsOne() async throws {
        let fake = FakeSupabase.make()
        let auth = PW.auth(fake)
        try await auth.signUp(email: FakeSupabase.email, password: PW.good, captchaToken: "tok-9")
        try await auth.signUp(email: "b@example.com", password: PW.good, captchaToken: nil)
        let sent = await fake.requests("POST", "signup")
        #expect(sent.count == 2)
        #expect(PW.captcha(sent.first) == "tok-9")
        #expect(sent.last?.jsonDictionary?["gotrue_meta_security"] == nil || PW.captcha(sent.last) == nil)
    }

    /// The same answer for an address with an account and one without (no account is told).
    @Test(arguments: [(400, Optional("user_already_exists")), (422, Optional("email_exists")), (429, Optional("over_email_send_rate_limit")), (429, nil)])
    func signUpAnswersSentWhateverTheAddress(status: Int, code: String?) async throws {
        let fake = FakeSupabase.make()
        await fake.forceAuth("signup", status: status, code: code)
        let auth = PW.auth(fake)
        try await auth.signUp(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        #expect(await fake.count("POST", "signup") == 1)
    }

    @Test(arguments: [
        (429, Optional("over_request_rate_limit"), LoginFailure.rate),
        (400, Optional("captcha_failed"), .captcha),
        (500, nil, .network),
        (400, Optional("email_address_invalid"), .invalidEmail),
        (422, Optional("weak_password"), .other),
    ])
    func signUpRefusalsByCode(status: Int, code: String?, expected: LoginFailure) async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("signup", status: status, code: code)
        let auth = PW.auth(fake)
        await #expect(throws: expected) { try await auth.signUp(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
    }

    @Test func signUpWithNoAnswerIsANetworkFailure() async {
        let fake = FakeSupabase.make()
        await fake.fail("POST", "signup", with: .transport(.notConnectedToInternet))
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.network) { try await auth.signUp(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
    }

    @Test(arguments: ["ユーザー@example.test", "user@exämple.test", "\u{0130}stanbul@example.test", "\u{FF55}ser@example.test"])
    func signUpRefusesANonASCIIAddressBeforeSending(email: String) async {
        let fake = FakeSupabase.make()
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.emailNotAscii) { try await auth.signUp(email: email, password: PW.good, captchaToken: nil) }
        #expect(await fake.requests().isEmpty)
    }

    @Test(arguments: ["", "qa", "qa@", "qa@example", "q a@example.com", "@example.com"])
    func signUpRefusesAnInvalidAddressBeforeSending(email: String) async {
        let fake = FakeSupabase.make()
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.invalidEmail) { try await auth.signUp(email: email, password: PW.good, captchaToken: nil) }
        #expect(await fake.requests().isEmpty)
    }

    @Test func theASCIICheckIsTheWebs() {
        #expect(AuthService.isASCIIAddress("qa@example.com"))
        #expect(AuthService.isASCIIAddress("a+b_c.d!#$%&'*/=?^`{|}~@example.com"))
        #expect(!AuthService.isASCIIAddress("ユーザー@example.test"))
        #expect(!AuthService.isASCIIAddress("user@exämple.test"))
        // A space is not printable ASCII (/^[\x21-\x7e]+$/).
        #expect(!AuthService.isASCIIAddress("qa @example.com"))
        #expect(!AuthService.isASCIIAddress(""))
    }

    // MARK: sign-in

    @Test func signInSendsEmailNormAndTheAuthSecretAndSignsIn() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        let storage = InMemorySessionStorage()
        let auth = PW.auth(fake, storage: storage)
        try await auth.signIn(email: " QA@Example.com\t", password: PW.good, captchaToken: "tok-2")
        let request = try #require(await fake.requests("POST", "token").first)
        #expect(request.query("grant_type") == ["password"])
        #expect(request.jsonDictionary?["email"] as? String == "qa@example.com")
        #expect(request.jsonDictionary?["password"] as? String == PW.secret(email: "qa@example.com", password: PW.good))
        #expect(PW.captcha(request) == "tok-2")
        #expect(!PW.text(await fake.requests()).contains(PW.good))
        #expect(auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(!storage.isEmpty)
    }

    @Test func signInWithoutATokenSendsNoCaptcha() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        let auth = PW.auth(fake)
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        #expect(PW.captcha(await fake.requests("POST", "token").first) == nil)
    }

    @Test func aWrongPasswordIsCredentials() async {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.credentials) { try await auth.signIn(email: FakeSupabase.email, password: PW.good + "x", captchaToken: nil) }
        #expect(auth.state != .signedIn(userID: FakeSupabase.me))
        #expect(auth.takeSignInSecret() == nil)
    }

    @Test func anUnconfirmedAddressIsNotConfirmed() async {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good), confirmed: false)
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.notConfirmed) { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
    }

    @Test(arguments: [
        (400, Optional("invalid_credentials"), LoginFailure.credentials),
        (400, Optional("email_not_confirmed"), .notConfirmed),
        (400, Optional("captcha_failed"), .captcha),
        (429, Optional("over_request_rate_limit"), .rate),
        (429, nil, .rate),
        (500, nil, .network),
        (503, nil, .network),
        (400, Optional("validation_failed"), .other),
    ])
    func signInRefusalsByCode(status: Int, code: String?, expected: LoginFailure) async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: status, code: code)
        let auth = PW.auth(fake)
        await #expect(throws: expected) { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
    }

    @Test func signInWithNoAnswerIsANetworkFailureAndIsNotSentAgain() async {
        let fake = FakeSupabase.make()
        await fake.fail("POST", "token", with: .transport(.timedOut))
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.network) { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
        #expect(await fake.count("POST", "token") == 1)
    }

    @Test func signInDoesNotRefuseANonASCIIAddress() async {
        // Only a new account must be ASCII (login-auth.ts signIn has no such check).
        let fake = FakeSupabase.make()
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.credentials) { try await auth.signIn(email: "ユーザー@example.test", password: PW.good, captchaToken: nil) }
        #expect(await fake.count("POST", "token") == 1)
    }

    @Test(arguments: ["", "qa", "qa@example", "@example.com"])
    func signInRefusesAnInvalidAddressBeforeSending(email: String) async {
        let fake = FakeSupabase.make()
        let auth = PW.auth(fake)
        await #expect(throws: LoginFailure.invalidEmail) { try await auth.signIn(email: email, password: PW.good, captchaToken: nil) }
        #expect(await fake.requests().isEmpty)
    }

    /// The real PBKDF2 (600,000 rounds) and the Web's vector: the app's sign-in sends the vector's auth_secret.
    @Test func theRealDeriverSendsTheVectorsAuthSecret() async throws {
        let v = try PasswordV1Vectors()
        let c = try #require(v.named("email_uppercase"))
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: c.emailNorm, secret: c.authSecret)
        await fake.setUserEmail(c.emailNorm)
        let auth = PW.auth(fake, deriver: PasswordV1Deriver())
        try await auth.signIn(email: c.email, password: c.password, captchaToken: nil)
        let request = try #require(await fake.requests("POST", "token").first)
        #expect(request.jsonDictionary?["password"] as? String == c.authSecret)
        #expect(request.jsonDictionary?["email"] as? String == c.emailNorm)
        #expect(auth.takeSignInSecret()?.master == c.master)
    }

    // MARK: what a sign-in leaves

    @Test func theKeyStepGetsTheSignInOnce() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        let auth = PW.auth(fake)
        try await auth.signIn(email: "QA@example.com", password: PW.good, captchaToken: nil)
        let taken = try #require(auth.takeSignInSecret())
        #expect(taken.userID == FakeSupabase.me)
        #expect(taken.email == "qa@example.com")
        #expect(taken.master == PW.master(email: "qa@example.com", password: PW.good))
        #expect(auth.takeSignInSecret() == nil)
    }

    @Test func signingOutDropsTheSignInForTheKeyStep() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        let auth = PW.auth(fake)
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        await auth.signOut()
        #expect(auth.takeSignInSecret() == nil)
    }

    /// The session keeps the address in Supabase's form; when that is not the email_norm master was made with,
    /// a key made now would not open with the address the app has later: no key step.
    @Test func noKeyStepWhenTheSessionsAddressIsAnother() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        await fake.setUserEmail("someone.else@example.com")
        let auth = PW.auth(fake)
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        #expect(auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(auth.takeSignInSecret() == nil)
    }

    @Test func signedInEmailIsTheSessionsAddress() async throws {
        let fake = FakeSupabase.make()
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        let auth = PW.auth(fake)
        #expect(auth.signedInEmail == nil)
        try await auth.signIn(email: " QA@Example.com", password: PW.good, captchaToken: nil)
        #expect(auth.signedInEmail == FakeSupabase.email)
        await auth.signOut()
        #expect(auth.signedInEmail == nil)
    }

    // MARK: the confirmation mail again

    @Test func resendIsASignupMailWithTheConfirmRedirect() async throws {
        let fake = FakeSupabase.make()
        let auth = PW.auth(fake)
        try await auth.resendConfirmation(email: " QA@Example.com ", captchaToken: "tok-3")
        let request = try #require(await fake.requests("POST", "resend").first)
        #expect(request.jsonDictionary?["type"] as? String == "signup")
        #expect(request.jsonDictionary?["email"] as? String == "qa@example.com")
        #expect(PW.redirect(request) == PW.confirmRedirect)
        #expect(PW.captcha(request) == "tok-3")
    }

    @Test(arguments: [(429, Optional("over_email_send_rate_limit")), (429, nil), (404, Optional("user_not_found")), (422, Optional("email_exists"))])
    func resendAnswersSentWhateverTheAddress(status: Int, code: String?) async throws {
        let fake = FakeSupabase.make()
        await fake.forceAuth("resend", status: status, code: code)
        let auth = PW.auth(fake)
        try await auth.resendConfirmation(email: FakeSupabase.email, captchaToken: nil)
    }

    @Test(arguments: [(429, Optional("over_request_rate_limit"), LoginFailure.rate), (400, Optional("captcha_failed"), .captcha), (502, nil, .network)])
    func resendRefusalsByCode(status: Int, code: String?, expected: LoginFailure) async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("resend", status: status, code: code)
        let auth = PW.auth(fake)
        await #expect(throws: expected) { try await auth.resendConfirmation(email: FakeSupabase.email, captchaToken: nil) }
    }

    // MARK: nothing secret in an error

    @Test func noFailureCarriesThePasswordOrTheSecret() {
        let secret = PW.secret(email: FakeSupabase.email, password: PW.good)
        for failure in LoginFailure.allCases {
            let shown = failure.message + String(describing: failure) + failure.localizedDescription
            #expect(!shown.contains(PW.good))
            #expect(!shown.contains(secret))
            #expect(!failure.message.isEmpty)
        }
    }
}
