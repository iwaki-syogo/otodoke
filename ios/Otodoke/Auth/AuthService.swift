// TDD-STUB(task 3): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.

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

    /// The text shown on the login screen.
    var message: String { "" }
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

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    /// Reads the stored session (and follows the client's auth events from then on).
    func start() async {}

    /// Called at launch and when the app comes back: refreshes an expired session; a refresh the
    /// server refuses ends in .signedOut (the login screen).
    func checkSession() async {}

    /// signInWithOTP(email: normalized, redirectTo: AppConfig.authRedirect). Nothing is sent for an invalid address.
    func sendCode(email: String) async throws(LoginError) { throw .other }

    /// verifyOTP(email:, token: code, type: .email).
    func verifyCode(email: String, code: String) async throws(LoginError) { throw .other }

    /// signOut(scope: .local). Always ends signed out on this device.
    func signOut() async {}

    /// Trimmed and lowercased, as the Web's login does.
    static func normalizeEmail(_ raw: String) -> String { "" }
}
