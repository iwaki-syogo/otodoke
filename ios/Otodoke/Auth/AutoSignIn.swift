// How often the waiting screen (after making an account) tries the sign-in by itself, when the app comes back to
// the front. Every try counts against the sign-in limits per IP (and Supabase's own), which a person going back
// and forth between the mail and the app would use up, and then even the sign-in after the real confirmation
// would be refused with `rate`. The numbers are the Web's (src/lib/onboarding.ts AUTO_SIGN_IN_*; a vitest compares
// them). A press of 「確認しました」 always tries and is not counted. No timer: only the next return tries again.

import Foundation

enum AutoSignIn {
    /// At most one try by itself every 20 seconds (AUTO_SIGN_IN_GAP_MS).
    static let gapMs = 20_000
    /// After a refusal other than "not confirmed yet" the next try by itself waits 60 seconds (AUTO_SIGN_IN_AFTER_FAILURE_MS).
    static let afterFailureMs = 60_000
    /// A return that comes this soon after the try it follows is the same return, not another (the Web's
    /// SAME_RETURN_MS, for the browser's visibilitychange and focus). The scene phase can double the same way
    /// (active, inactive, active within a moment: the control centre, a system sheet).
    static let sameReturnMs = 2_000
    /// At most 5 sends by itself per waiting screen (AUTO_SIGN_IN_MAX); after them only the button tries. Low on
    /// purpose: the app's sign-in limit is per IP (15 in 10 minutes), and a few people signing up from one line
    /// must not use it up.
    static let max = 5
}

/// The state of one waiting screen: when the last try by itself began, when the next may, and how many were sent.
struct AutoSignInGate: Equatable {
    private var lastAt: Date?
    private var notBefore: Date?
    private(set) var sends = 0

    /// A try by itself may begin now. Beginning it is `begin(now:)`.
    func allows(now: Date) -> Bool {
        if sends >= AutoSignIn.max { return false }
        if let lastAt, now.timeIntervalSince(lastAt) * 1000 < Double(AutoSignIn.gapMs) { return false }
        if let notBefore, now < notBefore { return false }
        return true
    }

    /// When the 20-second gap ends, if the gap is the only thing holding a try by itself back (not the limit on
    /// sends, not a longer wait after a refusal); else nil. The screen tries once then, if it is still in front.
    func gapEnd(now: Date) -> Date? {
        guard sends < AutoSignIn.max, let lastAt else { return nil }
        let end = lastAt.addingTimeInterval(Double(AutoSignIn.gapMs) / 1000)
        guard now < end else { return nil }
        // The second notice of the return that made the try keeps nothing for later.
        guard now.timeIntervalSince(lastAt) * 1000 > Double(AutoSignIn.sameReturnMs) else { return nil }
        if let notBefore, notBefore > end { return nil }
        return end
    }

    /// A try by itself began (it is about to send).
    mutating func begin(now: Date) { lastAt = now }

    /// A try by itself sent a sign-in.
    mutating func countSend() { sends += 1 }

    /// A refusal other than "not confirmed yet" (whoever tried): the next try by itself waits.
    mutating func refused(now: Date) { notBefore = now.addingTimeInterval(Double(AutoSignIn.afterFailureMs) / 1000) }
}
