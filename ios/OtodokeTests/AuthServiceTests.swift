import Foundation
import Testing
@testable import Otodoke

/// [Task 3] AppConfig, SupabaseProvider and AuthService against FakeSupabase (GoTrue's wire format).
/// No request leaves the machine; nothing is sent to the real Supabase.
@Suite("AppConfig (task 3)")
struct AppConfigTests {
    private let good: [String: Any] = [
        "SUPABASE_URL": "https://abcdefghijklmnop.supabase.example",
        "SUPABASE_ANON_KEY": "anon-key-for-tests",
        "INBOUND_DOMAIN": "in.example.test",
    ]

    @Test func readsTheThreeValues() throws {
        let config = try AppConfig.load(info: good)
        #expect(config.supabaseURL.absoluteString == "https://abcdefghijklmnop.supabase.example")
        #expect(config.anonKey == "anon-key-for-tests")
        #expect(config.inboundDomain == "in.example.test")
    }

    @Test(arguments: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "INBOUND_DOMAIN"])
    func stopsOnAMissingValue(key: String) {
        var info = good
        info.removeValue(forKey: key)
        #expect(throws: AppConfigError.missing(key: key)) { try AppConfig.load(info: info) }
    }

    @Test(arguments: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "INBOUND_DOMAIN"])
    func stopsOnAnEmptyValue(key: String) {
        var info = good
        info[key] = "  "
        #expect(throws: AppConfigError.missing(key: key)) { try AppConfig.load(info: info) }
    }

    @Test(arguments: ["http://abcdefghijklmnop.supabase.example", "https:", "https://", "abcdefghijklmnop.supabase.example"])
    func refusesAURLThatIsNotHttpsWithAHost(url: String) {
        var info = good
        info["SUPABASE_URL"] = url
        #expect(throws: AppConfigError.invalid(key: "SUPABASE_URL")) { try AppConfig.load(info: info) }
    }

    @Test func theWebAndTheLoginRedirect() {
        #expect(AppConfig.webBase.absoluteString == "https://otodoke.app")
        #expect(AppConfig.authRedirect.absoluteString == "https://otodoke.app/auth/confirm?next=%2Fapp")
        #expect(WebLink.base == AppConfig.webBase)
    }
}

@Suite("SupabaseProvider (task 3)")
struct SupabaseProviderTests {
    @Test func theAppKeepsTheSessionInTheKeychain() {
        let config = AppConfig(supabaseURL: URL(string: "https://x.supabase.test")!, anonKey: "k", inboundDomain: "in.example.test")
        #expect(SupabaseProvider.live(config: config).storage is KeychainSessionStorage)
    }

    #if os(iOS)
    @Test func keychainStorageRoundTrips() throws {
        let storage = KeychainSessionStorage(service: "com.iwakisyogo.otodoke.tests.\(UUID().uuidString)")
        let key = "sb-test-auth-token"
        defer { try? storage.remove(key: key) }
        #expect(try storage.retrieve(key: key) == nil)
        try storage.store(key: key, value: Data("first".utf8))
        try storage.store(key: key, value: Data("second".utf8))
        #expect(try storage.retrieve(key: key) == Data("second".utf8))
        try storage.remove(key: key)
        #expect(try storage.retrieve(key: key) == nil)
    }
    #endif

    @Test func noUserBeforeSignIn() async {
        let fake = FakeSupabase.make()
        let provider = SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage())
        #expect(await provider.currentUserID() == nil)
    }
}

