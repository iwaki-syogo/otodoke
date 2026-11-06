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
    /// The clock the model reads (the rationing of the tries by itself): a test moves it.
    private let clock = TestClock(Date(timeIntervalSince1970: 1_793_000_000))

    private func make(
        _ fake: FakeSupabase, token: TurnstileToken? = nil, storage: InMemorySessionStorage = InMemorySessionStorage(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> (LoginModel, AuthService) {
        let auth = PW.auth(fake, storage: storage)
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: []), now: clock.function, turnstile: token, tokenWait: .milliseconds(100), sleep: sleep)
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
        #expect(model.shownNotice == nil)
        #expect(!model.isWorking)
        #expect(auth.state != .signedIn(userID: FakeSupabase.me))
        // Still waiting with the password: the next try goes again (after the gap).
        clock.advance(seconds: 21)
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

    /// rate, network and other (captcha has its own tests: silent for a try by itself): the wait goes on with the Web's words; the next try (back in front, or the
    /// button) goes again, and a not_confirmed answer then clears the words (quiet).
    @Test(arguments: [
        ("over_request_rate_limit", 429, LoginText.rate),
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
        clock.advance(seconds: 61)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
        #expect(model.isWaitingForConfirmation)
        // A try by itself leaves the words on the screen as they were (only a press clears them).
        #expect(model.errorMessage == words)
    }

    @Test func noAnswerKeepsWaitingWithTheNetworkWords() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await fake.fail("POST", "token", with: .transport(.notConnectedToInternet))
        await model.checkConfirmation()
        #expect(model.isWaitingForConfirmation)
        #expect(model.errorMessage == LoginText.network)
        clock.advance(seconds: 61)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
    }

    // MARK: the tries by itself are rationed (the Web's numbers; a press always tries)

    @Test func theNumbersAreTheWebs() {
        #expect(AutoSignIn.gapMs == 20_000)
        #expect(AutoSignIn.afterFailureMs == 60_000)
        #expect(AutoSignIn.max == 5)
    }

    @Test func aSecondTryByItselfWithinTwentySecondsDoesNotRun() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        clock.advance(seconds: 19)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        clock.advance(seconds: 2)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
    }

    @Test func afterARefusalNothingRunsByItselfForSixtySeconds() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        await model.checkConfirmation()
        #expect(model.errorMessage == LoginText.rate)
        #expect(await fake.count("POST", "token") == 1)
        // The gap of 20 seconds has passed, the 60 of the refusal have not.
        clock.advance(seconds: 59)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        clock.advance(seconds: 2)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
    }

    @Test func theSixthTryByItselfDoesNotRunButAPressDoes() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        for _ in 0..<AutoSignIn.max {
            clock.advance(seconds: 21)
            await model.checkConfirmation()
        }
        #expect(await fake.count("POST", "token") == 5)
        clock.advance(seconds: 21)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 5)
        // Silent: no words, and the wait goes on.
        #expect(model.errorMessage == nil)
        #expect(model.shownNotice == nil)
        #expect(model.isWaitingForConfirmation)
        // The button tries all the same (and is not counted).
        await model.checkConfirmation(pressed: true)
        #expect(await fake.count("POST", "token") == 6)
        #expect(model.shownNotice == OnboardingText.notConfirmedYet)
    }

    @Test func aPressTriesInsideTheGapAndInsideTheRefusalWait() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        await model.checkConfirmation(pressed: true)
        #expect(await fake.count("POST", "token") == 2)
    }

    @Test func aNewWaitingScreenStartsWithAFreshRation() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await model.checkConfirmation()
        model.startOver()
        model.email = FakeSupabase.email
        await signUp(model)
        // The new screen's first try by itself is not held back by the old one's.
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

    // MARK: the tries by itself and the Turnstile token

    /// Waiting with a widget that has not been tapped: no token.
    private func waitingWithWidget(_ fake: FakeSupabase) async -> (LoginModel, TurnstileToken) {
        let token = TurnstileToken(now: clock.function)
        let (model, _) = make(fake, token: token)
        // Making the account sends without a token (the tap is only waited for a press); then the widget is reset.
        await signUp(model)
        return (model, token)
    }

    @Test func aTryByItselfWithoutATokenSendsNothingAndDoesNotWait() async {
        let fake = FakeSupabase.make()
        let (model, token) = await waitingWithWidget(fake)
        #expect(!token.hasToken)
        let before = await fake.count("POST", "token")
        let started = ContinuousClock.now
        await model.checkConfirmation()
        // No ten seconds of waiting (the press's wait), no request, no words.
        #expect(ContinuousClock.now - started < .seconds(2))
        #expect(await fake.count("POST", "token") == before)
        #expect(model.errorMessage == nil)
        #expect(model.shownNotice == nil)
        #expect(!model.isWorking)
        // It did not use up the gap: a token that comes right after is tried at once.
        token.receive(.token("tok-tap"), generation: token.generation)
        await model.checkConfirmation()
        #expect(PW.captcha(await fake.requests("POST", "token").last) == "tok-tap")
    }

    @Test func aTokenThatComesWhileWaitingIsTried() async {
        let fake = FakeSupabase.make()
        let (model, token) = await waitingWithWidget(fake)
        await account(fake, confirmed: true)
        token.receive(.token("tok-1"), generation: token.generation)
        #expect(token.hasToken)
        await model.checkConfirmation()
        #expect(PW.captcha(await fake.requests("POST", "token").first) == "tok-1")
    }

    @Test func aTokenOlderThanTwoHundredEightySecondsIsDroppedAndTheWidgetMovedOn() async {
        let fake = FakeSupabase.make()
        let (model, token) = await waitingWithWidget(fake)
        token.receive(.token("old"), generation: token.generation)
        clock.advance(seconds: 281)
        let generation = token.generation
        await model.checkConfirmation()
        // Nothing sent with the old token; the widget moved on (a new tap is needed); nothing said.
        #expect(await fake.count("POST", "token") == 0)
        #expect(token.generation == generation + 1)
        #expect(!token.hasToken)
        #expect(model.errorMessage == nil)
        // A token of 279 seconds is still good.
        token.receive(.token("fresh"), generation: token.generation)
        clock.advance(seconds: 279)
        await model.checkConfirmation()
        #expect(PW.captcha(await fake.requests("POST", "token").first) == "fresh")
    }

    @Test func theStaleLimitIsTheWebs() {
        #expect(Turnstile.tokenStaleMs == 280_000)
    }

    @Test func aCaptchaRefusalOfATryByItselfIsSilentAndTriesOnceMoreWithAFreshToken() async {
        let fake = FakeSupabase.make()
        let (model, token) = await waitingWithWidget(fake)
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        token.receive(.token("tok-1"), generation: token.generation)
        let first = Task { await model.checkConfirmation() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        // The widget renews its token while the first answer is on its way.
        token.receive(.token("tok-2"), generation: token.generation)
        gate.open()
        await first.value
        let sent = await fake.requests("POST", "token")
        #expect(sent.map { PW.captcha($0) } == ["tok-1", "tok-2"])
        // Silent, still waiting, and the tap that follows is not held back by a wait.
        #expect(model.errorMessage == nil)
        #expect(model.shownNotice == nil)
        #expect(model.isWaitingForConfirmation)
        clock.advance(seconds: 21)
        token.receive(.token("tok-3"), generation: token.generation)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 3)
    }

    @Test func aCaptchaRefusalOfATryByItselfWithoutAFreshTokenIsSilentAndSendsOnce() async {
        let fake = FakeSupabase.make()
        let (model, token) = await waitingWithWidget(fake)
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        token.receive(.token("tok-1"), generation: token.generation)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        #expect(model.errorMessage == nil)
        #expect(model.isWaitingForConfirmation)
    }

    @Test func aCaptchaRefusalOfAPressKeepsTheWebsWords() async {
        let fake = FakeSupabase.make()
        let (model, token) = await waitingWithWidget(fake)
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        token.receive(.token("tok-1"), generation: token.generation)
        await model.checkConfirmation(pressed: true)
        #expect(model.errorMessage == LoginText.captcha)
    }

    @Test func aTryByItselfKeepsTheWordsOnTheScreenAndAPressClearsThem() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await model.checkConfirmation(pressed: true)
        #expect(model.shownNotice == OnboardingText.notConfirmedYet)
        clock.advance(seconds: 21)
        await model.checkConfirmation()
        // The try by itself did not take the words away.
        #expect(model.shownNotice == OnboardingText.notConfirmedYet)
        await model.checkConfirmation(pressed: true)
        #expect(model.shownNotice == OnboardingText.notConfirmedYet)
        // A press that ends otherwise clears them first.
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        await model.checkConfirmation(pressed: true)
        #expect(model.shownNotice == nil)
        #expect(model.errorMessage == LoginText.rate)
    }

    @Test func theResentToastGoesByItself() async {
        let fake = FakeSupabase.make()
        let sleeper = ControlledSleeper()
        let (model, _) = make(fake, sleep: sleeper.sleep)
        await signUp(model)
        await model.resendConfirmation()
        #expect(model.toast == OnboardingText.resent)
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        #expect(sleeper.requested == [.seconds(LoginModel.toastSeconds)])
        sleeper.fireAll()
        #expect(await waitFor(.seconds(3)) { await MainActor.run { model.toast == nil } })
        #expect(model.isWaitingForConfirmation)
    }

    @Test func startingOverTakesTheToastAway() async {
        let fake = FakeSupabase.make()
        let sleeper = ControlledSleeper()
        let (model, _) = make(fake, sleep: sleeper.sleep)
        await signUp(model)
        await model.resendConfirmation()
        model.startOver()
        #expect(model.toast == nil)
    }

    // MARK: a return inside the gap keeps one try for the end of the gap

    @Test func aReturnInsideTheGapTriesOnceWhenTheGapEnds() async {
        let fake = FakeSupabase.make()
        let sleeper = ControlledSleeper()
        let (model, _) = make(fake, sleep: sleeper.sleep)
        await signUp(model)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        // Back in front 5 seconds later: nothing now; one try is kept for the end of the gap (15 seconds on).
        clock.advance(seconds: 5)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        #expect(sleeper.requested == [.milliseconds(15_000)])
        // More returns meanwhile keep no more than that one.
        clock.advance(seconds: 3)
        await model.checkConfirmation()
        await model.checkConfirmation()
        #expect(sleeper.requested.count == 1)
        // The gap ends and the screen is in front: one try goes.
        clock.advance(seconds: 12)
        sleeper.fireAll()
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 2 })
        // That try keeps no other: nothing more happens by itself.
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await fake.count("POST", "token") == 2)
        #expect(sleeper.pendingCount == 0)
        #expect(sleeper.requested.count == 1)
    }

    @Test func theKeptTryDoesNotGoWhenTheAppIsNotInFrontOrTheWaitIsOver() async {
        let fake = FakeSupabase.make()
        let sleeper = ControlledSleeper()
        let (model, _) = make(fake, sleep: sleeper.sleep)
        await signUp(model)
        await model.checkConfirmation()
        clock.advance(seconds: 5)
        await model.checkConfirmation()
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        model.isInFront = false
        clock.advance(seconds: 20)
        sleeper.fireAll()
        try? await Task.sleep(for: .milliseconds(300))
        #expect(await fake.count("POST", "token") == 1)
        // Starting over drops a kept try too.
        model.isInFront = true
        await model.checkConfirmation()
        model.startOver()
        #expect(sleeper.pendingCount == 0)
    }

    @Test func theKeptTryKeepsTheOtherRules() async {
        let fake = FakeSupabase.make()
        let sleeper = ControlledSleeper()
        let token = TurnstileToken(now: clock.function)
        let (model, _) = make(fake, token: token, sleep: sleeper.sleep)
        await signUp(model)
        token.receive(.token("tok-1"), generation: token.generation)
        await model.checkConfirmation()
        let sent = await fake.count("POST", "token")
        clock.advance(seconds: 5)
        await model.checkConfirmation()
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        // The gap ends with no token (the widget was reset after the send and nobody tapped): nothing is sent.
        clock.advance(seconds: 20)
        sleeper.fireAll()
        try? await Task.sleep(for: .milliseconds(300))
        #expect(await fake.count("POST", "token") == sent)
        #expect(model.errorMessage == nil)
        // Not kept at all while the limit of sends is used up, or while a refusal's wait is longer than the gap.
        let (full, _) = make(FakeSupabase.make(), sleep: sleeper.sleep)
        await signUp(full)
        for _ in 0..<AutoSignIn.max {
            clock.advance(seconds: 21)
            await full.checkConfirmation()
        }
        let before = sleeper.requested.count
        await full.checkConfirmation()
        #expect(sleeper.requested.count == before)
    }

    // MARK: sending the mail again, starting over

    @Test func theMailCanBeSentAgainFromTheWaitingState() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await model.resendConfirmation()
        #expect(await fake.count("POST", "resend") == 1)
        // A toast, not a box that stays.
        #expect(model.toast == OnboardingText.resent)
        #expect(model.shownNotice == nil)
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
        // The address was the wrong one: the form is empty.
        #expect(model.email.isEmpty)
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
