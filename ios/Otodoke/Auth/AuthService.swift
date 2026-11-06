import Auth
import Foundation
import Observation

enum LoginError: Error, Equatable, Sendable {
    case invalidEmail
    /// A wrong or expired code (Supabase answers both the same way).
    case codeRejected
    /// 429.
    case rateLimited
    /// No answer from the server.
    case network
    case other
    // TDD-STUB(task 2): Supabase's captcha_failed (400). Missing: this press sent no token;
    // refused: it sent one. The words are CaptchaText's (login-errors.ts captcha_missing / captcha_refused).
    case captchaMissing
    case captchaRefused

    /// The text shown on the login screen.
    var message: String {
        switch self {
        case .invalidEmail: "メールアドレスの形式を確認してください"
        case .codeRejected: "コードが違うか、有効期限が切れています"
        case .rateLimited: "しばらく待ってから、もう一度お試しください"
        case .network: "通信できませんでした。もう一度お試しください"
        case .other: "ログインできませんでした。もう一度お試しください"
        case .captchaMissing: CaptchaText.missing
        case .captchaRefused: CaptchaText.refused
        }
    }
}

/// TDD-STUB(task 2): the two words of src/lib/login-errors.ts, in one place (a vitest compares them).
enum CaptchaText {
    /// captcha_missing
    static let missing = ""
    /// captcha_refused
    static let refused = ""
}

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

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    /// Reads the stored session (and follows the client's auth events from then on).
    func start() async {
        apply(provider.auth.currentSession)
        if events == nil {
            let changes = provider.auth.authStateChanges
            events = Task { [weak self] in
                for await change in changes {
                    guard let self else { return }
                    self.apply(change.session)
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
            state = .signedOut
            return
        }
        do {
            apply(try await provider.auth.session)
        } catch {
            // A refused refresh token makes the client drop the session; no answer keeps it (offline).
            apply(provider.auth.currentSession)
        }
    }

    /// TDD-STUB(task 2): signInWithOTP(email:, redirectTo:, captchaToken:). The body carries
    /// gotrue_meta_security.captcha_token only when a token is given. captcha_failed is
    /// .captchaMissing without a token and .captchaRefused with one.
    func sendCode(email: String, captchaToken: String?) async throws(LoginError) {
        try await sendCode(email: email)
    }

    /// signInWithOTP(email: normalized, redirectTo: AppConfig.authRedirect). Nothing is sent for an invalid address.
    func sendCode(email: String) async throws(LoginError) {
        let address = Self.normalizeEmail(email)
        guard Self.isValidEmail(address) else { throw .invalidEmail }
        do {
            try await provider.auth.signInWithOTP(email: address, redirectTo: AppConfig.authRedirect, shouldCreateUser: true)
        } catch {
            throw Self.loginError(from: error)
        }
    }

    /// verifyOTP(email:, token: code, type: .email).
    func verifyCode(email: String, code: String) async throws(LoginError) {
        let address = Self.normalizeEmail(email)
        guard Self.isValidEmail(address) else { throw .invalidEmail }
        let session: Session?
        do {
            session = try await provider.auth.verifyOTP(email: address, token: code, type: .email).session
        } catch {
            throw Self.loginError(from: error)
        }
        guard let session else { throw .other }
        apply(session)
    }

    /// signOut(scope: .local). Always ends signed out on this device.
    func signOut() async {
        do {
            try await provider.auth.signOut(scope: .local)
        } catch {
            // The client drops the local session before it calls the server; an unreachable server
            // does not keep the user signed in here.
        }
        if provider.auth.currentSession != nil {
            provider.clearStoredSession()
        }
        state = .signedOut
    }

    /// Trimmed and lowercased, as the Web's login does.
    nonisolated static func normalizeEmail(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// The Web's check: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    nonisolated static func isValidEmail(_ address: String) -> Bool {
        address.wholeMatch(of: /[^\s@]+@[^\s@]+\.[^\s@]+/) != nil
    }

    private func apply(_ session: Session?) {
        if let session {
            state = .signedIn(userID: session.user.id.uuidString.lowercased())
        } else {
            state = .signedOut
        }
    }

    private static func loginError(from error: any Error) -> LoginError {
        if error is URLError { return .network }
        if let failure = error as? SupabaseProvider.NoRetry {
            switch failure {
            case .noAnswer: return .network
            case .server: return .other
            }
        }
        guard case let AuthError.api(_, code, _, response) = error else { return .other }
        if response.statusCode == 429 || [.overEmailSendRateLimit, .overRequestRateLimit].contains(code) {
            return .rateLimited
        }
        if code == .otpExpired || response.statusCode == 403 {
            return .codeRejected
        }
        return .other
    }
}
