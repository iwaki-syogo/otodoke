// The sign-in state and the password login of password-v1 (docs/crypto/password-v1.md; the steps of the Web's
// src/lib/login-auth.ts on integrate/password-v1, done against Supabase Auth directly):
//  - the address is email_norm (the five ASCII whitespaces off its ends, A-Z made a-z); the password never
//    leaves the device: master is made from it (PBKDF2 off the main thread) and only auth_secret (64 lowercase
//    hex) is sent as the Supabase password;
//  - making an account and sending the confirmation again carry redirect_to = AppConfig.authRedirect (the
//    Web's confirm page, with its `?`: the mail's link is `{{ .RedirectTo }}&token_hash=…`) and answer the
//    same whether the address has an account or not;
//  - a new account's address must be printable ASCII;
//  - Supabase's errors are read by code and status (never by their text): credentials, not_confirmed, rate,
//    captcha, network, other;
//  - after a sign-in the key step (KeySetup) gets the sign-in's master once (takeSignInSecret). supabase-swift
//    emits .signedIn before signIn returns (A3-1): while a password sign-in is in flight the client's events
//    only move the session generation on; .signedIn is published after the generation and the hand-off
//    (pendingSignIn) are decided. The key step registered for the generation (keyStep) is told then, and
//    takes the hand-off itself when it is made later: whichever comes first, the key step runs once.
//  - the main screens live as long as one signed-in generation (B1-1): made once by makeSignedIn when the
//    generation is published signed in, kept here (signedInObject), dropped when it moves on.

import Auth
import Foundation
import Observation

@MainActor
@Observable
final class AuthService {
    enum State: Equatable, Sendable {
        case unknown
        case signedOut
        case signedIn(userID: String)
    }

    private(set) var state: State = .unknown
    let provider: SupabaseProvider
    @ObservationIgnored private var events: Task<Void, Never>?

    /// The signed-in state's generation (Codex-001). Moves on at sign-out and when the signed-in user
    /// changes; work that started under an older one is thrown away.
    let session = SessionGeneration()
    /// Sign-out's steps ② ③ ④ (the opened key's store). signOut() runs ① (session moves on) and then
    /// cleanup's cancelWork, dropMemory, deleteKeychainKey, in this order.
    @ObservationIgnored var cleanup: (any SignOutCleanup)?

    /// password-v1's master (PBKDF2 off the main thread, one at a time). Tests pass a fast KDF.
    @ObservationIgnored let deriver: PasswordV1Deriver
    /// What the last password sign-in left for the key step, with the session stamp it belongs to.
    @ObservationIgnored private var pendingSignIn: (signIn: PasswordSignIn, stamp: SessionStamp)?
    /// N4: the last password sign-in made no master for the session's address (letters outside ASCII), with
    /// the session stamp it belongs to.
    @ObservationIgnored private var pendingMismatch: SessionStamp?
    /// The key step of the generation (MainScreens.attachKeys): called when a hand-off is decided.
    @ObservationIgnored private var keyStep: (stamp: SessionStamp, start: @MainActor () -> Void)?

    /// A password sign-in is in flight: the client's events only move the generation on (A3-1).
    @ObservationIgnored private var signingIn = 0
    /// The last session the client's events said while a sign-in was in flight (published if it fails).
    @ObservationIgnored private var heldSession: Session??

    /// Makes what lives as long as one signed-in generation (the app's: MainScreens.live). Set at launch.
    @ObservationIgnored var makeSignedIn: (@MainActor (AuthService) -> AnyObject)?
    @ObservationIgnored private var signedInPart: (stamp: SessionStamp, value: AnyObject)?

    /// Tests only: runs once supabase-swift answered a password sign-in, before the hand-off is decided (the
    /// order where the client's .signedIn was handled first).
    @ObservationIgnored var afterSignInAnswer: (@MainActor () async -> Void)?

    init(provider: SupabaseProvider, deriver: PasswordV1Deriver = PasswordV1Deriver()) {
        self.provider = provider
        self.deriver = deriver
    }

    /// Reads the stored session (and follows the client's auth events from then on).
    func start() async {
        receive(provider.auth.currentSession)
        if events == nil {
            let changes = provider.auth.authStateChanges
            events = Task { [weak self] in
                for await change in changes {
                    guard let self else { return }
                    self.receive(change.session)
                }
            }
        }
        if state != .signedOut {
            await checkSession()
        }
    }

