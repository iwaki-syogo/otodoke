// The view model of LoginView (password-v1): sign in with the password, or make an account; the Web's words
// for each answer (LoginText); 「確認のメールを送りました。…」 after making an account; after not_confirmed, the
// confirmation mail again; the rule of a new password on the password as typed; one press at a time; the
// Turnstile token of each press (taken once, the widget reset after every press, sent without one when none
// came in time: Supabase decides while its CAPTCHA is off). The password stays in this model's memory only and
// is cleared after every press that reached Supabase.
// After making an account the model waits for the confirmation mail: the address and the typed password are held
// in this model's memory only (never the Keychain, the defaults or a file, never logged), the screen shows the
// waiting state, and the existing password sign-in is tried when the app comes back to the front or the button is
// pressed (checkConfirmation). not_confirmed is a quiet wait. Starting over, or switching the form, drops the
// password.

import Foundation
import Observation

/// The launch arguments the login screen reads. None since the code login went; kept so the callers stay put.
struct LaunchOptions: Equatable, Sendable {
    init(arguments: [String]) {}

    static var current: LaunchOptions { LaunchOptions(arguments: ProcessInfo.processInfo.arguments) }
}

@MainActor
@Observable
final class LoginModel {
    /// The form shown: sign in with the password, or make an account.
    enum Mode: Equatable, Sendable {
        case signIn
        case signUp
    }

    var mode: Mode = .signIn
    /// N6: an address changed after not_confirmed drops the resend offer (it was for the address before).
    var email = "" {
        didSet {
            // An address rewritten drops the guidance of the registered address (it was for the address before).
            if existingAddress != nil, PasswordV1.emailNorm(email) != existingAddress { existingAddress = nil }
            guard canResendConfirmation, PasswordV1.emailNorm(email) != unconfirmedAddress else { return }
            canResendConfirmation = false
            unconfirmedAddress = nil
        }
    }
    /// The address (email_norm) the waiting screen's sign-in was refused for as credentials: Supabase answers a
    /// sign-up for a registered address with "sent" and sets no new password. non-nil while the sign-in form shows
    /// the guidance (OnboardingText.existingAddress, the link to the reset, resetLosesMail). Dropped by the next
    /// press of the login, a rewritten address, switching the form, starting over and leaving the screen.
    @ObservationIgnored private var existingAddress: String? {
        didSet { isExistingAddress = existingAddress != nil }
    }
    /// The sign-in form draws the guidance of an address that is already registered.
    private(set) var isExistingAddress = false
    /// Only in this model's memory; cleared after every press, and when the form changes.
    var password = ""
    /// The sign-up form's second field.
    var passwordAgain = ""
    private(set) var isWorking = false
    private(set) var errorMessage: String?
    /// 「確認のメールを送りました。…」 (not an error).
    private(set) var notice: String?
    /// true after a not_confirmed sign-in: the confirmation mail can be sent again.
    private(set) var canResendConfirmation = false
    /// The address the confirmation mail was sent to after making an account (email_norm); non-nil while the
    /// screen waits for the confirmation. The password typed with it is held in `heldPassword` (memory only).
    private(set) var confirmationAddress: String?
    /// Waiting for the confirmation mail's link (after making an account).
    var isWaitingForConfirmation: Bool { confirmationAddress != nil }
    /// The password typed on the sign-up form, for the sign-in after the mail's link. Memory only; never stored,
    /// logged or sent anywhere but the sign-in; nil once used, and when the wait is dropped.
    @ObservationIgnored private var heldPassword: String?

    let auth: AuthService
    /// The Turnstile token of this screen (taken at each press, then reset), and how long a press waits for it
    /// (Turnstile.waitForToken; tests pass a short one). nil: no widget (a press sends at once, without a token).
    /// LoginView always has one.
    private(set) var turnstile: TurnstileToken?
    @ObservationIgnored let tokenWait: Duration
    @ObservationIgnored private let now: @Sendable () -> Date
    /// 「送り直しました」: a toast that goes by itself after a few seconds (not a box that stays).
    private(set) var toast: String?
    /// How long the toast stays.
    static let toastSeconds = 3
    @ObservationIgnored private let sleep: @Sendable (Duration) async throws -> Void
    @ObservationIgnored private var toastTask: Task<Void, Never>?
    /// The app is in front (set by the screen from the scene phase): the timer runs only then (the Web's visible tab).
    @ObservationIgnored var isInFront = true {
        // Back in front there is always one timer (the Web: shown again, the timer starts anew); in the background none.
        didSet { if isInFront { scheduleAuto() } else { cancelTimer() } }
    }
    /// The one timer that tries at the next point of the backoff while the app is in front: never two.
    @ObservationIgnored private var timerTask: Task<Void, Never>?
    @ObservationIgnored private let timerSleep: @Sendable (Duration) async throws -> Void
    /// Moves on whenever a wait is let go (leaving the screen, starting over, switching the form): an answer or a
    /// token that arrives for an earlier wait is not read.
    @ObservationIgnored private var waitEpoch = 0
    /// The tries by itself of this waiting screen (AutoSignInGate): made anew when a wait begins.
    @ObservationIgnored private var autoGate = AutoSignInGate(now: Date())
    /// The address the last not_confirmed sign-in was for (email_norm).
    @ObservationIgnored private var unconfirmedAddress: String?

