// The view model of LoginView: e-mail → 8-digit code, the error texts, the 60-second resend wait,
// the spinner flag, and the Turnstile token of each send (as the Web's login of 2541793:
// submit-button.tsx and login-errors.ts). LaunchOptions reads the DEBUG-only argument that starts at
// code entry.

import Foundation
import Observation

struct LaunchOptions: Equatable, Sendable {
    /// Set only in DEBUG builds, from the launch argument (the e-mail that follows it).
    var startAtCodeEntryEmail: String?

    init(arguments: [String]) {
        startAtCodeEntryEmail = nil
        #if DEBUG
        // UI tests start at code entry with a code made on the server, so no login mail is sent.
        if let i = arguments.firstIndex(of: "-otodoke-start-at-code"), arguments.indices.contains(i + 1) {
            let address = AuthService.normalizeEmail(arguments[i + 1])
            startAtCodeEntryEmail = address.isEmpty ? nil : address
        }
        #endif
    }

    static var current: LaunchOptions { LaunchOptions(arguments: ProcessInfo.processInfo.arguments) }
}

@MainActor
@Observable
final class LoginModel {
    enum Step: Equatable, Sendable {
        case email
        case code(email: String)
    }

    /// Supabase's max_frequency for the login mail.
    static let resendInterval: TimeInterval = 60
    static let codeLength = 8

    var step: Step = .email
    var email = ""
    var code = ""
    private(set) var isWorking = false
    private(set) var errorMessage: String?

    let auth: AuthService
    /// The Turnstile token of this screen (taken at each send, then reset), and how long a press waits
    /// for it (Turnstile.waitForToken; tests pass a short one). nil: no widget on this screen (batch 1's
    /// tests): a press sends at once, without a token. LoginView always has one.
    private(set) var turnstile: TurnstileToken?
    @ObservationIgnored let tokenWait: Duration
    @ObservationIgnored private let now: @Sendable () -> Date
    private var lastSentAt: Date?
    /// The address the last code went to (normalized).
    private var lastSentTo: String?

    init(
        auth: AuthService,
        launch: LaunchOptions = .current,
        now: @escaping @Sendable () -> Date = { Date() },
        turnstile: TurnstileToken? = nil,
        tokenWait: Duration = Turnstile.waitForToken
    ) {
        self.auth = auth
        self.turnstile = turnstile
        self.tokenWait = tokenWait
        self.now = now
        if let address = launch.startAtCodeEntryEmail {
            email = address
            step = .code(email: address)
        }
    }

    /// True when `code`, read through NFKC (iOS-11: full-width digits are digits), is exactly 8 ASCII digits.
    var canVerify: Bool {
        let digits = Self.normalizeCode(code)
        return digits.utf8.count == Self.codeLength && digits.utf8.allSatisfy { (0x30...0x39).contains($0) }
    }

    /// NFKC, so 「１２３４５６７８」 is "12345678". Other digits (Arabic-Indic, …) stay as they are.
    nonisolated static func normalizeCode(_ raw: String) -> String {
        raw.precomposedStringWithCompatibilityMapping
    }

    /// Whole seconds left before the code may be sent again (rounded up); 0 when it may.
    func resendWaitSeconds() -> Int {
        guard let lastSentAt else { return 0 }
        let left = Self.resendInterval - now().timeIntervalSince(lastSentAt)
        return left > 0 ? Int(left.rounded(.up)) : 0
    }

    /// Sends the code. Back on the address field with the same address before the 60 seconds are
    /// over, nothing is sent: the code already sent is asked for again (Supabase would refuse anyway).
    func sendCode() async {
        let address = AuthService.normalizeEmail(email)
        if address == lastSentTo, resendWaitSeconds() > 0 {
            guard !isWorking else { return }
            errorMessage = nil
            code = ""
            step = .code(email: address)
            // [S3] A new step shows a new widget: the old one's token is not kept.
            turnstile?.reset()
            return
        }
        await send(to: email)
    }

    func verify() async {
        guard case let .code(address) = step, canVerify, !isWorking else { return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await auth.verifyCode(email: address, code: Self.normalizeCode(code))
        } catch {
            errorMessage = error.message
        }
    }

    /// Sends the code again to the same address, only once the wait is over.
    func resend() async {
        guard case let .code(address) = step, resendWaitSeconds() == 0 else { return }
        await send(to: address)
    }

    /// Back to the address field (a typo in the address).
    func changeAddress() {
        guard !isWorking else { return }
        step = .email
        code = ""
        errorMessage = nil
        // [S3] A new step shows a new widget: the old one's token is not kept.
        turnstile?.reset()
    }

    /// One send. A press without a token waits for one (the spinner shows), at most `tokenWait`, unless
    /// the widget could not load; then it sends with or without one (Supabase decides; it ignores a
    /// missing token while its CAPTCHA is off). The token is taken at the start (never sent twice), and
    /// after the send, whatever its outcome, the widget is reset for a new one. No wait and nothing taken
    /// for an invalid address (nothing is sent).
    private func send(to raw: String) async {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        let address = AuthService.normalizeEmail(raw)
        guard AuthService.isValidEmail(address) else {
            errorMessage = LoginError.invalidEmail.message
            return
        }
        var captchaToken: String?
        if let turnstile {
            if !turnstile.isSettled {
                _ = await turnstile.waitUntilSettled(timeout: tokenWait)
            }
            captchaToken = turnstile.take()
        }
        do {
            try await auth.sendCode(email: raw, captchaToken: captchaToken)
            lastSentAt = now()
            lastSentTo = address
            code = ""
            step = .code(email: address)
        } catch {
            errorMessage = error.message
        }
        turnstile?.reset()
    }
}

#if DEBUG
extension LoginModel {
    /// DEBUG only: the screen check's model gets a widget too (nothing it sends reaches a server).
    func debugUseTurnstile() {
        if turnstile == nil { turnstile = TurnstileToken() }
    }

    /// DEBUG only: a given step, for checking the screen on the simulator (nothing is sent).
    func debugShow(step: Step, email: String, code: String = "", sentSecondsAgo: TimeInterval? = nil, error: String? = nil) {
        self.step = step
        self.email = email
        self.code = code
        lastSentAt = sentSecondsAgo.map { now().addingTimeInterval(-$0) }
        lastSentTo = sentSecondsAgo == nil ? nil : AuthService.normalizeEmail(email)
        errorMessage = error
    }
}
#endif

extension LoginModel {
    /// [S3] The Turnstile widget is shown: always on the address step; on the code step only when a code
    /// may be sent again (resendWaitSeconds() == 0), just above 「コードをもう一度送る」.
    var showsWidget: Bool {
        switch step {
        case .email: true
        case .code: resendWaitSeconds() == 0
        }
    }
}