@Suite("AuthService (task 3)")
@MainActor
struct AuthServiceTests {
    private func make(_ fake: FakeSupabase, storage: InMemorySessionStorage = InMemorySessionStorage()) -> AuthService {
        AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: storage), deriver: PW.fastDeriver())
    }

    private func account(_ fake: FakeSupabase) async {
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
    }

    // MARK: making an account (password-v1; was: sending the code)

    @Test func sendsTheCodeWithTheWebsConfirmPageAsRedirect() async throws {
        // password-v1: making an account carries the Web's confirm page as redirect (the confirmation link).
        let fake = FakeSupabase.make()
        let auth = make(fake)
        try await auth.signUp(email: "  QA@Example.com ", password: PW.good, captchaToken: nil)
        let sent = await fake.requests("POST", "signup")
        #expect(sent.count == 1)
        let request = try #require(sent.first)
        #expect(request.jsonDictionary?["email"] as? String == "qa@example.com")
        let redirect = try #require(request.query("redirect_to").first.flatMap(URL.init(string:)))
        #expect(redirect.scheme == "https")
        #expect(redirect.host == "otodoke.app")
        #expect(redirect.path == "/auth/confirm")
        let next = URLComponents(url: redirect, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "next" }?.value
        #expect(next == "/app")
    }

    @Test(arguments: ["", "qa", "qa@", "qa@example", "q a@example.com", "@example.com"])
    func sendsNothingForAnInvalidAddress(email: String) async {
        let fake = FakeSupabase.make()
        let auth = make(fake)
        await #expect(throws: LoginFailure.invalidEmail) { try await auth.signIn(email: email, password: PW.good, captchaToken: nil) }
        await #expect(throws: LoginFailure.invalidEmail) { try await auth.signUp(email: email, password: PW.good, captchaToken: nil) }
        #expect(await fake.requests().isEmpty)
    }

    @Test func aRateLimitOnSendingIsTold() async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("signup", status: 429, code: "over_request_rate_limit")
        let auth = make(fake)
        await #expect(throws: LoginFailure.rate) { try await auth.signUp(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
    }

    @Test func noAnswerOnSendingIsANetworkError() async {
        let fake = FakeSupabase.make()
        await fake.fail("POST", "signup", with: .transport(.notConnectedToInternet))
        let auth = make(fake)
        await #expect(throws: LoginFailure.network) { try await auth.signUp(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
    }

    // MARK: signing in (password-v1; was: verifying the code)

    @Test func verifiesTheEightDigitsAsAnEmailOTPAndSignsIn() async throws {
        // password-v1: the password sign-in (the code is gone) signs in and keeps the session.
        let fake = FakeSupabase.make()
        await account(fake)
        let storage = InMemorySessionStorage()
        let auth = make(fake, storage: storage)
        try await auth.signIn(email: "QA@example.com", password: PW.good, captchaToken: nil)
        let request = try #require(await fake.requests("POST", "token").first)
        #expect(request.query("grant_type") == ["password"])
        #expect(request.jsonDictionary?["password"] as? String == PW.secret(email: FakeSupabase.email, password: PW.good))
        #expect(request.jsonDictionary?["email"] as? String == "qa@example.com")
        #expect(auth.state == .signedIn(userID: FakeSupabase.me))
        #expect(!storage.isEmpty)
        #expect(await auth.provider.currentUserID() == FakeSupabase.me)
    }

    @Test func aWrongCodeIsRejected() async {
        // password-v1: a wrong password.
        let fake = FakeSupabase.make()
        await account(fake)
        let auth = make(fake)
        await #expect(throws: LoginFailure.credentials) { try await auth.signIn(email: FakeSupabase.email, password: "another-password-9", captchaToken: nil) }
        #expect(auth.state != .signedIn(userID: FakeSupabase.me))
    }


    @Test func aRateLimitOnVerifyingIsTold() async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        let auth = make(fake)
        await #expect(throws: LoginFailure.rate) { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
    }

    @Test func noAnswerOnVerifyingIsANetworkError() async {
        let fake = FakeSupabase.make()
        await fake.fail("POST", "token", with: .transport(.timedOut))
        let auth = make(fake)
        await #expect(throws: LoginFailure.network) { try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil) }
    }

    @Test func theWordsOnTheLoginScreen() {
        // password-v1: the Web's LOGIN_MESSAGES (integrate/password-v1).
        #expect(LoginFailure.invalidEmail.message == "メールアドレスの形式を確認してください。")
        #expect(LoginFailure.credentials.message == "メールアドレスかパスワードが違います。")
        #expect(LoginFailure.rate.message == "回数が多いため、しばらく時間をおいてから、もう一度お試しください。")
        #expect(LoginFailure.network.message == "つながりませんでした。少し時間をおいて、もう一度お試しください。")
        #expect(LoginFailure.other.message == "うまくいきませんでした。もう一度お試しください。")
    }

    @Test func normalizesTheAddressLikeTheWeb() {
        #expect(AuthService.normalizeEmail("  QA@Example.COM\n") == "qa@example.com")
    }

    // MARK: session

    @Test func startsSignedOutWithNothingStored() async {
        let fake = FakeSupabase.make()
        let auth = make(fake)
        await auth.start()
        #expect(auth.state == .signedOut)
    }

    @Test func startsSignedInFromTheStoredSession() async throws {
        let fake = FakeSupabase.make()
        let storage = InMemorySessionStorage()
        _ = try await TestSession.signedIn(fake, storage: storage)
        let again = make(fake, storage: storage)
        await again.start()
        #expect(again.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test func aRefreshTheServerRefusesEndsAtTheLoginScreen() async throws {
        let fake = FakeSupabase.make()
        await fake.setSessionLifetime(1) // already inside any expiry margin: the next check refreshes
        let storage = InMemorySessionStorage()
        let (_, auth) = try await TestSession.signedIn(fake, storage: storage)
        await fake.setRefresh(.invalidGrant)
        await auth.checkSession()
        #expect(await waitFor { await auth.state == .signedOut })
        #expect(RootScreen.of(auth.state) == .login)
        #expect(await auth.provider.currentUserID() == nil)
    }

    @Test func aRefreshThatWorksKeepsTheUserIn() async throws {
        let fake = FakeSupabase.make()
        await fake.setSessionLifetime(1)
        let (_, auth) = try await TestSession.signedIn(fake)
        await fake.setSessionLifetime(3600)
        await auth.checkSession()
        #expect(auth.state == .signedIn(userID: FakeSupabase.me))
    }

    @Test func signsOutOnThisDeviceOnly() async throws {
        let fake = FakeSupabase.make()
        let storage = InMemorySessionStorage()
        let (_, auth) = try await TestSession.signedIn(fake, storage: storage)
        await auth.signOut()
        let logout = try #require(await fake.requests("POST", "logout").first)
        #expect(logout.query("scope") == ["local"])
        #expect(auth.state == .signedOut)
        #expect(await auth.provider.currentUserID() == nil)
    }

    @Test func signsOutLocallyEvenWhenTheServerCannotBeReached() async throws {
        let fake = FakeSupabase.make()
        let (_, auth) = try await TestSession.signedIn(fake)
        await fake.fail("POST", "logout", with: .transport(.notConnectedToInternet))
        await auth.signOut()
        #expect(auth.state == .signedOut)
        #expect(await auth.provider.currentUserID() == nil)
    }

    @Test func theRootScreenFollowsTheState() {
        #expect(RootScreen.of(.unknown) == .loading)
        #expect(RootScreen.of(.signedOut) == .login)
        #expect(RootScreen.of(.signedIn(userID: FakeSupabase.me)) == .main)
    }
}