    /// Called at launch and when the app comes back: refreshes an expired session; a refresh the
    /// server refuses ends in .signedOut (the login screen).
    func checkSession() async {
        guard provider.auth.currentSession != nil else {
            receive(nil)
            return
        }
        do {
            receive(try await provider.auth.session)
        } catch {
            // A refused refresh token makes the client drop the session; no answer keeps it (offline).
            receive(provider.auth.currentSession)
        }
    }

    // MARK: password-v1

    /// Make an account: email_norm of the address (printable ASCII only, else .emailNotAscii; nothing is sent for
    /// an invalid or non-ASCII address), master off the main thread, then signUp(email: email_norm, password:
    /// auth_secret, redirectTo: AppConfig.authRedirect, captchaToken:). The password's rule is LoginModel's, on
    /// the password as typed. user_already_exists, email_exists, over_email_send_rate_limit and a 429 without a
    /// code answer as sent.
    func signUp(email: String, password: String, captchaToken: String?) async throws(LoginFailure) {
        let address = PasswordV1.emailNorm(email)
        guard Self.isValidEmail(address) else { throw .invalidEmail }
        guard Self.isASCIIAddress(address) else { throw .emailNotAscii }
        var master = try await makeMaster(password: password, email: address)
        defer { master.resetBytes(in: 0..<master.count) }
        let secret = PasswordV1.authSecret(master: master)
        do {
            let answer = try await provider.auth.signUp(email: address, password: secret, redirectTo: AppConfig.authRedirect, captchaToken: Self.token(captchaToken))
            if answer.session != nil {
                // Confirmations turned off would sign this device in here; the app signs in with the password
                // afterwards, as the Web does, so this session is not kept.
                try? await provider.auth.signOut(scope: .local)
            }
        } catch {
            if case .sent = Self.mailRefusal(error) { return }
            if case let .failed(failure) = Self.mailRefusal(error) { throw failure }
        }
    }

    /// signIn(email: email_norm, password: auth_secret, captchaToken:). On success the session is applied, and a
    /// PasswordSignIn is kept for takeSignInSecret() when email_norm of the session's address is the one master
    /// was made with (else a key made now would not open with the address the app has later).
    func signIn(email: String, password: String, captchaToken: String?) async throws(LoginFailure) {
        let address = PasswordV1.emailNorm(email)
        guard Self.isValidEmail(address) else { throw .invalidEmail }
        var master = try await makeMaster(password: password, email: address)
        defer { master.resetBytes(in: 0..<master.count) }
        let secret = PasswordV1.authSecret(master: master)
        let signedIn: Session
        signingIn += 1
        do {
            signedIn = try await provider.auth.signIn(email: address, password: secret, captchaToken: Self.token(captchaToken))
        } catch {
            releaseEvents(publishHeld: true)
            throw Self.signInFailure(error)
        }
        if let afterSignInAnswer {
            self.afterSignInAnswer = nil
            await afterSignInAnswer()
        }
        releaseEvents(publishHeld: false)
        clearPendingSignIn()
        pendingMismatch = nil
        // ① the generation, ② the hand-off, ③ then .signedIn is published (the screens come up after it).
        let userID = signedIn.user.id.uuidString.lowercased()
        session.follow(userID: userID)
        if let stamp = session.stamp(), stamp.userID == userID {
            if let sessionAddress = signedIn.user.email, PasswordV1.emailNorm(sessionAddress) == address {
                pendingSignIn = (PasswordSignIn(userID: userID, email: address, master: Data(master)), stamp)
            } else {
                pendingMismatch = stamp
            }
        }
        publish(signedIn)
        startKeyStep()
    }

    /// The end of a sign-in in flight: the client's events are published again; a failed sign-in publishes the
    /// last session they said meanwhile.
    private func releaseEvents(publishHeld: Bool) {
        signingIn -= 1
        guard signingIn == 0, let held = heldSession else { return }
        heldSession = nil
        if publishHeld { publish(held) }
    }

