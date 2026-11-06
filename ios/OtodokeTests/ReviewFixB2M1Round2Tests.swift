import Foundation
import Testing
@testable import Otodoke

// [Batch 2, M1, review fix 2] Failing tests written before the fixes of review-fix1.md /
// security-fix1.md / codex-review-fix1.md (HEAD fffc10d): S-new1, CX-f1, CX-f2, N-new1, N-new2, SEC-N4.

/// A screen model's world against FakeSupabase (made-up rows only).
@MainActor
private enum Round2 {
    static func settings(_ fake: FakeSupabase, changes: DataChanges = DataChanges()) async throws -> SettingsModel {
        let (provider, auth) = try await TestSession.signedIn(fake)
        return SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: changes,
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
    }

    static func calendar(_ fake: FakeSupabase, changes: DataChanges = DataChanges()) async throws -> CalendarModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return CalendarModel(reader: ParcelReader(provider: provider), changes: changes, today: { "2026-11-04" })
    }

    static func spend(_ fake: FakeSupabase, changes: DataChanges = DataChanges()) async throws -> SpendModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return SpendModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider, changes: changes),
            changes: changes,
            today: { "2026-11-04" }
        )
    }

    static let shownKey = SettingsModel.KeyPanel.present(plainCount: .loaded(0), oldKeyCount: .loaded(0))
}

// MARK: - [S-new1] no category save while a spend move is on the way

/// [S-new1] A save that ended in conflict or unknown during a move read the conditions from before the
/// move, undoing it. The orchestrator's decision: while a move is on the way the chips are disabled
/// (`categoryLocked`), and the model also refuses setCategory meanwhile.
@Suite("Round 2: no category save while a spend move is on the way (S-new1)", .serialized)
@MainActor
struct Round2SpendSaveDuringMoveTests {
    static let rows: [Row] = [
        Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1000, "category": "food"]),
        Rows.parcel(2, ["ordered_at": "2026-11-03", "total_amount": 3000, "category": nil]),
        Rows.parcel(4, ["ordered_at": "2026-10-15", "total_amount": 500, "category": "food"]),
    ]

    private func loaded() async throws -> (FakeSupabase, SpendModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.rows)
        let model = try await Round2.spend(fake)
        await model.load()
        return (fake, model)
    }

    @Test func aSaveDuringAMoveIsRefusedAndTheMoveIsShown() async throws {
        let (fake, model) = try await loaded()
        let gate = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let move = Task { await model.showMonth("2026-10") }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        #expect(model.isDimmed)
        #expect(model.categoryLocked, "the chips are disabled while the move is on the way")

        await model.setCategory(parcelID: Rows.id(2), to: .daily)
        #expect(await fake.count("PATCH", "parcels") == 0, "nothing is sent while the move is on the way")
        #expect(model.savingCategory.isEmpty)

        gate.open()
        await move.value
        #expect(model.period == .month("2026-10"))
        #expect(model.parcels?.value?.map(\.id) == [Rows.id(4)])
        #expect(model.categoryLocked == false)
    }

    /// Negative control: with no move on the way the chip saves.
    @Test func aSaveWithNoMoveIsSent() async throws {
        let (fake, model) = try await loaded()
        #expect(model.categoryLocked == false)
        await model.setCategory(parcelID: Rows.id(2), to: .daily)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.parcels?.value?.first(where: { $0.id == Rows.id(2) })?.category == "daily")
    }
}

// MARK: - [CX-f1] the calendar's move read ending before the load read

/// [CX-f1] Move read A, then a load() read B (carrying the month moved to), then A ends first: the move
/// is not over until B (or a newer read) shows it; a load() meanwhile still reads the month moved to.
@Suite("Round 2: the calendar's move read ending first (CX-f1)", .serialized)
@MainActor
struct Round2CalendarMoveOrderTests {
    @Test func theMoveReadEndingFirstKeepsTheMonthMovedTo() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [
            Rows.parcel(1, ["expected_date": "2026-11-05"]),
            Rows.parcel(8, ["expected_date": "2026-12-01"]),
        ])
        let model = try await Round2.calendar(fake)
        await model.load()
        #expect(model.month == "2026-11")

        let gateA = Gate(), gateB = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gateA))
        await fake.fail("GET", "parcels", nth: reads + 2, with: .hold(gateB))
        let move = Task { await model.nextMonth() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        let b = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 2 })

        // A ends first (superseded by B): the move is not shown yet, so it is still on the way.
        gateA.open()
        await move.value
        #expect(model.isMoving, "the move is on the way until a read shows it")
        #expect(model.month == "2026-11")

        // Another load() meanwhile (C) reads the month moved to, not the one shown.
        await model.load()
        #expect(model.month == "2026-12")
        #expect(model.entries(on: "2026-12-01").map(\.id) == [Rows.id(8)])
        #expect(model.isMoving == false)

        gateB.open()
        await b.value
        #expect(model.month == "2026-12")
        #expect(model.isMoving == false)
    }
}

