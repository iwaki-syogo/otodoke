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
            guard canResendConfirmation, PasswordV1.emailNorm(email) != unconfirmedAddress else { return }
            canResendConfirmation = false
            unconfirmedAddress = nil
        }
    }
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
    /// The app is in front (set by the screen from the scene phase): the try at the end of the gap goes only then.
    @ObservationIgnored var isInFront = true
    /// The one try waiting for the end of the 20-second gap (a return inside the gap): never more than one.
    @ObservationIgnored private var catchUpTask: Task<Void, Never>?
    /// The tries by itself of this waiting screen (AutoSignInGate): reset when a new wait begins.
    @ObservationIgnored private var autoGate = AutoSignInGate()
    /// The address the last not_confirmed sign-in was for (email_norm).
    @ObservationIgnored private var unconfirmedAddress: String?

    init(
        auth: AuthService,
        launch: LaunchOptions = .current,
        now: @escaping @Sendable () -> Date = { Date() },
        turnstile: TurnstileToken? = nil,
        tokenWait: Duration = Turnstile.waitForToken,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) {
        self.sleep = sleep
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

    /// A return to the front inside the 20-second gap would do nothing: one try is kept for the end of the gap, if
    /// the screen is still waiting and in front then. It does not keep itself going: that try schedules no other.
    private func scheduleCatchUp() {
        guard catchUpTask == nil, isWaitingForConfirmation, let end = autoGate.gapEnd(now: now()) else { return }
        let ms = Int((end.timeIntervalSince(now()) * 1000).rounded(.up))
        let sleep = self.sleep
        catchUpTask = Task { [weak self] in
            try? await sleep(.milliseconds(ms))
            guard !Task.isCancelled, let self else { return }
            self.catchUpTask = nil
            guard self.isInFront, self.isWaitingForConfirmation else { return }
            await self.checkConfirmation(catchUp: true)
        }
    }

    private func dropWait() {
        catchUpTask?.cancel()
        catchUpTask = nil
        toastTask?.cancel()
        toast = nil
        confirmationAddress = nil
        heldPassword = nil
        autoGate = AutoSignInGate()
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
                try await auth.signUp(email: address, password: typed, captchaToken: captchaToken)
                notice = LoginText.signupExistsOrSent
                // Wait for the mail's link; the mail can be sent again from the waiting screen.
                confirmationAddress = address
                heldPassword = typed
                autoGate = AutoSignInGate()
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
    }

    /// While waiting for the confirmation (after making an account): tries the existing password sign-in, when the
    /// app comes back to the front, when a Turnstile token arrives while waiting, and when 「確認しました」 is
    /// pressed. not_confirmed is a quiet wait (no error). The address having an account with another password
    /// (credentials) ends the wait: the sign-in form with the Web's words. One try at a time.
    /// `pressed`: the button was pressed (not a try by itself):
    ///  - the words on the screen are cleared, the Turnstile token is waited for (as a press of the login does), a
    ///    still unconfirmed address says so, a captcha refusal says so, and it is not rationed or counted;
    ///  - a try by itself is rationed (AutoSignIn, the Web's numbers), never waits for a token (nobody is asked to
    ///    tap for a try they did not press for: with none there is nothing to send, the tap later tries), drops a token
    ///    older than Turnstile.tokenStaleMs, leaves the words on the screen as they are, and says nothing about a
    ///    captcha refusal (it tries once more when a fresh token is there, else waits for the next trigger).
    /// `catchUp`: the try kept for the end of the gap (it schedules no other).
    func checkConfirmation(pressed: Bool = false, catchUp: Bool = false) async {
        guard let address = confirmationAddress, let typed = heldPassword, !isWorking else { return }
        var captchaToken: String?
        if pressed {
            isWorking = true
            errorMessage = nil
            notice = nil
        } else {
            guard autoGate.allows(now: now()) else {
                if !catchUp { scheduleCatchUp() }
                return
            }
            let got = takeTokenForAutoTry()
            guard got.send else { return }
            captchaToken = got.token
            autoGate.begin(now: now())
            autoGate.countSend()
            isWorking = true
        }
        defer { isWorking = false }
        if pressed { captchaToken = await takeToken() }
        var failure = await signInOnce(address: address, typed: typed, captchaToken: captchaToken)
        // A try by itself refused for its token (it ran out while the app was away): once more, if the widget has
        // a fresh one by now (Turnstile renews an expired token); else the next trigger tries again.
        if !pressed, failure == .captcha, autoGate.sends < AutoSignIn.max, let fresh = turnstile?.take() {
            autoGate.countSend()
            failure = await signInOnce(address: address, typed: typed, captchaToken: fresh)
        }
        turnstile?.reset()
        guard let failure else {
            // Signed in (the screens come up from AuthService's state): the password is not needed any more.
            catchUpTask?.cancel()
            catchUpTask = nil
            heldPassword = nil
            canResendConfirmation = false
            unconfirmedAddress = nil
            return
        }
        switch failure {
        case .notConfirmed:
            if pressed { notice = OnboardingText.notConfirmedYet }
        case .credentials:
            dropWait()
            mode = .signIn
            canResendConfirmation = false
            unconfirmedAddress = nil
            errorMessage = failure.message
        case .captcha where !pressed:
            // Silent. No 60 seconds of waiting either: the tap on the widget gives a token and tries at once.
            break
        default:
            errorMessage = failure.message
            autoGate.refused(now: now())
        }
    }

    private func signInOnce(address: String, typed: String, captchaToken: String?) async -> LoginFailure? {
        do {
            try await auth.signIn(email: address, password: typed, captchaToken: captchaToken)
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
        guard canResendConfirmation, let address = unconfirmedAddress, !isWorking else { return }
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        notice = nil
        let captchaToken = await takeToken()
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
        turnstile?.reset()
    }

    /// The token of this press: waits for one (at most `tokenWait`) unless the widget could not load, then takes
    /// it (each token is sent once). nil without a widget.
    private func takeToken() async -> String? {
        guard let turnstile else { return nil }
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
