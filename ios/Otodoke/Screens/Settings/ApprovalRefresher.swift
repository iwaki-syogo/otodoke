// The auto refresh of the Gmail approval card on 「メールの転送」, as the Web's RefreshUntilApproval
// (src/components/refresh-until-approval.tsx): coming back reads once (not within 10 s of the last read), a page that
// is in front reads every 20 s, and it stops 5 minutes after the last return, when the link has come, or when the
// page is left. It reads only the approval (SettingsModel.refreshApproval), never the whole page.
// src/lib/__tests__/ios-approval-refresh.test.ts compares the three numbers with the Web's constants.
// One difference from the Web, on purpose: the Web also lengthens the 5 minutes on a tap or a key press; here only a
// return to the front does.

import Foundation

@MainActor
final class ApprovalRefresher {
    /// Not within this long of the last read when the page comes back (the Web's MIN_GAP_MS).
    nonisolated static let minGap: TimeInterval = 10
    /// While the page is in front (POLL_MS).
    nonisolated static let pollEvery: TimeInterval = 20
    /// Stop this long after the last return or the page opening (ACTIVE_MS).
    nonisolated static let activeFor: TimeInterval = 5 * 60

    private let now: @MainActor () -> Date
    /// Whether the card still waits for the link (SettingsModel.pollsForApproval).
    private let isWaiting: @MainActor () -> Bool
    /// When the approval was last read, by this or by the page's own read.
    private let lastRead: @MainActor () -> Date?
    private let read: @MainActor () async -> Void
    private let sleep: @MainActor (TimeInterval) async -> Void
    private var activeSince: Date
    /// The page is on screen (a page that is left reads nothing, whatever the app does).
    private var visible = false
    /// The app is in front.
    private var inFront = true
    private(set) var loop: Task<Void, Never>?
    /// The read of a return, so that stop() cuts it off too.
    private var returnRead: Task<Void, Never>?

    init(
        now: @escaping @MainActor () -> Date = { Date() },
        isWaiting: @escaping @MainActor () -> Bool,
        lastRead: @escaping @MainActor () -> Date?,
        read: @escaping @MainActor () async -> Void,
        sleep: @escaping @MainActor (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) {
        self.now = now
        self.isWaiting = isWaiting
        self.lastRead = lastRead
        self.read = read
        self.sleep = sleep
        activeSince = now()
    }

    /// The page showed: the 5 minutes count from now (no read: the page reads by itself when it shows).
    func pageShown() {
        visible = true
        inFront = true
        activeSince = now()
        startLoop()
    }

    /// The page was left: nothing reads until it shows again.
    func pageHidden() {
        visible = false
        stop()
    }

    /// The app left the front.
    func wentAway() {
        inFront = false
        stop()
    }

    /// The app came back to the front: count 5 minutes again and read once unless it read within 10 s.
    func cameBack() async {
        inFront = true
        guard visible else { return }
        stop()
        activeSince = now()
        guard isWaiting() else { return startLoop() }
        if let last = lastRead(), now().timeIntervalSince(last) < Self.minGap { return startLoop() }
        let once = Task { await self.read() }
        returnRead = once
        await once.value
        // Cut off by stop() (the page was left, or the app went away): no beats follow.
        guard returnRead == once else { return }
        returnRead = nil
        startLoop()
    }

    /// The card waits again (the link went away on a full read): run again for 5 minutes.
    func waitingAgain() {
        guard visible, inFront, isWaiting() else { return }
        activeSince = now()
        startLoop()
    }

    func stop() {
        loop?.cancel()
        loop = nil
        returnRead?.cancel()
        returnRead = nil
    }

    private func startLoop() {
        loop?.cancel()
        loop = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.sleep(Self.pollEvery)
                guard !Task.isCancelled else { return }
                if await !self.tick() { return }
            }
        }
    }

    /// One beat of the loop; false when the loop ends.
    private func tick() async -> Bool {
        guard visible, inFront, isWaiting(), now().timeIntervalSince(activeSince) < Self.activeFor else { return false }
        await read()
        return true
    }
}