// MARK: - [CX-f2] coming back before a cut-off read has ended

/// [CX-f2] A read whose .task was cancelled (the tab left) may still be on its awaits when the tab is
/// shown again: onAppear must read again then, not wait for the old read to end (it never starts one
/// afterwards). The calendar and spend have the same hole after a stale read (lateral, by cause).
@Suite("Round 2: coming back before a cut-off read has ended (CX-f2)", .serialized)
@MainActor
struct Round2ComingBackBeforeCutOffEndsTests {
    @Test func settingsReadsAgainAtOnce() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        let gate = Gate()
        await fake.fail("GET", "user_keys", nth: 1, with: .hold(gate))
        let model = try await Round2.settings(fake)

        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "user_keys") == 1 })
        first.cancel()
        // Back on the tab right away: the old read has not ended (it cannot run before this call yields).
        await model.onAppear()
        #expect(await waitFor { await model.keyPanel == Round2.shownKey }, "\(String(describing: model.keyPanel))")
        #expect(model.unread == .loaded(0))

        // The old read ends afterwards: it changes nothing.
        gate.open()
        await first.value
        #expect(model.keyPanel == Round2.shownKey)
        #expect(model.unread == .loaded(0))
    }

    /// Negative control: a read on the way that was not cut off is not started twice.
    @Test func settingsDoesNotReadTwiceWhileAReadIsOnTheWay() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        let gate = Gate()
        await fake.fail("GET", "user_keys", nth: 1, with: .hold(gate))
        let model = try await Round2.settings(fake)

        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "user_keys") == 1 })
        await model.onAppear()
        #expect(await fake.count("GET", "user_keys") == 1)
        gate.open()
        await first.value
        #expect(model.keyPanel == Round2.shownKey)
    }

    @Test func theCalendarReadsAgainAtOnce() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["expected_date": "2026-11-05"])])
        let changes = DataChanges()
        let model = try await Round2.calendar(fake, changes: changes)
        await model.load()

        // Stale (another screen wrote), read on appearing, and the tab left at once.
        await fake.insert("parcels", [Rows.parcel(2, ["expected_date": "2026-11-06"])])
        changes.publish()
        let gate = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        first.cancel()
        await model.onAppear()
        #expect(await waitFor { await model.entries(on: "2026-11-06").map(\.id) == [Rows.id(2)] })

        gate.open()
        await first.value
        #expect(model.entries(on: "2026-11-06").map(\.id) == [Rows.id(2)])
    }

    @Test func spendReadsAgainAtOnce() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1000])])
        let changes = DataChanges()
        let model = try await Round2.spend(fake, changes: changes)
        await model.load()
        #expect(model.total?.total == 1000)

        await fake.insert("parcels", [Rows.parcel(2, ["ordered_at": "2026-11-03", "total_amount": 500])])
        changes.publish()
        let gate = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        first.cancel()
        await model.onAppear()
        #expect(await waitFor { await model.total?.total == 1500 }, "\(String(describing: model.total))")

        gate.open()
        await first.value
        #expect(model.total?.total == 1500)
    }
}

// MARK: - [N-new2] a cut-off read that a newer read superseded

/// [N-new2] Cancellation is judged after the fence: a cancelled read that a newer read superseded
/// leaves the newer read's state alone (no 「cut off」 mark, so no extra read on the next appearance).
@Suite("Round 2: a superseded cut-off read leaves the newer one alone (N-new2)", .serialized)
@MainActor
struct Round2SupersededCutOffTests {
    @Test func settings() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        let gate = Gate()
        await fake.fail("GET", "user_keys", nth: 1, with: .hold(gate))
        let model = try await Round2.settings(fake)