    /// resend(email: email_norm, type: .signup, emailRedirectTo: AppConfig.authRedirect, captchaToken:). The same
    /// answer whether the address has an account or not.
    func resendConfirmation(email: String, captchaToken: String?) async throws(LoginFailure) {
        let address = PasswordV1.emailNorm(email)
        guard Self.isValidEmail(address) else { throw .invalidEmail }
        do {
            try await provider.auth.resend(email: address, type: .signup, emailRedirectTo: AppConfig.authRedirect, captchaToken: Self.token(captchaToken))
        } catch {
            if case .sent = Self.mailRefusal(error) { return }
            if case let .failed(failure) = Self.mailRefusal(error) { throw failure }
        }
    }

    /// N4: true once when the last password sign-in of this generation made no key (the address typed and the
    /// session's are not the same for password-v1).
    func takeAddressMismatch() -> Bool {
        guard let stamp = pendingMismatch else { return false }
        pendingMismatch = nil
        return session.isCurrent(stamp)
    }

    /// The key step of the signed-in generation now (MainScreens.attachKeys): `start` takes the hand-off
    /// (takeSignInSecret / takeAddressMismatch); it is called again whenever a sign-in of this generation
    /// decides one. Nothing is registered while signed out.
    func setKeyStep(_ start: @escaping @MainActor () -> Void) {
        guard let stamp = session.stamp() else { return }
        keyStep = (stamp, start)
    }

    private func startKeyStep() {
        guard let step = keyStep, session.isCurrent(step.stamp) else { return }
        step.start()
    }

    /// What makeSignedIn made for the signed-in generation now (made once per generation); nil when signed out or
    /// when there is no makeSignedIn.
    func signedInObject() -> AnyObject? {
        guard case .signedIn = state, let stamp = session.stamp() else { return nil }
        if let part = signedInPart, part.stamp == stamp { return part.value }
        guard let makeSignedIn else { return nil }
        let value = makeSignedIn(self)
        signedInPart = (stamp, value)
        return value
    }

    /// The PasswordSignIn of the last password sign-in, once; nil after sign-out, for another user, or when
    /// there is none.
    func takeSignInSecret() -> PasswordSignIn? {
        guard let pending = pendingSignIn else { return nil }
        guard session.isCurrent(pending.stamp) else {
            clearPendingSignIn()
            return nil
        }
        pendingSignIn = nil
        return pending.signIn
    }

    /// The address the password opens the key with (UnlockModel.signInEmail): the signed-in session's
    /// user.email; nil when signed out.
    var signedInEmail: String? {
        guard case .signedIn = state else { return nil }
        return provider.auth.currentSession?.user.email
    }

    /// master off the main thread (PasswordV1Deriver). A failure of PBKDF2 itself is .other.
    private func makeMaster(password: String, email: String) async throws(LoginFailure) -> Data {
        do {
            return try await deriver.master(password: password, email: email)
        } catch {
            throw .other
        }
    }

    /// Drops the kept sign-in, its master zeroed (taken out first, so the bytes are zeroed where they are).
    private func clearPendingSignIn() {
        guard var master = pendingSignIn?.signIn.master else { return }
        pendingSignIn = nil
        master.resetBytes(in: 0..<master.count)
    }

    /// signOut(scope: .local). Always ends signed out on this device. First, on this device: ① the generation
    /// moves on ② work in flight is cancelled ③ the key and the plaintext in memory go ④ the Keychain item goes.
    func signOut() async {
        session.advance()
        session.follow(userID: nil)
        clearPendingSignIn()
        pendingMismatch = nil
        keyStep = nil
        signedInPart = nil
        cleanup?.cancelWork()
        cleanup?.dropMemory()
        cleanup?.deleteKeychainKey()
        do {
            try await provider.auth.signOut(scope: .local)
        } catch {
            // The client drops the local session before it calls the server; an unreachable server
            // does not keep the user signed in here.
        }
        if provider.auth.currentSession != nil {
            provider.clearStoredSession()
        }
        publish(nil)
    }

    /// email_norm (password-v1 step 1): the five ASCII whitespaces off both ends, A-Z made a-z.
    nonisolated static func normalizeEmail(_ raw: String) -> String {
        PasswordV1.emailNorm(raw)
    }

