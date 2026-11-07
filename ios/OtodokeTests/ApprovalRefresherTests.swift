import Foundation
import Testing
@testable import Otodoke

/// The auto refresh of the Gmail approval card (the Web's RefreshUntilApproval): 20 s beats, 5 minutes of life after
/// the last return, one read on a return unless one ran within 10 s, a stop when the link comes. The clock is a
/// fake one (the sleep advances it); nothing waits in real time and nothing leaves the test.
@Suite("Approval auto refresh")
@MainActor
struct ApprovalRefresherTests {
    final class World {
        var now = Date(timeIntervalSince1970: 1_800_000_000)
        var reads = 0
        var lastRead: Date?
        var waiting = true
        /// The read at which the link comes (the card stops waiting), if any.
        var linkAtRead: Int?
        var readsFail = false
        var failures = 0
        /// A read waits on this gate when it is set (and `reading` shows it started).
        var readGate: Gate?
        var reading = false
    }

    private func refresher(_ w: World, autoAdvance: Bool = true) -> ApprovalRefresher {
        ApprovalRefresher(
            now: { w.now },
            isWaiting: { w.waiting },
            lastRead: { w.lastRead },
            read: {
                w.reads += 1
                w.lastRead = w.now
                if w.readsFail { w.failures += 1 }
                if let gate = w.readGate {
                    w.reading = true
                    await gate.wait()
                }
                if w.reads == w.linkAtRead { w.waiting = false }
            },
            sleep: { seconds in
                if autoAdvance { w.now.addTimeInterval(seconds) } else { try? await Task.sleep(for: .seconds(3600)) }
            }
        )
    }

    @Test func readsEvery20SecondsAndStopsAtFiveMinutes() async {
        let w = World()
        let r = refresher(w)
        r.pageShown()
        await r.loop?.value
        // Beats at 20, 40 ... 280 s read; the beat at 300 s stops it.
        #expect(w.reads == 14)
        #expect(w.now.timeIntervalSince1970 == 1_800_000_000 + 300)
    }

    @Test func aReturnCountsFiveMinutesAgainAndReadsOnce() async {
        let w = World()
        let r = refresher(w)
        r.pageShown()
        await r.loop?.value
        #expect(w.reads == 14)
        // Long after the last read: one read at once, then the beats run for another five minutes.
        await r.cameBack()
        #expect(w.reads == 15)
        await r.loop?.value
        #expect(w.reads == 15 + 14)
    }

    @Test func keepsGoingWhileReadsFailAndStopsAtFiveMinutes() async {
        let w = World()
        w.readsFail = true
        let r = refresher(w)
        r.pageShown()
        await r.loop?.value
        #expect(w.reads == 14)
        #expect(w.failures == 14)
    }

    @Test func aPageThatIsLeftReadsNothingWhateverTheAppDoes() async {
        let w = World()
        let r = refresher(w)
        r.pageShown()
        r.pageHidden()
        w.lastRead = nil
        await r.cameBack()
        r.waitingAgain()
        await r.loop?.value
        #expect(w.reads == 0)
        // Negative control: shown again, a return reads.
        r.pageShown()
        await r.cameBack()
        #expect(w.reads >= 1)
        r.stop()
    }

    @Test func runsAgainWhenTheCardWaitsAgain() async {
        let w = World()
        w.waiting = false
        let r = refresher(w)
        r.pageShown()
        await r.loop?.value
        #expect(w.reads == 0)
        // The link went away on a full read: the card waits again, and the beats run for five minutes.
        w.waiting = true
        r.waitingAgain()
        await r.loop?.value
        #expect(w.reads == 14)
    }

    @Test func aReturnReadThatIsCutOffStartsNoBeats() async {
        let w = World()
        let gate = Gate()
        w.readGate = gate
        let r = refresher(w, autoAdvance: false)
        r.pageShown()
        let back = Task { await r.cameBack() }
        for _ in 0..<1000 where !w.reading { await Task.yield() }
        #expect(w.reading)
        r.stop()
        gate.open()
        await back.value
        #expect(r.loop == nil)
    }

    @Test func aReturnWithinTenSecondsDoesNotRead() async {
        let w = World()
        let r = refresher(w, autoAdvance: false)
        w.lastRead = w.now.addingTimeInterval(-9)
        await r.cameBack()
        #expect(w.reads == 0)
        w.lastRead = w.now.addingTimeInterval(-10)
        await r.cameBack()
        #expect(w.reads == 1)
        r.stop()
    }

    @Test func stopsWhenTheLinkComes() async {
        let w = World()
        w.linkAtRead = 3
        let r = refresher(w)
        r.pageShown()
        await r.loop?.value
        #expect(w.reads == 3)
    }

    @Test func leavingThePageStopsIt() async {
        let w = World()
        let r = refresher(w, autoAdvance: false)
        r.pageShown()
        r.stop()
        await Task.yield()
        #expect(r.loop == nil)
        #expect(w.reads == 0)
    }