        let first = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "user_keys") == 1 })
        // A newer read is shown, then the old one is cut off (it is superseded by then).
        await model.load()
        #expect(model.keyPanel == Round2.shownKey)
        first.cancel()
        await first.value
        gate.open()

        let reads = await fake.count("GET", "user_keys")
        await model.onAppear()
        #expect(await fake.count("GET", "user_keys") == reads, "the newer read is shown: nothing to read again")
        #expect(model.keyPanel == Round2.shownKey)
    }

    @Test func theCalendar() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["expected_date": "2026-11-05"])])
        let model = try await Round2.calendar(fake)
        await model.load()

        let gate = Gate()
        let start = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: start + 1, with: .hold(gate))
        let first = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "parcels") == start + 1 })
        await model.load()
        first.cancel()
        await first.value
        gate.open()

        let reads = await fake.count("GET", "parcels")
        await model.onAppear()
        #expect(await fake.count("GET", "parcels") == reads)
        #expect(model.entries(on: "2026-11-05").map(\.id) == [Rows.id(1)])
    }

    @Test func spend() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1000])])
        let model = try await Round2.spend(fake)
        await model.load()

        let gate = Gate()
        let start = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: start + 1, with: .hold(gate))
        let first = Task { await model.load() }
        #expect(await waitFor { await fake.count("GET", "parcels") == start + 1 })
        await model.load()
        first.cancel()
        await first.value
        gate.open()

        let reads = await fake.count("GET", "parcels")
        await model.onAppear()
        #expect(await fake.count("GET", "parcels") == reads)
        #expect(model.total?.total == 1000)
    }
}

// MARK: - [N-new1] the pressed control's spinner compares UTF-16 units

/// [N-new1] Two shop rows whose names are canonically equivalent (NFC 「ガ」 and NFD 「カ」+U+3099) are two
/// rows (Codex #4); a tap on one must not show the spinner on both.
@Suite("Round 2: the spinner of the pressed shop row (N-new1)")
@MainActor
struct Round2SpinnerKeyTests {
    static let nfc = "ガ店"
    static let nfd = "\u{30AB}\u{3099}店"

    @Test func theTrap() {
        // Swift's == says one; the Web and the shop rows say two.
        #expect(("shop-" + Self.nfc) == ("shop-" + Self.nfd))
        #expect(Array(("shop-" + Self.nfc).utf16) != Array(("shop-" + Self.nfd).utf16))
    }

    @Test func onlyThePressedSpellingSpins() {
        let pressed = "shop-" + Self.nfc
        #expect(SpendSpinner.shows(pressed: pressed, key: "shop-" + Self.nfc, isMoving: true))
        #expect(SpendSpinner.shows(pressed: pressed, key: "shop-" + Self.nfd, isMoving: true) == false)
    }

    @Test func noSpinnerWithoutAMoveOrAPress() {
        #expect(SpendSpinner.shows(pressed: "shop-a", key: "shop-a", isMoving: false) == false)
        #expect(SpendSpinner.shows(pressed: nil, key: "shop-a", isMoving: true) == false)
    }
}

// MARK: - [SEC-N4] the Turnstile page's CSP pinned

/// [SEC-N4] The CSP meta agreed for SEC-N2: there, exactly once, before the first <style> and <script>,
/// with the agreed policy (pinned here as text, so a change to the constant fails too).
@Suite("Round 2: the Turnstile page's CSP (SEC-N4)")
struct Round2TurnstileCSPTests {
    static let agreed = "default-src 'none'; script-src 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; connect-src https://challenges.cloudflare.com; style-src 'unsafe-inline'"

    /// The meta with `policy` is there once, before the first <style> and the first <script>.
    static func cspComesFirst(_ html: String, policy: String = agreed) -> Bool {
        let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(policy)\">"
        guard let m = html.range(of: meta),
              html.components(separatedBy: "Content-Security-Policy").count == 2,
              let script = html.range(of: "<script") else { return false }
        if let style = html.range(of: "<style"), style.lowerBound < m.lowerBound { return false }
        return m.upperBound <= script.lowerBound
    }

    @Test func theConstantIsTheAgreedPolicy() {
        #expect(Turnstile.contentSecurityPolicy == Self.agreed)
    }

    @Test(arguments: [0, 1, 7, 12345])
    func thePageCarriesItFirst(generation: Int) {
        #expect(Self.cspComesFirst(Turnstile.html(generation: generation)))
    }

    /// Negative controls: the check fails for a page without the meta, with the meta after the first
    /// script, with a wider policy, and with a second CSP meta.
    @Test func theCheckCatchesTheBadShapes() {
        let page = Turnstile.html(generation: 1)
        let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(Self.agreed)\">"
        #expect(page.contains(meta))
        let without = page.replacingOccurrences(of: meta, with: "")
        #expect(Self.cspComesFirst(without) == false)
        let late = without.replacingOccurrences(of: "</body>", with: meta + "</body>")
        #expect(Self.cspComesFirst(late) == false)
        let wider = page.replacingOccurrences(of: "default-src 'none'", with: "default-src *")
        #expect(Self.cspComesFirst(wider) == false)
        let twice = page.replacingOccurrences(of: meta, with: meta + meta.replacingOccurrences(of: "'none'", with: "*"))
        #expect(Self.cspComesFirst(twice) == false)
    }
}
