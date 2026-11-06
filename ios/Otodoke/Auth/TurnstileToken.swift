// Where the login screen keeps the Turnstile token. Every load of the widget has a generation; only
// notices from the current generation count (Codex-003). A token is taken (and cleared) when a code is
// sent, and cleared on expired / error / timeout. After every send the widget is reset (a new
// generation), and the next send needs a new tap (T1: the widget never passes by itself).

import Foundation
import Observation

/// What the widget tells Swift, through one message handler (callback, expired-callback,
/// error-callback, timeout-callback, and the script failing to load).
enum TurnstileEvent: Equatable, Sendable {
    case token(String)
    case expired
    case error
    case timeout
    /// The script could not load (offline, blocked, Cloudflare down): no token will come.
    case unavailable
}

@MainActor
@Observable
final class TurnstileToken {
    /// The widget's current generation. Starts at 0; `reset()` moves it on.
    private(set) var generation = 0
    /// How many times a reset of the widget was asked for (the view resets the widget when it changes).
    private(set) var resetCount = 0
    /// The script could not load for the current generation (shows TurnstileText.unavailable).
    private(set) var isUnavailable = false
    /// The token of the current generation, not sent yet.
    private var token: String?
    /// When the held token came (the clock below).
    private var tokenAt: Date?
    @ObservationIgnored private let now: @Sendable () -> Date

    init(now: @escaping @Sendable () -> Date = { Date() }) {
        self.now = now
    }

    /// A token is held for the current generation.
    var hasToken: Bool { token != nil }

    /// Nothing more to wait for: a token is there, or none will come (unavailable).
    var isSettled: Bool { token != nil || isUnavailable }

    /// A notice from the widget of `generation`. Notices of another generation are ignored.
    func receive(_ event: TurnstileEvent, generation: Int) {
        guard generation == self.generation else { return }
        switch event {
        case let .token(value):
            token = value.isEmpty ? nil : value
            tokenAt = token == nil ? nil : now()
            isUnavailable = false
        case .expired, .error, .timeout:
            token = nil
            tokenAt = nil
        case .unavailable:
            token = nil
            tokenAt = nil
            isUnavailable = true
        }
    }

    /// The token, removed from here (each token is sent once). nil when there is none.
    func take() -> String? {
        defer {
            token = nil
            tokenAt = nil
        }
        return token
    }

    /// The held token is older than `staleMs` (Turnstile.tokenStaleMs): a page the system froze in the
    /// background can be shown again with its old token still held. It is dropped and true is returned; the caller
    /// moves the widget on (reset), as the Web's tokenForAutoAttempt does.
    func dropIfStale(staleMs: Int = Turnstile.tokenStaleMs) -> Bool {
        guard token != nil, let tokenAt, now().timeIntervalSince(tokenAt) * 1000 > Double(staleMs) else { return false }
        token = nil
        self.tokenAt = nil
        return true
    }

    /// Clears the token, moves the generation on and asks the view to reset the widget.
    /// The new widget finds out again whether its script loads.
    func reset() {
        token = nil
        tokenAt = nil
        isUnavailable = false
        generation += 1
        resetCount += 1
    }

    /// Waits until `isSettled` or `timeout` has passed. true when settled.
    func waitUntilSettled(timeout: Duration) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !isSettled {
            let left = deadline - clock.now
            if left <= .zero || Task.isCancelled { return isSettled }
            try? await Task.sleep(for: min(.milliseconds(50), left))
        }
        return true
    }
}