    @Test func negativeControlNothingRunsWhenTheCardIsNotWaiting() async {
        let w = World()
        w.waiting = false
        let r = refresher(w)
        r.pageShown()
        await r.loop?.value
        await r.cameBack()
        await r.loop?.value
        #expect(w.reads == 0)
    }
}

/// SettingsModel.pollsForApproval and refreshApproval: who is polled, and what is read.
@Suite("Approval auto refresh: the model")
@MainActor
struct ApprovalRefreshModelTests {
    private static let link = SettingsRows.google

    private func make(key: Bool, keyFails: Bool = false, mails: [Row] = []) async throws -> (SettingsModel, FakeSupabase) {
        let fake = FakeSupabase.make()
        if key { await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")]) }
        await fake.insert("emails", mails)
        if keyFails { await fake.fail("GET", "user_keys", with: .http(500)) }
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
        await model.load()
        return (model, fake)
    }

    private func confirmation(_ n: Int) -> Row {
        SettingsRows.mail(n, [
            "classification": "forwarding_confirmation",
            "forwarding_confirm_url": .string(Self.link),
            "created_at": "2026-11-03T00:00:00+00:00",
            "sent_at": "2026-11-03T00:00:00+00:00",
        ])
    }

    @Test func pollsWithAnAddressAndNoLink() async throws {
        let (model, _) = try await make(key: true)
        #expect(model.pollsForApproval)
    }

    @Test func negativeControlNoKeyAndAFailedKeyReadAreNotPolled() async throws {
        let (none, _) = try await make(key: false)
        #expect(none.pollsForApproval == false)
        let (failed, _) = try await make(key: true, keyFails: true)
        #expect(failed.pollsForApproval == false)
    }

    @Test func aLinkStopsTheCardWaitingAndRefreshPicksItUp() async throws {
        let (model, fake) = try await make(key: true)
        #expect(model.confirmURL == nil)
        await fake.insert("emails", [confirmation(1)])
        await model.refreshApproval()
        #expect(model.confirmURL?.absoluteString == Self.link)
        #expect(model.pollsForApproval == false)
        // Not waiting any more: a further call reads nothing and changes nothing.
        await model.refreshApproval()
        #expect(model.confirmURL?.absoluteString == Self.link)
    }

    @Test func refreshOnlyTouchesTheConfirmation() async throws {
        let (model, fake) = try await make(key: true)
        let before = (model.address, model.unread == nil, model.dropped == nil)
        await fake.insert("emails", [confirmation(2)])
        await model.refreshApproval()
        #expect(model.address == before.0)
        #expect((model.unread == nil, model.dropped == nil) == (before.1, before.2))
    }

    private func emailReads(_ fake: FakeSupabase) async -> Int { await fake.count("GET", "emails") }

    @Test func aReadCutOffMidwayIsNotAFailedRead() async throws {
        let (model, fake) = try await make(key: true)
        let gate = Gate()
        let n = await emailReads(fake)
        await fake.fail("GET", "emails", nth: n + 1, with: .hold(gate))
        let before = model.lastApprovalRead
        let task = Task { await model.refreshApproval() }
        #expect(await waitFor { await fake.count("GET", "emails") == n + 1 })
        task.cancel()
        gate.open()
        await task.value
        #expect(model.approvalNote == nil)
        #expect(model.lastApprovalRead == before)
    }

    @Test func aFullReadThatCameAndWentMeanwhileKeepsTheOlderAnswerOut() async throws {
        let (model, fake) = try await make(key: true, mails: [confirmation(3)])
        // make() read the link already; take it away again so the refresh runs.
        await fake.mutate { $0["emails"] = [] }
        await model.load()
        #expect(model.confirmURL == nil)
        await fake.insert("emails", [confirmation(4)])
        let gate = Gate()
        let n = await emailReads(fake)
        // Handled now (the link is there), delivered late.
        await fake.fail("GET", "emails", nth: n + 1, with: .delay(gate))
        let task = Task { await model.refreshApproval() }
        #expect(await waitFor { await fake.count("GET", "emails") == n + 1 })
        await fake.mutate { $0["emails"] = [] }
        await model.load()
        gate.open()
        await task.value
        #expect(model.confirmURL == nil)
    }

    @Test func theBadgeFollowsTheRefresh() async throws {
        let (model, fake) = try await make(key: true)
        #expect(model.approvalWaiting == false)
        await fake.insert("emails", [confirmation(5)])
        await model.refreshApproval()
        #expect(model.confirmURL?.absoluteString == Self.link)
        #expect(model.approvalWaiting)
        #expect(model.approvalBadgeFailed == false)
    }

    @Test func aFailedReadShowsTheNoteAndKeepsPolling() async throws {
        let (model, fake) = try await make(key: true)
        // The first confirmation read was load()'s; the second is the refresh's.
        await fake.fail(where: { $0.method == "GET" && $0.url.lastPathComponent == "emails" && $0.query("classification") == ["eq.forwarding_confirmation"] && $0.query("limit") == ["10"] }, nth: 2, with: .http(500))
        await model.refreshApproval()
        #expect(model.approvalNote != nil)
        #expect(model.pollsForApproval)
    }
}
