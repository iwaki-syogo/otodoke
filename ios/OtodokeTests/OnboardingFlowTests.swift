import Foundation
import Testing
@testable import Otodoke

/// [onboarding] From making an account to the forwarding setup, without stopping:
///  - after making an account the login model waits for the confirmation mail, holding the address and the
///    password in memory only; coming back to the front or pressing 「確認しました」 tries the existing password
///    sign-in; not_confirmed is a quiet wait; one try at a time; starting over drops the password;
///  - the guide screen is shown only when this login made the key (KeySetupOutcome.created);
///  - the empty list's 「転送先を見る」 opens the 「メールの転送」 page.
@Suite("Onboarding: waiting for the confirmation (onboarding)")
@MainActor
struct OnboardingFlowTests {
    private func make(_ fake: FakeSupabase, token: TurnstileToken? = nil, storage: InMemorySessionStorage = InMemorySessionStorage()) -> (LoginModel, AuthService) {
        let auth = PW.auth(fake, storage: storage)
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: []), turnstile: token, tokenWait: .milliseconds(100))
        model.email = FakeSupabase.email
        return (model, auth)
    }

    private func signUp(_ model: LoginModel) async {
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
    }

    private func account(_ fake: FakeSupabase, confirmed: Bool) async {
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good), confirmed: confirmed)
    }

    // MARK: making an account leads to the waiting screen

    @Test func makingAnAccountMovesToTheWaitingState() async {
        let fake = FakeSupabase.make()
        let (model, auth) = make(fake)
        #expect(!model.isWaitingForConfirmation)
        await signUp(model)
        #expect(model.isWaitingForConfirmation)
        #expect(model.confirmationAddress == FakeSupabase.email)
        #expect(model.password.isEmpty)
        #expect(model.passwordAgain.isEmpty)
        #expect(model.errorMessage == nil)
        // The sign-up's own sentence is not drawn on the waiting screen.
        #expect(model.shownNotice == nil)
        // The mail can be sent again from the waiting screen.
        #expect(model.canResendConfirmation)
        #expect(auth.state != .signedIn(userID: FakeSupabase.me))
    }

    @Test func aFailedSignUpDoesNotWait() async {
        let fake = FakeSupabase.make()
        await fake.forceAuth("signup", status: 400, code: "captcha_failed")
        let (model, _) = make(fake)
        await signUp(model)
        #expect(!model.isWaitingForConfirmation)
        #expect(model.errorMessage == LoginText.captcha)
    }

    @Test func theAddressAndThePasswordAreKeptInMemoryOnly() async {
        let defaultsBefore = UserDefaults.standard.dictionaryRepresentation().mapValues { "\($0)" }
        let storage = InMemorySessionStorage()
        let fake = FakeSupabase.make()
        let (model, _) = make(fake, storage: storage)
        await signUp(model)
        #expect(model.isWaitingForConfirmation)
        // Nothing reached the session storage (the Keychain's stand-in) or the defaults; no request carries the password.
        #expect(storage.isEmpty)
        #expect(UserDefaults.standard.dictionaryRepresentation().mapValues { "\($0)" } == defaultsBefore)
        #expect(!PW.text(await fake.requests()).contains(PW.good))
        // A new model (the app was closed and opened) knows nothing: it is the plain sign-in form.
        let (again, _) = make(fake)
        #expect(!again.isWaitingForConfirmation)
        #expect(again.mode == .signIn)
        await again.checkConfirmation()
        #expect(await fake.count("POST", "token") == 0)
    }

    // MARK: coming back to the front, 「確認しました」

    @Test func notConfirmedWaitsQuietly() async {
        let fake = FakeSupabase.make()
        let (model, auth) = make(fake)
        await signUp(model)
        await account(fake, confirmed: false)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        #expect(model.isWaitingForConfirmation)
        #expect(model.errorMessage == nil)
        #expect(model.notice == nil)
        #expect(!model.isWorking)
        #expect(auth.state != .signedIn(userID: FakeSupabase.me))
        // Still waiting with the password: the next try goes again.
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
    }

    @Test func pressingTheButtonSaysItIsNotConfirmedYetButTheAutomaticTryDoesNot() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await model.checkConfirmation()
        #expect(model.shownNotice == nil)
        await model.checkConfirmation(pressed: true)
        #expect(model.shownNotice == OnboardingText.notConfirmedYet)
        #expect(model.errorMessage == nil)
        #expect(model.isWaitingForConfirmation)
    }

    @Test func aConfirmedAddressSignsInWithTheExistingPasswordSignIn() async throws {
        let fake = FakeSupabase.make()
        let (model, auth) = make(fake)
        await signUp(model)
        await account(fake, confirmed: true)
        await model.checkConfirmation()
        #expect(auth.state == .signedIn(userID: FakeSupabase.me))
        // The same hand-off the sign-in form leaves for the key step.
        let hand = try #require(auth.takeSignInSecret())
        #expect(hand.userID == FakeSupabase.me)
        #expect(hand.email == FakeSupabase.email)
        #expect(hand.master == PW.master(email: FakeSupabase.email, password: PW.good))
        #expect(model.errorMessage == nil)
        // The password is gone: a try after the sign-in sends nothing more.
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
    }

    @Test func eachTryTakesTheTurnstileTokenOnceAndResetsTheWidget() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken()
        let (model, _) = make(fake, token: token)
        await signUp(model)
        await account(fake, confirmed: false)
        token.receive(.token("tok-w"), generation: token.generation)
        let resets = token.resetCount
        await model.checkConfirmation()
        #expect(PW.captcha(await fake.requests("POST", "token").first) == "tok-w")
        #expect(token.resetCount == resets + 1)
        #expect(!token.hasToken)
    }

    /// rate, captcha, network and other: the wait goes on with the Web's words; the next try (back in front, or the
    /// button) goes again, and a not_confirmed answer then clears the words (quiet).
    @Test(arguments: [
        ("over_request_rate_limit", 429, LoginText.rate),
        ("captcha_failed", 400, LoginText.captcha),
        ("unexpected_failure", 400, LoginText.other),
        ("unexpected_failure", 503, LoginText.network),
    ])
    func aFailureThatIsNotAboutTheAddressKeepsWaitingAndTriesAgain(code: String, status: Int, words: String) async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await fake.forceAuth("password", status: status, code: code)
        await model.checkConfirmation()
        #expect(model.isWaitingForConfirmation)
        #expect(model.mode == .signUp)
        #expect(model.errorMessage == words)
        #expect(model.canCheckConfirmation)
        // The password is still held: the next try goes.
        await fake.forceAuth("password", status: 400, code: "email_not_confirmed")
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
        #expect(model.isWaitingForConfirmation)
        #expect(model.errorMessage == nil)
    }

    @Test func noAnswerKeepsWaitingWithTheNetworkWords() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await fake.fail("POST", "token", with: .transport(.notConnectedToInternet))
        await model.checkConfirmation()
        #expect(model.isWaitingForConfirmation)
        #expect(model.errorMessage == LoginText.network)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
    }

    @Test func aPasswordTheAccountDoesNotKnowLeavesTheWaitForTheSignInForm() async {
        // The address already had an account (the sign-up answered "sent" all the same): the password typed is not its own.
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        await model.checkConfirmation()
        #expect(!model.isWaitingForConfirmation)
        #expect(model.mode == .signIn)
        #expect(model.email == FakeSupabase.email)
        #expect(model.errorMessage == LoginText.credentials)
        #expect(model.password.isEmpty)
    }

    @Test func twoTriesAtOnceSignInOnce() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await account(fake, confirmed: true)
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        let first = Task { await model.checkConfirmation() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        #expect(model.isWorking)
        await model.checkConfirmation()
        gate.open()
        await first.value
        #expect(await fake.count("POST", "token") == 1)
        #expect(!model.isWorking)
    }

    @Test func aTryDoesNotRunWhileTheFormIsSendingOrWhenNotWaiting() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await model.checkConfirmation()
        #expect(await fake.requests().isEmpty)
    }

    // MARK: sending the mail again, starting over

    @Test func theMailCanBeSentAgainFromTheWaitingState() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await model.resendConfirmation()
        #expect(await fake.count("POST", "resend") == 1)
        #expect(model.shownNotice == OnboardingText.resent)
        #expect(model.isWaitingForConfirmation)
    }

    @Test func startingOverDropsTheWaitAndThePassword() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken()
        let (model, _) = make(fake, token: token)
        await signUp(model)
        let resets = token.resetCount
        model.startOver()
        #expect(!model.isWaitingForConfirmation)
        #expect(model.confirmationAddress == nil)
        #expect(model.mode == .signUp)
        #expect(model.email == FakeSupabase.email)
        #expect(model.password.isEmpty)
        #expect(model.passwordAgain.isEmpty)
        #expect(model.notice == nil)
        #expect(model.errorMessage == nil)
        #expect(!model.canResendConfirmation)
        #expect(token.resetCount == resets + 1)
        // The password is gone for good: nothing is sent by a try.
        await account(fake, confirmed: true)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 0)
    }

    @Test func switchingTheFormDropsTheWaitToo() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        model.setMode(.signIn)
        #expect(!model.isWaitingForConfirmation)
        await account(fake, confirmed: true)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 0)
    }

    // MARK: the guide screen only for the login that made the key

    @Test func theGuideShowsOnlyAfterTheKeyWasMade() {
        #expect(OnboardingGate.shouldShow(after: .created(keyID: "k")))
        for outcome: KeySetupOutcome? in [nil, .opened(keyID: "k"), .failed(message: "x"), .addressMismatch, .stale, .needsWebLogin] {
            #expect(!OnboardingGate.shouldShow(after: outcome), "\(String(describing: outcome))")
        }
    }

    @Test func theFirstLoginMakesTheKeyAndTheNextOnlyOpensIt() async throws {
        let w = try await KeySetupTests.World()
        #expect(!OnboardingGate.shouldShow(after: w.setup.lastOutcome))
        await w.setup.run(w.signIn)
        #expect(OnboardingGate.shouldShow(after: w.setup.lastOutcome))
        // A second login (the key is there now) opens it: no guide.
        await w.setup.run(w.signIn)
        #expect(!OnboardingGate.shouldShow(after: w.setup.lastOutcome))
    }

    // MARK: the landing is decided before the tabs are seen

    @Test func theLandingIsWaitingGuideOrTabsAndNeverTabsBeforeTheGuide() {
        // While the key step runs: the waiting display, whatever the last outcome was.
        for outcome: KeySetupOutcome? in [nil, .created(keyID: "k"), .opened(keyID: "k")] {
            #expect(Landing.of(deciding: true, outcome: outcome, guideClosed: false) == .waiting)
        }
        #expect(Landing.of(deciding: false, outcome: .created(keyID: "k"), guideClosed: false) == .guide)
        #expect(Landing.of(deciding: false, outcome: .created(keyID: "k"), guideClosed: true) == .tabs)
        for outcome: KeySetupOutcome? in [nil, .opened(keyID: "k"), .failed(message: "x"), .addressMismatch, .stale, .needsWebLogin] {
            #expect(Landing.of(deciding: false, outcome: outcome, guideClosed: false) == .tabs)
        }
    }

    /// The whole sequence of a first login: from the hand-off to the end of the key step the screen never reads `.tabs`.
    @Test func aFirstLoginLandsOnTheGuideWithoutTheTabsBetween() async throws {
        let w = try await KeySetupTests.World()
        #expect(!w.setup.isDeciding)
        var seen: [Landing] = [Landing.of(deciding: w.setup.isDeciding, outcome: w.setup.lastOutcome, guideClosed: false)]
        w.setup.holdLanding()
        seen.append(Landing.of(deciding: w.setup.isDeciding, outcome: w.setup.lastOutcome, guideClosed: false))
        await w.setup.run(w.signIn)
        // The outcome is set while the landing is still held: the in-between state is the waiting display.
        seen.append(Landing.of(deciding: w.setup.isDeciding, outcome: w.setup.lastOutcome, guideClosed: false))
        w.setup.releaseLanding()
        seen.append(Landing.of(deciding: w.setup.isDeciding, outcome: w.setup.lastOutcome, guideClosed: false))
        #expect(seen == [.tabs, .waiting, .waiting, .guide])
        #expect(!seen.dropFirst().contains(.tabs))
    }

    @Test func anOrdinaryLoginLandsOnTheTabsWithoutTheGuide() async throws {
        let w = try await KeySetupTests.World()
        _ = try await w.plantKeyInUse()
        w.setup.holdLanding()
        var seen = [Landing.of(deciding: w.setup.isDeciding, outcome: w.setup.lastOutcome, guideClosed: false)]
        await w.setup.run(w.signIn)
        seen.append(Landing.of(deciding: w.setup.isDeciding, outcome: w.setup.lastOutcome, guideClosed: false))
        w.setup.releaseLanding()
        seen.append(Landing.of(deciding: w.setup.isDeciding, outcome: w.setup.lastOutcome, guideClosed: false))
        #expect(seen == [.waiting, .waiting, .tabs])
        // The key step of an ordinary login makes no key (no register, no activate): it only reads and opens.
        #expect(await w.server.count("register") == 0)
        #expect(await w.server.count("activate") == 0)
    }

    @Test func aLaunchWithAStoredSessionHoldsNothing() async throws {
        let w = try await KeySetupTests.World()
        #expect(!w.setup.isDeciding)
        #expect(Landing.of(deciding: w.setup.isDeciding, outcome: w.setup.lastOutcome, guideClosed: false) == .tabs)
    }

    /// The app's own wiring (AuthService.makeSignedIn → MainScreens.live → attachKeys): signing in with the password
    /// holds the landing at the hand-off, in the same step the screens are made, and lets it go when the key step ends.
    private func signedInScreens(plantKey: Bool) async throws -> (screens: MainScreens, fake: FakeSupabase, server: FakeKeysServer) {
        let fake = FakeSupabase.make()
        let server = FakeKeysServer.make(supabase: fake)
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        if plantKey {
            let row = try KeyGeneration.generate(master: PW.master(email: FakeSupabase.email, password: PW.good), userID: FakeSupabase.me).row
            await fake.insert("user_keys", [[
                "user_id": .string(FakeSupabase.me), "key_id": .string(row.keyID), "public_key": .string(row.publicKey),
                "wrapped_private_key": .string(row.wrappedPrivateKey), "wrap_iv": .string(row.wrapIv), "kdf_salt": .string(row.kdfSalt),
                "kdf_iterations": 600_000, "activated_at": "2026-11-06T00:00:00.000000+00:00", "retired_at": nil,
            ]])
        }
        let auth = PW.auth(fake)
        let parts = MainScreens.KeyParts(
            policy: KeyStorePolicy(defaults: scratchDefaults()),
            keychain: FakeKeychain(),
            biometrics: FakeBiometrics(.available(.faceID)),
            service: "com.iwakisyogo.otodoke.auth",
            api: KeyAPIClient(baseURL: server.baseURL, session: server.urlSession)
        )
        let made = Box<MainScreens>()
        auth.makeSignedIn = { a in
            let screens = MainScreens.live(auth: a, keyParts: parts)
            made.value = screens
            return screens
        }
        await auth.start()
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil)
        let screens = try #require(made.value)
        return (screens, fake, server)
    }

    @Test func theFirstLoginHoldsTheLandingFromTheHandOffAndLandsOnTheGuide() async throws {
        let w = try await signedInScreens(plantKey: false)
        let setup = try #require(w.screens.keySetup)
        // Right after the sign-in, before any frame: held, nothing decided.
        #expect(setup.isDeciding)
        #expect(Landing.of(deciding: setup.isDeciding, outcome: setup.lastOutcome, guideClosed: false) == .waiting)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { !setup.isDeciding } })
        let outcome = try #require(setup.lastOutcome)
        guard case .created = outcome else { Issue.record("the first login made no key: \(outcome)"); return }
        #expect(Landing.of(deciding: setup.isDeciding, outcome: setup.lastOutcome, guideClosed: false) == .guide)
    }

    @Test func anOrdinaryLoginHoldsTheLandingOnlyForTheKeyStepAndLandsOnTheTabs() async throws {
        let w = try await signedInScreens(plantKey: true)
        let setup = try #require(w.screens.keySetup)
        #expect(setup.isDeciding)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { !setup.isDeciding } })
        guard case .opened? = setup.lastOutcome else { Issue.record("not opened: \(String(describing: setup.lastOutcome))"); return }
        #expect(Landing.of(deciding: setup.isDeciding, outcome: setup.lastOutcome, guideClosed: false) == .tabs)
        // Nothing made: the key step read the key and opened it, as before.
        #expect(await w.server.count("register") == 0)
        #expect(await w.server.count("activate") == 0)
    }

    @Test func twoHandOffsNeedTwoReleases() async throws {
        let setup = try await KeySetupTests.World().setup
        setup.holdLanding()
        setup.holdLanding()
        setup.releaseLanding()
        #expect(setup.isDeciding)
        setup.releaseLanding()
        #expect(!setup.isDeciding)
        // A release without a hold never goes below none.
        setup.releaseLanding()
        setup.holdLanding()
        #expect(setup.isDeciding)
    }

    // MARK: the empty list's button

    @Test func theEmptyListsButtonOpensTheForwardingPage() {
        var route = TabRoute()
        #expect(route.tab == .parcels)
        #expect(route.settingsPath.isEmpty)
        route.showForwarding()
        #expect(route.tab == .settings)
        #expect(route.settingsPath == [.forward])
        // From a deeper settings page too: the stack is replaced, not added to.
        route.settingsPath = [.key, .dropped]
        route.showForwarding()
        #expect(route.settingsPath == [.forward])
        // The plain button of the unread notice opens the list as it is.
        var plain = TabRoute()
        plain.showSettings()
        #expect(plain.tab == .settings)
        #expect(plain.settingsPath.isEmpty)
    }
}
