import Foundation
import Testing
@testable import Otodoke

/// [onboarding] From making an account to the forwarding setup, without stopping:
///  - after making an account the login model waits for the confirmation mail, holding the address and the
///    password in memory only; coming back to the front or pressing 「確認しました」 tries the existing password
///    sign-in; not_confirmed is a quiet wait; one try at a time; starting over drops the password;
///  - the guide screen is shown only when this login made the key (KeySetupOutcome.created);
///  - the empty list's 「設定する」 opens the 「メールの転送」 page.
@Suite("Onboarding: waiting for the confirmation (onboarding)")
@MainActor
struct OnboardingFlowTests {
    /// The clock the model reads (the rationing of the tries by itself): a test moves it.
    private let clock = TestClock(Date(timeIntervalSince1970: 1_793_000_000))

    private func make(
        _ fake: FakeSupabase, token: TurnstileToken? = nil, storage: InMemorySessionStorage = InMemorySessionStorage(),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        timerSleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> (LoginModel, AuthService) {
        let auth = PW.auth(fake, storage: storage)
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: []), now: clock.function, turnstile: token, tokenWait: .milliseconds(100), sleep: sleep, timerSleep: timerSleep)
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
        #expect(AutoSignIn.backoffMs == [20_000, 60_000, 180_000])
        #expect(AutoSignIn.gapMs(refusals: 0) == 20_000)
        #expect(AutoSignIn.gapMs(refusals: 1) == 20_000)
        #expect(AutoSignIn.gapMs(refusals: 2) == 60_000)
        #expect(AutoSignIn.gapMs(refusals: 3) == 180_000)
        #expect(AutoSignIn.gapMs(refusals: 9) == 180_000)
        #expect(AutoSignIn.afterFailureMs == 60_000)
        #expect(AutoSignIn.max == 5)
    }

    @Test func aReturnTriesAtOnceInsideTheGapButTwoReturnsOfAMomentAreOne() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        // The Web: the app shown again tries at once; the gap of the backoff holds the timer, not a return.
        clock.advance(seconds: 1)
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        clock.advance(seconds: 3)
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
        // The registered address's own sentence replaces the ordinary credentials words here (ExistingAddressTests).
        #expect(model.isExistingAddress)
        #expect(model.errorMessage == nil)
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
        // It did not use up the gap (difference 1 in AutoSignIn.swift): a token that comes once the timer's point is
        // reached is tried at once.
        clock.advance(seconds: 21)
        token.receive(.token("tok-tap"), generation: token.generation)
        await model.tokenArrived()
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

    @Test func aPressDoesNotUseATokenOlderThanTwoHundredEightySecondsEither() async {
        let fake = FakeSupabase.make()
        let (model, token) = await waitingWithWidget(fake)
        token.receive(.token("old"), generation: token.generation)
        clock.advance(seconds: 281)
        let generation = token.generation
        await model.checkConfirmation(pressed: true)
        // The old token was dropped and the widget moved on; the press waited a moment for a new one and sent without.
        #expect(token.generation == generation + 2)
        let sent = await fake.requests("POST", "token")
        #expect(sent.count == 1)
        #expect(PW.captcha(sent.first) == nil)
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

    // MARK: the timer: while the app is in front, one try at each point of the backoff

    private func waitingWithTimer(_ fake: FakeSupabase, token: TurnstileToken? = nil, confirmed: Bool? = false) async -> (LoginModel, ControlledSleeper) {
        let sleeper = ControlledSleeper()
        let (model, _) = make(fake, token: token, timerSleep: sleeper.sleep)
        await signUp(model)
        if let confirmed { await account(fake, confirmed: confirmed) }
        _ = await waitFor(.seconds(3)) { sleeper.pendingCount == 1 }
        return (model, sleeper)
    }

    @Test func anOpenScreenTriesAt20_40_100_280_460SecondsAndThenStops() async {
        let fake = FakeSupabase.make()
        let (model, sleeper) = await waitingWithTimer(fake)
        // The first timed try is one gap on from the screen appearing.
        #expect(sleeper.requested == [.milliseconds(20_000)])
        var t = 0
        for (i, at) in [20, 40, 100, 280, 460].enumerated() {
            clock.advance(seconds: Double(at - t))
            t = at
            #expect(sleeper.fireOldest())
            #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == i + 1 })
            if i < 4 { #expect(await waitFor(.seconds(3)) { sleeper.requested.count == i + 2 && sleeper.pendingCount == 1 }) }
        }
        // 20 s from the start, then the gaps of the backoff after each "not confirmed yet": 20, 60, 180, 180.
        #expect(sleeper.requested == [20_000, 20_000, 60_000, 180_000, 180_000].map { Duration.milliseconds($0) })
        // The fifth send was the last: no sixth timer, and the model says nothing.
        try? await Task.sleep(for: .milliseconds(200))
        #expect(sleeper.pendingCount == 0)
        #expect(sleeper.requested.count == 5)
        #expect(model.errorMessage == nil)
        #expect(model.isWaitingForConfirmation)
    }

    @Test func thereIsNeverMoreThanOneTimer() async {
        let fake = FakeSupabase.make()
        let (model, sleeper) = await waitingWithTimer(fake)
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        // A return that tries, then returns held back by the wait after the refusal: each sets the timer anew.
        await model.checkConfirmation()
        for _ in 0..<4 {
            clock.advance(seconds: 3)
            await model.checkConfirmation()
            await model.checkConfirmation(pressed: false)
        }
        // Each new timer replaced the old (the sleeps run in tasks: give them a moment to start).
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        try? await Task.sleep(for: .milliseconds(200))
        #expect(sleeper.pendingCount == 1)
        model.isInFront = false
        #expect(sleeper.pendingCount == 0)
        model.isInFront = true
        await model.checkConfirmation()
        // Exactly one again, never zero and never two.
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        try? await Task.sleep(for: .milliseconds(200))
        #expect(sleeper.pendingCount == 1)
    }

    @Test func aRefusalOtherThanNotConfirmedHoldsTheTimerForSixtySeconds() async {
        let fake = FakeSupabase.make()
        let (model, sleeper) = await waitingWithTimer(fake, confirmed: nil)
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        await model.checkConfirmation()
        #expect(model.errorMessage == LoginText.rate)
        // One timer, at the end of the wait (not one that rings in the middle of it).
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 && sleeper.requested.last == .milliseconds(60_000) })
        #expect(sleeper.requested == [.milliseconds(20_000), .milliseconds(60_000)])
    }

    @Test func aPressCancelsTheTimerAndTheNextOneIsAGapFromThePressWithoutWideningTheBackoff() async {
        let fake = FakeSupabase.make()
        let (model, sleeper) = await waitingWithTimer(fake)
        clock.advance(seconds: 5)
        await model.checkConfirmation(pressed: true)
        #expect(model.shownNotice == OnboardingText.notConfirmedYet)
        // Waiting from the start gave 20 s; a gap from the press at 5 s is at 25 s: 20 s from now.
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 && sleeper.requested.count == 2 })
        #expect(sleeper.requested.last == .milliseconds(20_000))
        // A press is not counted: five tries by itself are still left, and the backoff did not move.
        clock.advance(seconds: 20)
        #expect(sleeper.fireOldest())
        #expect(await waitFor(.seconds(3)) { sleeper.requested.count == 3 && sleeper.pendingCount == 1 })
        // The refusal of the first timed try is the first: the next gap is still 20 s.
        #expect(sleeper.requested.last == .milliseconds(20_000))
    }

    @Test func aPressIsNeverHeldBackBySendsOrByTheWaitAfterARefusal() async {
        let fake = FakeSupabase.make()
        let (model, _) = await waitingWithTimer(fake)
        await fake.forceAuth("password", status: 429, code: "over_request_rate_limit")
        await model.checkConfirmation()
        for _ in 0..<3 { await model.checkConfirmation(pressed: true) }
        #expect(await fake.count("POST", "token") == 4)
    }

    @Test func theTimerStopsInTheBackgroundAndATimedTryDoesNotGoThere() async {
        let fake = FakeSupabase.make()
        let (model, sleeper) = await waitingWithTimer(fake)
        model.isInFront = false
        #expect(sleeper.pendingCount == 0)
        clock.advance(seconds: 30)
        #expect(!sleeper.fireOldest())
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await fake.count("POST", "token") == 0)
        // Back in front: the return tries at once and the timer starts anew.
        model.isInFront = true
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 1)
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
    }

    @Test func theTimerStopsAtSuccessAndAtStartingOverAndSwitchingTheForm() async {
        let fake = FakeSupabase.make()
        let (signedIn, sleeper) = await waitingWithTimer(fake, confirmed: true)
        await signedIn.checkConfirmation()
        #expect(sleeper.pendingCount == 0)
        // Nothing runs by itself after the sign-in.
        #expect(await fake.count("POST", "token") == 1)

        let (again, second) = await waitingWithTimer(FakeSupabase.make())
        again.startOver()
        #expect(second.pendingCount == 0)
        let (switched, third) = await waitingWithTimer(FakeSupabase.make())
        switched.setMode(.signIn)
        #expect(third.pendingCount == 0)
    }

    // MARK: the two differences from the Web, on purpose (AutoSignIn.swift)

    @Test func aTimedTryThatFindsNoTokenUsesNoGapAndTheTapThatBringsOneTriesAtOnce() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken(now: clock.function)
        let (model, sleeper) = await waitingWithTimer(fake, token: token)
        clock.advance(seconds: 20)
        #expect(sleeper.fireOldest())
        try? await Task.sleep(for: .milliseconds(300))
        // Nothing sent, and no other timer is set for it: the Web sets lastAt here and tries a gap later.
        #expect(await fake.count("POST", "token") == 0)
        #expect(sleeper.pendingCount == 0)
        #expect(sleeper.requested.count == 1)
        // The tap gives a token: it is tried at once (the gap was not used).
        token.receive(.token("tok-tap"), generation: token.generation)
        await model.tokenArrived()
        #expect(PW.captcha(await fake.requests("POST", "token").first) == "tok-tap")
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
    }

    @Test func aTokenThatComesBeforeTheTimersPointWaitsForIt() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken(now: clock.function)
        let (model, sleeper) = await waitingWithTimer(fake, token: token)
        token.receive(.token("tok-early"), generation: token.generation)
        clock.advance(seconds: 5)
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 0)
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        // The timer's point: it takes the token that is held.
        clock.advance(seconds: 15)
        #expect(sleeper.fireOldest())
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        #expect(PW.captcha(await fake.requests("POST", "token").first) == "tok-early")
    }

    @Test func aSilentCaptchaRefusalHoldsNothingBackAndTheNextTimerIsTheGapOnly() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken(now: clock.function)
        let (model, sleeper) = await waitingWithTimer(fake, token: token, confirmed: nil)
        await fake.forceAuth("password", status: 400, code: "captcha_failed")
        token.receive(.token("tok-1"), generation: token.generation)
        await model.checkConfirmation()
        #expect(model.errorMessage == nil)
        // The Web would hold the next try for 60 s here; iOS needs a tap for a new token and tries when it comes.
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 && sleeper.requested.count == 2 })
        #expect(sleeper.requested.last == .milliseconds(20_000))
        clock.advance(seconds: 21)
        token.receive(.token("tok-2"), generation: token.generation)
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 2)
    }

    // MARK: leaving the screen stops the timer, the wait for a token and the held password

    @Test func leavingTheScreenStopsTheTimerAndLetsTheHeldPasswordGo() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken(now: clock.function)
        let (model, sleeper) = await waitingWithTimer(fake, token: token, confirmed: true)
        #expect(model.isHoldingPassword)
        model.leaveWait()
        #expect(!model.isHoldingPassword)
        #expect(!model.isWaitingForConfirmation)
        #expect(!model.canCheckConfirmation)
        #expect(sleeper.pendingCount == 0)
        // The timer ringing after that (it cannot, but were it to), a token that comes later, a return and a press: nothing is sent.
        clock.advance(seconds: 100)
        #expect(!sleeper.fireOldest())
        token.receive(.token("tok-late"), generation: token.generation)
        await model.tokenArrived()
        await model.checkConfirmation()
        await model.checkConfirmation(pressed: true)
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await fake.count("POST", "token") == 0)
    }

    @Test func aPressWaitingForItsTokenSendsNothingWhenTheScreenIsLeft() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken(now: clock.function)
        let (model, _) = await waitingWithTimer(fake, token: token, confirmed: true)
        let press = Task { await model.checkConfirmation(pressed: true) }
        // In its wait for the token (the widget has not been tapped), not before it.
        #expect(await waitFor(.seconds(3)) { await MainActor.run { model.isWorking } })
        model.leaveWait()
        await press.value
        #expect(await fake.count("POST", "token") == 0)
        #expect(!model.isWorking)
        #expect(!model.isHoldingPassword)
    }

    @Test func leavingTheScreenBeforeTheAnswerReadsNoAnswer() async {
        let fake = FakeSupabase.make()
        let (model, _) = await waitingWithTimer(fake, confirmed: nil)
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        let first = Task { await model.checkConfirmation() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        model.leaveWait()
        gate.open()
        await first.value
        #expect(!model.isWaitingForConfirmation)
        #expect(!model.isHoldingPassword)
        #expect(model.errorMessage == nil)
    }

    @Test func theSignInOfTheWaitingScreenIsMarkedForTheLandingAndTheFormsIsNot() async throws {
        let fake = FakeSupabase.make()
        let (model, auth) = make(fake)
        await signUp(model)
        await account(fake, confirmed: true)
        await model.checkConfirmation()
        let hand = try #require(auth.takeSignInSecret())
        #expect(hand.fromConfirmation)

        let plain = FakeSupabase.make()
        await plain.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        let (form, formAuth) = make(plain)
        form.password = PW.good
        await form.submit()
        let formHand = try #require(formAuth.takeSignInSecret())
        #expect(!formHand.fromConfirmation)
    }

    // MARK: a key that does not open or cannot be made, after the waiting screen's sign-in

    @Test func theBoxWordsAreTheKeyNotOpenedSentenceOrTheFailuresOwn() {
        #expect(KeyBox.text(for: .needsWebLogin) == "このパスワードでは、メールの鍵を開けませんでした。")
        #expect(KeyBox.text(for: .needsWebLogin) == LoginText.keyNotOpened)
        #expect(KeyBox.text(for: .failed(message: LoginText.keyFailed)) == LoginText.keyFailed)
        for outcome: KeySetupOutcome? in [nil, .opened(keyID: "k"), .created(keyID: "k"), .stale, .addressMismatch] {
            #expect(KeyBox.text(for: outcome) == nil, "\(String(describing: outcome))")
        }
        #expect(OnboardingText.keyBoxProceed == "このまま進む")
        #expect(OnboardingText.keyBoxKeyPage == "パスワードとメールの鍵")
        #expect(OnboardingText.keyBoxKeyPage == SettingsMenuText.keyTitle)
    }

    @Test func theLandingShowsTheBoxOnlyForTheWaitingScreensSignInAndOnlyOnce() {
        for outcome: KeySetupOutcome in [.needsWebLogin, .failed(message: LoginText.keyFailed)] {
            #expect(Landing.of(deciding: false, outcome: outcome, guideClosed: false, fromConfirmation: true) == .keyBox)
            // Not the box: an ordinary sign-in (its failure is the unlock screen's), or the box already left.
            #expect(Landing.of(deciding: false, outcome: outcome, guideClosed: false, fromConfirmation: false) == .tabs)
            #expect(Landing.of(deciding: false, outcome: outcome, guideClosed: false, fromConfirmation: true, boxClosed: true) == .tabs)
            #expect(Landing.of(deciding: true, outcome: outcome, guideClosed: false, fromConfirmation: true) == .waiting)
        }
        // A key opened or made goes on as before.
        #expect(Landing.of(deciding: false, outcome: .created(keyID: "k"), guideClosed: false, fromConfirmation: true) == .guide)
        #expect(Landing.of(deciding: false, outcome: .opened(keyID: "k"), guideClosed: false, fromConfirmation: true) == .tabs)
    }

    @Test func theKeyStepRemembersWhichSignInItWasAndTheBoxFollowsIt() async throws {
        let w = try await KeySetupTests.World()
        _ = try await w.plantKeyInUse(master: Data(repeating: 9, count: 32))
        var fromWaiting = w.signIn
        fromWaiting.fromConfirmation = true
        let outcome = await w.setup.run(fromWaiting)
        #expect(outcome == .needsWebLogin)
        #expect(w.setup.lastRunFromConfirmation)
        #expect(Landing.of(deciding: false, outcome: w.setup.lastOutcome, guideClosed: false, fromConfirmation: w.setup.lastRunFromConfirmation) == .keyBox)
        // The same failure after an ordinary sign-in: the tabs (and the unlock screen's help), no box.
        await w.setup.run(w.signIn)
        #expect(!w.setup.lastRunFromConfirmation)
        #expect(Landing.of(deciding: false, outcome: w.setup.lastOutcome, guideClosed: false, fromConfirmation: w.setup.lastRunFromConfirmation) == .tabs)
    }

    @Test func theBoxsTwoLinksGoToTheParcelsAndToTheKeyPage() {
        var route = TabRoute()
        route.tab = .spend
        route.showKey()
        #expect(route.tab == .settings)
        #expect(route.settingsPath == [.key])
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

    // MARK: review fixes (S1 to S4)

    @Test func anAutoTryRefusedForCredentialsLeavesNoSentNoticeOnTheSignInForm() async {
        let fake = FakeSupabase.make()
        let (model, _) = make(fake)
        await signUp(model)
        // The sign-up's own sentence is the notice now (it was kept behind the waiting screen).
        #expect(model.notice == LoginText.signupExistsOrSent)
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: "someone-elses", confirmed: true)
        await model.checkConfirmation()
        #expect(!model.isWaitingForConfirmation)
        #expect(model.mode == .signIn)
        // The registered address's own sentence replaces the ordinary credentials words here (ExistingAddressTests).
        #expect(model.isExistingAddress)
        #expect(model.errorMessage == nil)
        // The form says only that: not 「確認のメールを送りました…」.
        #expect(model.notice == nil)
        #expect(model.shownNotice == nil)
    }

    @Test func aResendWaitingForItsTokenSendsNothingWhenTheScreenIsLeft() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken(now: clock.function)
        let (model, _) = await waitingWithTimer(fake, token: token, confirmed: nil)
        let resend = Task { await model.resendConfirmation() }
        // In its wait for the token (the widget has not been tapped).
        #expect(await waitFor(.seconds(3)) { await MainActor.run { model.isWorking } })
        model.leaveWait()
        await resend.value
        #expect(await fake.count("POST", "resend") == 0)
        #expect(model.toast == nil)
        #expect(model.notice == nil)
        #expect(!model.isWorking)
    }

    @Test func comingBackToTheFrontWithATokenHeldAlwaysLeavesOneTimer() async {
        let fake = FakeSupabase.make()
        let token = TurnstileToken(now: clock.function)
        let (model, sleeper) = await waitingWithTimer(fake, token: token)
        token.receive(.token("tok-held"), generation: token.generation)
        model.isInFront = false
        #expect(sleeper.pendingCount == 0)
        model.isInFront = true
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        // The token was not used up by it.
        #expect(token.hasToken)
        try? await Task.sleep(for: .milliseconds(200))
        #expect(sleeper.pendingCount == 1)
    }

    @Test func aReturnWhileATryIsOnItsWayStillLeavesTheTimerAfterIt() async {
        let fake = FakeSupabase.make()
        let (model, sleeper) = await waitingWithTimer(fake, confirmed: true)
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        let first = Task { await model.checkConfirmation() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        // Background and front again meanwhile: a timer is there (it will see the try on its way and wait its turn).
        model.isInFront = false
        model.isInFront = true
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 })
        gate.open()
        await first.value
    }

    /// The key step of a password sign-in held on the user_keys read (a stalled network), with the landing's sleep injected.
    private func stalledSignIn(sleeper: ControlledSleeper, gate: Gate, fromConfirmation: Bool = true) async throws -> (screens: MainScreens, fake: FakeSupabase) {
        let fake = FakeSupabase.make()
        let server = FakeKeysServer.make(supabase: fake)
        await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good))
        await fake.fail("GET", "user_keys", with: .hold(gate))
        let auth = PW.auth(fake)
        let parts = MainScreens.KeyParts(
            policy: KeyStorePolicy(defaults: scratchDefaults()),
            keychain: FakeKeychain(),
            biometrics: FakeBiometrics(.available(.faceID)),
            service: "com.iwakisyogo.otodoke.auth",
            api: KeyAPIClient(baseURL: server.baseURL, session: server.urlSession),
            landingSleep: sleeper.sleep
        )
        let made = Box<MainScreens>()
        auth.makeSignedIn = { a in
            let screens = MainScreens.live(auth: a, keyParts: parts)
            made.value = screens
            return screens
        }
        await auth.start()
        try await auth.signIn(email: FakeSupabase.email, password: PW.good, captchaToken: nil, fromConfirmation: fromConfirmation)
        return (try #require(made.value), fake)
    }

    @Test func aStalledKeyStepLetsTheLandingGoAfterThirtySeconds() async throws {
        let sleeper = ControlledSleeper()
        let gate = Gate()
        let w = try await stalledSignIn(sleeper: sleeper, gate: gate)
        let setup = try #require(w.screens.keySetup)
        #expect(setup.isDeciding)
        #expect(await waitFor(.seconds(5)) { sleeper.pendingCount == 1 })
        #expect(sleeper.requested == [.seconds(30)])
        #expect(KeySetup.landingLimit == .seconds(30))
        // The time limit passes: the waiting display goes, the tabs show, the key step carries on.
        #expect(sleeper.fireOldest())
        #expect(await waitFor(.seconds(5)) { await MainActor.run { !setup.isDeciding } })
        #expect(setup.landingGaveUp)
        #expect(Landing.of(deciding: setup.isDeciding, outcome: setup.lastOutcome, guideClosed: false, fromConfirmation: true, gaveUp: setup.landingGaveUp) == .tabs)
        // The key step ends later (the first key is made): neither the guide nor the box comes over the tabs.
        gate.open()
        #expect(await waitFor(.seconds(10)) { await MainActor.run { setup.lastOutcome != nil } })
        #expect(Landing.of(deciding: setup.isDeciding, outcome: setup.lastOutcome, guideClosed: false, fromConfirmation: true, gaveUp: setup.landingGaveUp) == .tabs)
        // The hold was let go once: it did not go below none when the step ended.
        #expect(!setup.isDeciding)
        setup.holdLanding()
        #expect(setup.isDeciding)
    }

    @Test func aKeyStepThatEndsInTimeCancelsTheLimitAndNeverGivesUpAndItsOutcomeIsStillTold() async throws {
        let sleeper = ControlledSleeper()
        let gate = Gate()
        let w = try await stalledSignIn(sleeper: sleeper, gate: gate)
        let setup = try #require(w.screens.keySetup)
        #expect(await waitFor(.seconds(5)) { sleeper.pendingCount == 1 })
        gate.open()
        #expect(await waitFor(.seconds(10)) { await MainActor.run { !setup.isDeciding } })
        #expect(!setup.landingGaveUp)
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 0 })
        // What the key step came to (the held read failed with no answer) is still told, since it ended in time: the box.
        #expect(Landing.of(deciding: setup.isDeciding, outcome: setup.lastOutcome, guideClosed: false, fromConfirmation: true, gaveUp: setup.landingGaveUp) == .keyBox)
        // A later hold is not let go by the earlier one's limit.
        setup.holdLanding()
        #expect(!sleeper.fireOldest())
        #expect(setup.isDeciding)
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
