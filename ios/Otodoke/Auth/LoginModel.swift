// The view model of LoginView: e-mail → 8-digit code, the error texts, the 60-second resend wait,
// the spinner flag. LaunchOptions reads the DEBUG-only argument that starts at code entry.

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
    @ObservationIgnored private let now: @Sendable () -> Date
    private var lastSentAt: Date?
    /// The address the last code went to (normalized).
    private var lastSentTo: String?

    init(auth: AuthService, launch: LaunchOptions = .current, now: @escaping @Sendable () -> Date = { Date() }) {
        self.auth = auth
        self.now = now
        if let address = launch.startAtCodeEntryEmail {
            email = address
            step = .code(email: address)
        }
    }

    /// True when `code` is exactly 8 ASCII digits.
    var canVerify: Bool {
        code.utf8.count == Self.codeLength && code.utf8.allSatisfy { (0x30...0x39).contains($0) }
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
            try await auth.verifyCode(email: address, code: code)
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
    }

    private func send(to raw: String) async {
        guard !isWorking else { return }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await auth.sendCode(email: raw)
            lastSentAt = now()
            lastSentTo = AuthService.normalizeEmail(raw)
            code = ""
            step = .code(email: AuthService.normalizeEmail(raw))
        } catch {
            errorMessage = error.message
        }
    }
}