    init(
        auth: AuthService,
        launch: LaunchOptions = .current,
        now: @escaping @Sendable () -> Date = { Date() },
        turnstile: TurnstileToken? = nil,
        tokenWait: Duration = Turnstile.waitForToken,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        timerSleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.sleep = sleep
        self.timerSleep = timerSleep
        self.auth = auth
        self.turnstile = turnstile
        self.tokenWait = tokenWait
        self.now = now
    }

    /// https://otodoke.app/login/forgot, opened in Safari.
    var forgotPasswordURL: URL { LoginText.forgotPasswordURL }

    /// Switches the form: the error, the notice, both password fields and the resend offer are cleared, the
    /// address is kept, the widget is reset.
    func setMode(_ mode: Mode) {
        guard !isWorking else { return }
        self.mode = mode
        password = ""
        passwordAgain = ""
        errorMessage = nil
        notice = nil
        canResendConfirmation = false
        unconfirmedAddress = nil
        existingAddress = nil
        dropWait()
        turnstile?.reset()
    }

    /// 「別のアドレスでやり直す」: the wait for the confirmation is dropped (the password with it) and the sign-up form
    /// is shown again, empty: the address is let go too (it was the wrong one).
    func startOver() {
        guard !isWorking else { return }
        setMode(.signUp)
        email = ""
    }

    /// The button 「確認しました」 can be pressed: waiting, with the password still held, and nothing in flight.
    var canCheckConfirmation: Bool {
        !isWorking && isWaitingForConfirmation && heldPassword != nil
    }

    /// The password typed on the sign-up form is still held (tests: it is let go when the screen is left).
    var isHoldingPassword: Bool { heldPassword != nil }

    /// The notice to draw: while waiting, the sign-up's own sentence gives way to the waiting state's words.
    var shownNotice: String? {
        isWaitingForConfirmation && notice == LoginText.signupExistsOrSent ? nil : notice
    }