    /// The Web's check: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ and at most 254 characters (login-form.ts isLoginAddress).
    nonisolated static func isValidEmail(_ address: String) -> Bool {
        address.count <= 254 && address.wholeMatch(of: /[^\s@]+@[^\s@]+\.[^\s@]+/) != nil
    }

    /// Only printable ASCII (login-form.ts isAsciiAddress: /^[\x21-\x7e]+$/).
    nonisolated static func isASCIIAddress(_ address: String) -> Bool {
        !address.isEmpty && address.unicodeScalars.allSatisfy { (0x21...0x7E).contains($0.value) }
    }

    /// A session the client said (its events, the stored one, a refresh). While a password sign-in is in flight
    /// only the generation follows it; the sign-in publishes (A3-1).
    private func receive(_ session: Session?) {
        guard signingIn > 0 else { return publish(session) }
        heldSession = .some(session)
        self.session.follow(userID: session.map { $0.user.id.uuidString.lowercased() })
    }

    private func publish(_ session: Session?) {
        if let session {
            let userID = session.user.id.uuidString.lowercased()
            self.session.follow(userID: userID)
            state = .signedIn(userID: userID)
            // The generation's main screens, made here once (not by a View's init, B1-1).
            _ = signedInObject()
        } else {
            self.session.follow(userID: nil)
            state = .signedOut
        }
        if let part = signedInPart, !self.session.isCurrent(part.stamp) { signedInPart = nil }
    }

    /// A token worth passing on; nil when there is none (Supabase decides, while its CAPTCHA is off).
    private static func token(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty, raw.count <= Turnstile.tokenMaxLength else { return nil }
        return raw
    }

    /// Supabase's error as (status, code); nil status for no answer.
    private enum Answer {
        case noAnswer
        case refused(status: Int, code: String?)
        case unknown
    }

    private static func answer(of error: any Error) -> Answer {
        if error is URLError { return .noAnswer }
        if let failure = error as? SupabaseProvider.NoRetry {
            switch failure {
            case .noAnswer: return .noAnswer
            case let .server(status): return .refused(status: status, code: nil)
            }
        }
        // supabase-swift reads GoTrue's 422 weak_password into its own case (a refusal with a status, not an outage).
        if case AuthError.weakPassword = error { return .refused(status: 422, code: "weak_password") }
        guard case let AuthError.api(_, code, _, response) = error else { return .unknown }
        let raw = code.rawValue
        return .refused(status: response.statusCode, code: raw.isEmpty || raw == "unknown" ? nil : raw)
    }

    /// login-errors.ts signInFailureCode.
    private static func signInFailure(_ error: any Error) -> LoginFailure {
        switch answer(of: error) {
        case .noAnswer: return .network
        // N1: no status is the Web's isOutage (network).
        case .unknown: return .network
        case let .refused(status, code):
            if code == "invalid_credentials" { return .credentials }
            if code == "email_not_confirmed" { return .notConfirmed }
            if code == "captcha_failed" { return .captcha }
            if status == 429 || code == "over_request_rate_limit" { return .rate }
            if status >= 500 { return .network }
            return .other
        }
    }

    private enum MailOutcome {
        case sent
        case failed(LoginFailure)
    }

    /// login-auth.ts mailRefusal: the answers that depend on whether the address has an account say "sent".
    private static func mailRefusal(_ error: any Error) -> MailOutcome {
        switch answer(of: error) {
        case .noAnswer: return .failed(.network)
        // N1: no status is the Web's isOutage (network).
        case .unknown: return .failed(.network)
        case let .refused(status, code):
            if code == "captcha_failed" { return .failed(.captcha) }
            if code == "over_request_rate_limit" { return .failed(.rate) }
            if code == "email_address_invalid" || code == "validation_failed" { return .failed(.invalidEmail) }
            if ["user_already_exists", "email_exists", "user_not_found", "over_email_send_rate_limit"].contains(code ?? "") || status == 429 { return .sent }
            if status >= 500 { return .failed(.network) }
            return .failed(.other)
        }
    }
}

/// What a password sign-in leaves for the key step (KeySetup): the user, the address master was made with
/// (email_norm of the typed address) and master itself. Kept in memory only, taken once; whoever takes it
/// zeroes master when done.
struct PasswordSignIn: Sendable {
    let userID: String
    /// email_norm of the address master was made with.
    let email: String
    let master: Data
}
