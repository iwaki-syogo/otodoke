import Foundation
import Testing
@testable import Otodoke

/// [b7-tap] A Turnstile token that a person made by tapping the check (the widget had asked for a tap) tries the
/// waiting screen's sign-in at once, once, as a press of 「確認しました」 (not counted, no wider gap). A token that came
/// by itself still waits for the timer's point.
@Suite("Waiting screen: a tap on the check tries at once (b7-tap)")
@MainActor
struct TapTokenTests {
    private let clock = TestClock(Date(timeIntervalSince1970: 1_793_000_000))

    private func waiting(_ fake: FakeSupabase, confirmed: Bool? = false) async -> (LoginModel, TurnstileToken, ControlledSleeper) {
        let sleeper = ControlledSleeper()
        let token = TurnstileToken(now: clock.function)
        let auth = PW.auth(fake, storage: InMemorySessionStorage())
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: []), now: clock.function, turnstile: token, tokenWait: .milliseconds(100), sleep: { try await Task.sleep(for: $0) }, timerSleep: sleeper.sleep)
        model.email = FakeSupabase.email
        model.setMode(.signUp)
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        if let confirmed {
            await fake.addPasswordAccount(email: FakeSupabase.email, secret: PW.secret(email: FakeSupabase.email, password: PW.good), confirmed: confirmed)
        }
        _ = await waitFor(.seconds(3)) { sleeper.pendingCount == 1 }
        return (model, token, sleeper)
    }

    private func tap(_ token: TurnstileToken, _ value: String) {
        token.receive(.interactive, generation: token.generation)
        token.receive(.token(value), generation: token.generation)
    }

    @Test func aTapInsideTheGapTriesOnceAtOnceAndWidensNothing() async {
        let fake = FakeSupabase.make()
        let (model, token, sleeper) = await waiting(fake)
        clock.advance(seconds: 5)
        tap(token, "tok-tap")
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 1)
        #expect(PW.captcha(await fake.requests("POST", "token").last) == "tok-tap")
        // Unconfirmed: the press's words, and the gap stays the first one (20 s on from the press).
        #expect(model.shownNotice == OnboardingText.notConfirmedYet)
        #expect(await waitFor(.seconds(3)) { sleeper.pendingCount == 1 && sleeper.requested.count == 2 })
        #expect(sleeper.requested.last == .milliseconds(20_000))
    }

    @Test func tapsAreNotCountedAgainstTheLimitOfFive() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        for i in 1...7 {
            // Past the least gap between two such tries (round 2), so only the limit of 5 is under test here.
            clock.advance(seconds: LoginModel.tapMinGapSeconds + 1)
            tap(token, "tok-\(i)")
            await model.tokenArrived()
            #expect(await fake.count("POST", "token") == i)
        }
    }

    @Test func aTokenThatCameByItselfWaitsForTheTimersPoint() async {
        let fake = FakeSupabase.make()
        let (model, token, sleeper) = await waiting(fake)
        token.receive(.token("tok-auto"), generation: token.generation)
        clock.advance(seconds: 5)
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 0)
        clock.advance(seconds: 15)
        #expect(sleeper.fireOldest())
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        #expect(PW.captcha(await fake.requests("POST", "token").first) == "tok-auto")
    }

    @Test func theMarkIsUsedUpSoTokensWithoutOneDoNotLoop() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        tap(token, "tok-tap")
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 1)
        // The widget was made anew; tokens that come by themselves, one after another, send nothing.
        for i in 1...4 {
            clock.advance(seconds: 1)
            token.receive(.token("tok-auto-\(i)"), generation: token.generation)
            await model.tokenArrived()
        }
        #expect(await fake.count("POST", "token") == 1)
    }

    @Test func theSameMarkAnswersOnlyOnce() {
        let token = TurnstileToken(now: clock.function)
        tap(token, "tok")
        #expect(token.hasTap)
        token.clearTap()
        #expect(!token.hasTap)
        // A second token of the same generation, with no new ask for a tap, is not a tap.
        token.receive(.token("tok-2"), generation: token.generation)
        #expect(!token.hasTap)
    }

    @Test func aTapThenLeavingTheScreenSendsNothing() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        tap(token, "tok-tap")
        model.leaveWait()
        #expect(!token.hasTap)
        await model.tokenArrived()
        // A marked token of the new generation, after the screen was left, is not sent either.
        tap(token, "tok-late")
        await model.tokenArrived()
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await fake.count("POST", "token") == 0)
    }

    // MARK: the review's three cases (b7-tap round 2)

    @Test func aTapDuringATryKeepsItsMarkAndIsTriedWhenThatTryEnds() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        token.receive(.token("tok-auto"), generation: token.generation)
        clock.advance(seconds: 30)
        let first = Task { await model.checkConfirmation() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        #expect(model.isWorking)
        // A person taps while that try is under way: nothing is sent now, the mark is kept.
        tap(token, "tok-tap")
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 1)
        #expect(token.hasTap)
        gate.open()
        await first.value
        // When the try is over the tap is tried, once.
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 2 })
        #expect(PW.captcha(await fake.requests("POST", "token").last) == "tok-tap")
        try? await Task.sleep(for: .milliseconds(200))
        #expect(await fake.count("POST", "token") == 2)
        #expect(!token.hasTap)
    }

    @Test func aTapThatReplacesAHeldTokenIsCountedAsReceivedAndTriedOnce() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        token.receive(.token("tok-auto"), generation: token.generation)
        let before = token.receivedCount
        // The widget asks for a tap while a token is held, then gives a new one: hasToken never turns false, the
        // count is what the screen watches.
        token.receive(.interactive, generation: token.generation)
        token.receive(.token("tok-tap"), generation: token.generation)
        #expect(token.hasToken)
        #expect(token.receivedCount == before + 1)
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 1)
        #expect(PW.captcha(await fake.requests("POST", "token").last) == "tok-tap")
    }

    @Test func aSecondTapWithinTheGapIsLeftToTheTimerAndOneAfterItIsTried() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        tap(token, "tok-1")
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 1)
        clock.advance(seconds: LoginModel.tapMinGapSeconds - 1)
        tap(token, "tok-2")
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 1)
        #expect(!token.hasTap)
        // Negative control: past the gap a tap is tried at once.
        clock.advance(seconds: 2)
        tap(token, "tok-3")
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 2)
        #expect(PW.captcha(await fake.requests("POST", "token").last) == "tok-3")
    }

    @Test func theEleventhTapOfAWaitIsLeftToTheTimer() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        for i in 1...(LoginModel.tapMaxPerWait + 1) {
            clock.advance(seconds: LoginModel.tapMinGapSeconds + 1)
            tap(token, "tok-\(i)")
            await model.tokenArrived()
            #expect(await fake.count("POST", "token") == min(i, LoginModel.tapMaxPerWait), "tap \(i)")
        }
    }

    @Test func theButtonItselfIsNeverLimited() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        for i in 1...(LoginModel.tapMaxPerWait + 2) {
            token.receive(.token("tok-\(i)"), generation: token.generation)
            await model.checkConfirmation(pressed: true)
            #expect(await fake.count("POST", "token") == i, "press \(i)")
        }
    }

    @Test func anAskForATapOfAnotherGenerationMarksNothing() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        token.reset()
        let old = token.generation - 1
        token.receive(.interactive, generation: old)
        token.receive(.token("tok"), generation: token.generation)
        #expect(!token.hasTap)
        clock.advance(seconds: 5)
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 0)
    }

    // MARK: the second review (b7-tap round 3)

    /// A try held at the gate (a token taken, the request waiting), so that a tap can come during it.
    private func heldTry(_ fake: FakeSupabase, _ model: LoginModel, _ token: TurnstileToken) async -> (Task<Void, Never>, Gate) {
        let gate = Gate()
        await fake.fail("POST", "token", with: .hold(gate))
        token.receive(.token("tok-auto"), generation: token.generation)
        clock.advance(seconds: 30)
        let first = Task { await model.checkConfirmation() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        #expect(model.isWorking)
        return (first, gate)
    }

    @Test func aTapKeptDuringATryIsNotSentInTheBackgroundButTheReturnTriesIt() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        let (first, gate) = await heldTry(fake, model, token)
        tap(token, "tok-tap")
        await model.tokenArrived()
        model.isInFront = false
        gate.open()
        await first.value
        try? await Task.sleep(for: .milliseconds(300))
        // In the background nothing is sent when the try ends.
        #expect(await fake.count("POST", "token") == 1)
        // Back in front the return tries, with the token that is held.
        model.isInFront = true
        await model.checkConfirmation()
        #expect(await fake.count("POST", "token") == 2)
        #expect(PW.captcha(await fake.requests("POST", "token").last) == "tok-tap")
    }

    @Test func aSecondTapDuringATapsTryIsHeldToTheGapWhenThatTryEnds() async {
        for waited in [false, true] {
            let fake = FakeSupabase.make()
            let (model, token, _) = await waiting(fake)
            let gate = Gate()
            await fake.fail("POST", "token", with: .hold(gate))
            clock.advance(seconds: 30)
            tap(token, "tok-1")
            let first = Task { await model.tokenArrived() }
            #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
            // The second tap comes during that try; the pick-up at its end goes through the same gap.
            tap(token, "tok-2")
            await model.tokenArrived()
            if waited { clock.advance(seconds: LoginModel.tapMinGapSeconds + 1) }
            gate.open()
            await first.value
            try? await Task.sleep(for: .milliseconds(300))
            // Within the gap: not sent (no chain). Negative control: past the gap it is sent.
            #expect(await fake.count("POST", "token") == (waited ? 2 : 1), "waited \(waited)")
            #expect(!token.hasTap)
        }
    }

    @Test func aTapDuringTheMailBeingSentAgainIsTriedWhenThatEnds() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake)
        let gate = Gate()
        await fake.fail("POST", "resend", with: .hold(gate))
        let resend = Task { await model.resendConfirmation() }
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "resend") == 1 })
        #expect(model.isWorking)
        tap(token, "tok-tap")
        await model.tokenArrived()
        #expect(await fake.count("POST", "token") == 0)
        gate.open()
        await resend.value
        #expect(await waitFor(.seconds(3)) { await fake.count("POST", "token") == 1 })
        #expect(PW.captcha(await fake.requests("POST", "token").last) == "tok-tap")
    }

    @Test func aTapHeldWhenTheWaitEndsForCredentialsLeavesNothingInTheWidget() async {
        let fake = FakeSupabase.make()
        let (model, token, _) = await waiting(fake, confirmed: nil)
        // The sign-in is answered for credentials (the address has an account with another password).
        await fake.forceAuth("password", status: 400, code: "invalid_credentials")
        let (first, gate) = await heldTry(fake, model, token)
        tap(token, "tok-tap")
        await model.tokenArrived()
        #expect(token.hasTap)
        gate.open()
        await first.value
        // The sign-in was refused for credentials: the wait is over, the widget holds no token and no mark.
        #expect(!model.isWaitingForConfirmation)
        #expect(!token.hasToken)
        #expect(!token.hasTap)
        #expect(await fake.count("POST", "token") == 1)
    }

    // MARK: the mark itself

    @Test func theMarkIsClearedByExpiredErrorTimeoutResetAndAnotherGeneration() {
        for event in [TurnstileEvent.expired, .error, .timeout, .unavailable] {
            let token = TurnstileToken(now: clock.function)
            token.receive(.interactive, generation: token.generation)
            token.receive(event, generation: token.generation)
            token.receive(.token("tok"), generation: token.generation)
            #expect(!token.hasTap, "\(event)")
        }
        let reset = TurnstileToken(now: clock.function)
        tap(reset, "tok")
        reset.reset()
        reset.receive(.token("tok-2"), generation: reset.generation)
        #expect(!reset.hasTap)
        let old = TurnstileToken(now: clock.function)
        let first = old.generation
        old.reset()
        old.receive(.interactive, generation: first)
        old.receive(.token("tok"), generation: old.generation)
        #expect(!old.hasTap)
        // Positive control: the same sequence in the current generation is a tap.
        let control = TurnstileToken(now: clock.function)
        tap(control, "tok")
        #expect(control.hasTap)
        // An ask for a tap with no token is no tap.
        let asked = TurnstileToken(now: clock.function)
        asked.receive(.interactive, generation: asked.generation)
        #expect(!asked.hasTap)
    }

    @Test func theWidgetReportsTheAskForATap() {
        func notice(_ kind: String) -> (generation: Int, event: TurnstileEvent)? {
            Turnstile.notice(body: ["generation": 2, "kind": kind] as [String: Any], isMainFrame: true, originProtocol: "https", originHost: "otodoke.app", originPort: 0)
        }
        #expect(notice("interactive")?.event == .interactive)
        #expect(notice("interactive")?.generation == 2)
        // after-interactive-callback clears nothing (its order against `callback` is not documented).
        #expect(notice("interactive-end") == nil)
        #expect(Turnstile.notice(body: ["generation": 2, "kind": "interactive"] as [String: Any], isMainFrame: false, originProtocol: "https", originHost: "otodoke.app", originPort: 0) == nil)
        let html = Turnstile.html(generation: 1)
        #expect(html.contains("before-interactive-callback"))
        #expect(html.contains("after-interactive-callback"))
    }
}