    /// Shows `text` as a toast and takes it away after `toastSeconds`.
    private func showToast(_ text: String) {
        toast = text
        toastTask?.cancel()
        let sleep = self.sleep
        toastTask = Task { [weak self] in
            try? await sleep(.seconds(Self.toastSeconds))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    /// The timer: set anew for the next point of the backoff, only while waiting, below the limit and with the app in
    /// front; one at a time (a new one replaces the old). Where the point is later (a refusal's wait, a press) it
    /// sleeps until then. It tries once and sets no other by itself: the end of that try sets the next.
    private func scheduleAuto() {
        cancelTimer()
        guard isWaitingForConfirmation, heldPassword != nil, isInFront, let at = autoGate.nextTimedAt() else { return }
        let ms = max(0, Int((at.timeIntervalSince(now()) * 1000).rounded(.up)))
        let sleep = timerSleep
        let epoch = waitEpoch
        timerTask = Task { [weak self] in
            try? await sleep(.milliseconds(ms))
            guard !Task.isCancelled, let self, self.waitEpoch == epoch else { return }
            self.timerTask = nil
            guard self.isInFront, self.isWaitingForConfirmation else { return }
            await self.check(.timer)
        }
    }

    private func cancelTimer() {
        timerTask?.cancel()
        timerTask = nil
    }

    private func dropWait() {
        waitEpoch += 1
        cancelTimer()
        toastTask?.cancel()
        toast = nil
        confirmationAddress = nil
        heldPassword = nil
        autoGate = AutoSignInGate(now: now())
        resetTapLimits()
    }

    /// The screen is left (closed, gone back from, the app ending): the timer, the wait for a token and the held
    /// password all stop. Nothing is sent after this, whatever fires or arrives later. The Web's waiting screen left
    /// these running; here they are stopped and fixed by tests.
    func leaveWait() {
        existingAddress = nil
        guard isWaitingForConfirmation || timerTask != nil || heldPassword != nil else { return }
        dropWait()
        canResendConfirmation = false
        unconfirmedAddress = nil
        turnstile?.reset()
    }

    /// The new password's problem on the sign-up form (PasswordRule on the password as typed); nil on the
    /// sign-in form and while the password is empty.
    var passwordProblem: String? {
        guard mode == .signUp, !password.isEmpty else { return nil }
        return PasswordRule.problem(password: password, again: passwordAgain)
    }

    /// The button can be pressed: an address and a password (and on the sign-up form, no passwordProblem).
    var canSubmit: Bool {
        guard !isWorking, !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !password.isEmpty else { return false }
        return mode == .signIn || passwordProblem == nil
    }

    /// Signs in or makes the account, one press at a time, with the Turnstile token of this press.
    func submit() async {
        guard !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        notice = nil
        existingAddress = nil
        let mode = self.mode
        let address = PasswordV1.emailNorm(email)
        guard AuthService.isValidEmail(address) else {
            errorMessage = LoginText.invalidEmail
            return
        }
        if mode == .signUp {
            guard AuthService.isASCIIAddress(address) else {
                errorMessage = LoginText.emailNotAscii
                return
            }
            if let problem = PasswordRule.problem(password: password, again: passwordAgain) {
                errorMessage = problem
                return
            }
        }
        let typed = password
        let captchaToken = await takeToken()
        password = ""
        passwordAgain = ""
        do {
            switch mode {
            case .signIn:
                try await auth.signIn(email: address, password: typed, captchaToken: captchaToken)
                canResendConfirmation = false
                unconfirmedAddress = nil
            case .signUp:
                let outcome = try await auth.signUp(email: address, password: typed, captchaToken: captchaToken)
                if outcome == .existing {
                    // The address has an account: no mail was sent and the password typed was not set. No wait and no
                    // held password: the sign-in form with the guidance of a registered address, the address kept.
                    // Anything still waiting from an earlier sign-up is let go too (as the credentials answer does).
                    dropWait()
                    self.mode = .signIn
                    existingAddress = address
                    canResendConfirmation = false
                    unconfirmedAddress = nil
                    break
                }
                notice = LoginText.signupExistsOrSent
                // Wait for the mail's link; the mail can be sent again from the waiting screen.
                confirmationAddress = address
                heldPassword = typed
                autoGate = AutoSignInGate(now: now())
                resetTapLimits()
                canResendConfirmation = true
                unconfirmedAddress = address
            }
        } catch {
            errorMessage = error.message
            if mode == .signIn, error == .notConfirmed {
                canResendConfirmation = true
                unconfirmedAddress = address
            }
        }
        turnstile?.reset()
        scheduleAuto()
    }

    /// What tries the sign-in of the waiting screen: the button, the app shown again, a Turnstile token that came
    /// while waiting, or the timer at the next point of the backoff. A token of a person's tap (see tokenArrived)
    /// is not `.token`: it is handled as `.press`.
    enum ConfirmTrigger: Equatable, Sendable {
        case press, returned, token, timer
    }

    /// The button (`pressed`), or the app shown again (the default).
    func checkConfirmation(pressed: Bool = false) async {
        await check(pressed ? .press : .returned)
    }

    /// The least gap between two tries made at once for a tap. Cloudflare does not promise that a token after
    /// before-interactive-callback is a person's, and a tap's try counts as a press (not against the limit of 5, no
    /// wider gap), so a widget that kept giving marked tokens by itself would send without end: a tap within this
    /// gap of the last such try is left to the timer.
    static let tapMinGapSeconds: TimeInterval = 5
    /// The most tries made at once for a tap in one wait (the same reason; the button itself is never limited).
    static let tapMaxPerWait = 10
    @ObservationIgnored private var tapSends = 0
    @ObservationIgnored private var lastTapAt: Date?

    private func resetTapLimits() {
        tapSends = 0
        lastTapAt = nil
    }

    /// A Turnstile token came while waiting. When a person tapped the check (the widget had asked for a tap), it
    /// is handled as a press of 「確認しました」 at once, once: not counted, no wider gap, whatever the timer's point
    /// (the tap said "now"), within tapMinGapSeconds and tapMaxPerWait. While another try is under way the mark is
    /// kept and the tap is tried when that one is over. A token that came by itself waits for the timer's point.
    func tokenArrived() async {
        guard let turnstile, turnstile.hasTap, confirmationAddress != nil, heldPassword != nil else {
            await check(.token)
            return
        }
        // Not taken yet: the mark stays, and pickUpTap() (the end of that try) answers it.
        guard !isWorking else { return }
        if tapSends >= Self.tapMaxPerWait || lastTapAt.map({ now().timeIntervalSince($0) < Self.tapMinGapSeconds }) == true {
            turnstile.clearTap()
            await check(.token)
            return
        }
        turnstile.clearTap()
        tapSends += 1
        lastTapAt = now()
        await check(.press)
    }

    /// The end of a try: a person's tap that came during it is tried now.
    private func pickUpTap() async {
        guard turnstile?.hasTap == true, !isWorking, isWaitingForConfirmation, isInFront else { return }
        await tokenArrived()
    }

    /// While waiting for the confirmation (after making an account): tries the existing password sign-in. The
    /// credentials answer ends the wait: the sign-in form with the Web's words. One try at a time. Not confirmed
    /// is a quiet wait.
    ///  - `.press`: the words on the screen are cleared, the Turnstile token is waited for (as a press of the login
    ///    does), a still unconfirmed address says so, a captcha refusal says so. Always tries, is not counted, does
    ///    not widen the gap; it cancels the timer and the next timed try is a gap on from the press.
    ///  - the rest are tries by itself (the Web's numbers, AutoSignIn): they never wait for a token (nobody is asked to
    ///    tap for a try they did not press for: with none there is nothing to send, and the tap that brings one
    ///    tries at once), drop a token older than Turnstile.tokenStaleMs, leave the words on the screen as they are
    ///    and say nothing about a captcha refusal (it tries once more when a fresh token is there).
    ///  - a return tries at once unless the limit is used up or a refusal's wait runs (the timer then tries when it
    ///    ends); two returns within 2 seconds are one. A token tries when the timer's point has come (else the timer
    ///    does). The timer tries at its point.
    private func check(_ trigger: ConfirmTrigger) async {
        await checkOnce(trigger)
        await pickUpTap()
    }

    private func checkOnce(_ trigger: ConfirmTrigger) async {
        guard let address = confirmationAddress, let typed = heldPassword, !isWorking else { return }
        let pressed = trigger == .press
        let epoch = waitEpoch
        var captchaToken: String?
        if pressed {
            isWorking = true
            errorMessage = nil
            notice = nil
            cancelTimer()
            autoGate.pressed(now: now())
        } else {
            if trigger == .returned, !autoGate.noteReturn(now: now()) {
                // The second notice of one return: the first set the timer (or its try will), unless it was lost.
                if timerTask == nil { scheduleAuto() }
                return
            }
            guard autoGate.allows(now: now()) else {
                scheduleAuto()
                return
            }
            if trigger == .token, let at = autoGate.nextTimedAt(), now() < at {
                scheduleAuto()
                return
            }
            let got = takeTokenForAutoTry()
            guard got.send else { return }
            captchaToken = got.token
            cancelTimer()
            autoGate.begin(now: now())
            autoGate.countSend()
            isWorking = true
        }
        defer { isWorking = false }
        if pressed {
            captchaToken = await takeToken()
            // The screen was left while the token was waited for: nothing is sent.
            guard epoch == waitEpoch, heldPassword != nil else { return }
        }
        var failure = await signInOnce(address: address, typed: typed, captchaToken: captchaToken)
        // A try by itself refused for its token (it ran out while the app was away): once more, if the widget has
        // a fresh one by now (Turnstile renews an expired token); else the next tap tries again.
        if !pressed, failure == .captcha, epoch == waitEpoch, autoGate.sends < AutoSignIn.max, let fresh = turnstile?.take() {
            autoGate.countSend()
            failure = await signInOnce(address: address, typed: typed, captchaToken: fresh)
        }
        turnstile?.resetUnlessTapHeld()
        guard let failure else {
            // Signed in (the screens come up from AuthService's state): the password is not needed any more.
            cancelTimer()
            heldPassword = nil
            canResendConfirmation = false
            unconfirmedAddress = nil
            return
        }
        // The wait was let go meanwhile (left, started over): the answer is not read.
        guard epoch == waitEpoch else { return }
        switch failure {
        case .notConfirmed:
            if pressed { notice = OnboardingText.notConfirmedYet } else { autoGate.refusedNotConfirmed() }
        case .credentials:
            dropWait()
            // A tap held for this try goes with the wait (the other ends of a wait reset the widget themselves).
            turnstile?.reset()
            mode = .signIn
            canResendConfirmation = false
            unconfirmedAddress = nil
            // The sign-up's 「確認のメールを送りました…」 does not belong on the form it leaves for.
            notice = nil
            // The address had an account already: the sentence says so, in place of the ordinary credentials words.
            errorMessage = nil
            existingAddress = address
            return
        case .captcha where !pressed:
            // Silent, and no 60 seconds of waiting (difference 2 in AutoSignIn.swift): the tap on the widget gives a
            // token and tries at once.
            break
        default:
            errorMessage = failure.message
            autoGate.refused(now: now())
        }
        scheduleAuto()
    }

    private func signInOnce(address: String, typed: String, captchaToken: String?) async -> LoginFailure? {
        do {
            try await auth.signIn(email: address, password: typed, captchaToken: captchaToken, fromConfirmation: true)
            return nil
        } catch {
            return error
        }
    }

    /// The token for a try by itself, as the Web's tokenForAutoAttempt: no widget sends at once without one; a
    /// token past Turnstile.tokenStaleMs is dropped and the widget moved on (it needs a new tap); with a token it is
    /// taken; with none nothing is sent (the widget's tap brings one, and the screen tries then).
    private func takeTokenForAutoTry() -> (send: Bool, token: String?) {
        guard let turnstile else { return (true, nil) }
        if turnstile.dropIfStale() { turnstile.reset() }
        if let token = turnstile.take() { return (true, token) }
        return (false, nil)
    }

    /// After not_confirmed: the confirmation mail again (the same answer for every address). While waiting after
    /// making an account the notice is 「送り直しました」.
    func resendConfirmation() async {
        await resendOnce()
        await pickUpTap()
    }

    private func resendOnce() async {
        guard canResendConfirmation, let address = unconfirmedAddress, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        notice = nil
        let epoch = waitEpoch
        let captchaToken = await takeToken()
        // The screen was left (or started over) while the token was waited for: nothing is sent, nothing is said.
        guard epoch == waitEpoch else { return }
        do {
            try await auth.resendConfirmation(email: address, captchaToken: captchaToken)
            if isWaitingForConfirmation {
                showToast(OnboardingText.resent)
            } else {
                notice = LoginText.confirmationSent
            }
        } catch {
            errorMessage = error.message
        }
        turnstile?.resetUnlessTapHeld()
        // A timed try that met this request on its way was dropped: the next point is set again.
        scheduleAuto()
    }

    /// The token of this press: waits for one (at most `tokenWait`) unless the widget could not load, then takes
    /// it (each token is sent once). nil without a widget.
    private func takeToken() async -> String? {
        guard let turnstile else { return nil }
        // A token past Turnstile.tokenStaleMs is not used (a press too): dropped, the widget moved on (a new tap).
        if turnstile.dropIfStale() { turnstile.reset() }
        if !turnstile.isSettled {
            _ = await turnstile.waitUntilSettled(timeout: tokenWait)
        }
        return turnstile.take()
    }
}

#if DEBUG
extension LoginModel {
    /// DEBUG only: the screen check's model gets a widget too (nothing it sends reaches a server).
    func debugUseTurnstile() {
        if turnstile == nil { turnstile = TurnstileToken() }
    }

    /// DEBUG only: the waiting state after making an account (nothing is sent; the password held is a stand-in).
    func debugShowWaiting(email: String, notice: String? = nil, error: String? = nil) {
        mode = .signUp
        self.email = email
        confirmationAddress = PasswordV1.emailNorm(email)
        heldPassword = "debug-only"
        canResendConfirmation = true
        unconfirmedAddress = PasswordV1.emailNorm(email)
        self.notice = notice
        errorMessage = error
    }

    /// DEBUG only: the sign-in form with the guidance of an address that is already registered (nothing is sent).
    func debugShowExistingAddress(email: String) {
        mode = .signIn
        self.email = email
        existingAddress = PasswordV1.emailNorm(email)
    }

    /// DEBUG only: a given state, for checking the screen on the simulator (nothing is sent).
    func debugShow(mode: Mode, email: String, password: String = "", again: String = "", error: String? = nil, notice: String? = nil, canResend: Bool = false) {
        self.mode = mode
        self.email = email
        self.password = password
        passwordAgain = again
        errorMessage = error
        self.notice = notice
        canResendConfirmation = canResend
        unconfirmedAddress = canResend ? PasswordV1.emailNorm(email) : nil
    }
}
#endif
