// TDD-STUB(task 3): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// The view model of LoginView: e-mail → 8-digit code, the error texts, the 60-second resend wait,
// the spinner flag. LaunchOptions reads the DEBUG-only argument that starts at code entry.

import Foundation
import Observation

struct LaunchOptions: Equatable, Sendable {
    /// Set only in DEBUG builds, from the launch argument (the e-mail that follows it).
    var startAtCodeEntryEmail: String?

    init(arguments: [String]) {
        startAtCodeEntryEmail = nil
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

    init(auth: AuthService, launch: LaunchOptions = .current, now: @escaping @Sendable () -> Date = { Date() }) {
        self.auth = auth
    }

    /// True when `code` is exactly 8 ASCII digits.
    var canVerify: Bool { false }

    /// Whole seconds left before the code may be sent again (rounded up); 0 when it may.
    func resendWaitSeconds() -> Int { -1 }

    func sendCode() async {}

    func verify() async {}

    /// Sends the code again to the same address, only once the wait is over.
    func resend() async {}
}
