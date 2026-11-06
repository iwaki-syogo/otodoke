// How often the waiting screen (after making an account) tries the sign-in by itself. Every try counts against
// the sign-in limits per IP (and Supabase's own), which a person going back and forth between the mail and the
// app would use up, and then even the sign-in after the real confirmation would be refused with `rate`. The
// numbers and the movement are the Web's (src/lib/onboarding.ts AUTO_SIGN_IN_*, the sign-up form's waiting
// screen; a vitest compares the numbers). A press of 「確認しました」 always tries and changes none of this
// (it only moves the next timed try away from the press).
//
// The two things that differ from the Web, on purpose (the iOS Turnstile needs a tap to make a new token after
// every use, the Web's widget renews itself):
//  1. `lastAt` is set when a sign-in is really sent. A try that finds no token sends nothing and uses no gap: the
//     tap that brings the token tries at once (the Web sets it at the start of the try and tries again a gap later).
//  2. A try by itself refused with `captcha` is silent and does not hold the next one back for 60 seconds (the Web
//     does): the tap on the widget that follows gives a token and must be tried at once.
// Neither adds sends: the limit of 5 and the 60 seconds after any other refusal hold as on the Web.

import Foundation

enum AutoSignIn {
    /// After a try by itself refused as "not confirmed yet" the next timed try waits 20, then 60, then 180 seconds
    /// (AUTO_SIGN_IN_BACKOFF_MS); the last gap stays.
    static let backoffMs = [20_000, 60_000, 180_000]
    /// After a refusal other than "not confirmed yet" the next try by itself waits 60 seconds (AUTO_SIGN_IN_AFTER_FAILURE_MS).
    static let afterFailureMs = 60_000
    /// Two returns this close are one return, not two (AUTO_SIGN_IN_SAME_RETURN_MS: the Web's visibilitychange and
    /// focus; the scene phase can double the same way: active, inactive, active within a moment).
    static let sameReturnMs = 2_000
    /// At most 5 sends by itself per waiting screen (AUTO_SIGN_IN_MAX); after them only the button tries. Low on
    /// purpose: the app's sign-in limit is per IP (15 in 10 minutes), and a few people signing up from one line
    /// must not use it up.
    static let max = 5

    /// The gap before the next timed try, after `refusals` tries by themselves refused as "not confirmed yet"
    /// (autoSignInGapMs).
    static func gapMs(refusals: Int) -> Int {
        backoffMs[min(Swift.max(refusals - 1, 0), backoffMs.count - 1)]
    }
}

/// The state of one waiting screen: when the last try began (the screen appearing counts as one), how many were
/// refused as "not confirmed yet", the earliest the next may be after another refusal, how many were sent, when the
/// app was last shown again, and when 「確認しました」 was last pressed.
struct AutoSignInGate: Equatable {
    private var lastAt: Date
    private var pressedAt: Date?
    private var notBefore: Date?
    private var lastReturnAt: Date?
    private(set) var refusals = 0
    private(set) var sends = 0

    /// The waiting screen appears at `now`: the first timed try is one gap on.
    init(now: Date) { lastAt = now }

    /// A try by itself may begin now (a return, a token, the timer): the limit is not used up and no refusal's wait
    /// is running. The gap of the backoff does not hold a return back (the Web: the tab shown again tries at once).
    func allows(now: Date) -> Bool {
        if sends >= AutoSignIn.max { return false }
        if let notBefore, now < notBefore { return false }
        return true
    }

    /// When the timer tries next, or nil when nothing more is timed (the limit is used up): the end of the gap after
    /// the last try or press, and not before the wait that follows a refusal.
    func nextTimedAt() -> Date? {
        guard sends < AutoSignIn.max else { return nil }
        let gap = Double(AutoSignIn.gapMs(refusals: refusals)) / 1000
        var at = lastAt.addingTimeInterval(gap)
        if let pressedAt { at = max(at, pressedAt.addingTimeInterval(gap)) }
        if let notBefore { at = max(at, notBefore) }
        return at
    }

    /// A return to the front at `now`. false when it is the second notice of the return before it.
    mutating func noteReturn(now: Date) -> Bool {
        if let lastReturnAt, now.timeIntervalSince(lastReturnAt) * 1000 < Double(AutoSignIn.sameReturnMs) { return false }
        lastReturnAt = now
        return true
    }

    /// A sign-in by itself is about to be sent (difference 1 in the header).
    mutating func begin(now: Date) { lastAt = now }

    /// A sign-in by itself was sent (the retry with a fresh token is a send too).
    mutating func countSend() { sends += 1 }

    /// A try by itself was refused as "not confirmed yet": the next gap is the next of the backoff.
    mutating func refusedNotConfirmed() { refusals += 1 }

    /// 「確認しました」 was pressed: the next timed try is a gap on from the press (no refusal, no send counted).
    mutating func pressed(now: Date) { pressedAt = now }

    /// A refusal other than "not confirmed yet" (whoever tried): the next try by itself waits.
    mutating func refused(now: Date) { notBefore = now.addingTimeInterval(Double(AutoSignIn.afterFailureMs) / 1000) }
}
