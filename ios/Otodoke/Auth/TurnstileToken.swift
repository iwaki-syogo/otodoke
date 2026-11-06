// TDD-STUB(task 2) — the names and signatures below are the agreed API; the bodies are placeholders
// for the implementer. Remove this marker line once the bodies are written.
//
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

    init() {}

    /// A token is held for the current generation.
    var hasToken: Bool { false }

    /// Nothing more to wait for: a token is there, or none will come (unavailable).
    var isSettled: Bool { false }

    /// A notice from the widget of `generation`. Notices of another generation are ignored.
    func receive(_ event: TurnstileEvent, generation: Int) {}

    /// The token, removed from here (each token is sent once). nil when there is none.
    func take() -> String? { nil }

    /// Clears the token, moves the generation on and asks the view to reset the widget.
    func reset() {}

    /// Waits until `isSettled` or `timeout` has passed. true when settled.
    func waitUntilSettled(timeout: Duration) async -> Bool { false }
}
