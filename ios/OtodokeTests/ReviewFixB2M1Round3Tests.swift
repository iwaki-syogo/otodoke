import Foundation
import Testing
@testable import Otodoke

// [Batch 2, M1, review fix 3] Tests written before the fixes of review-fix2.md (HEAD 99c7228):
// N-r2-1, N-r2-4, N-r2-5.

/// A screen model's world against FakeSupabase (made-up rows only).
@MainActor
private enum Round3 {
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
}

// MARK: - [N-r2-1] the calendar's move whose newest read is cut off

/// [N-r2-1] Move read A, then a load() read B (pull to refresh, reading the month moved to), then B is
/// cut off: the move must not be dropped quietly. It stays on the way, and the next appearance reads
/// the month moved to.
@Suite("Round 3: the calendar's move whose newest read is cut off (N-r2-1)", .serialized)
@MainActor
struct Round3CalendarCutOffMoveTests {
    @Test func theNextAppearanceShowsTheMonthMovedTo() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [
            Rows.parcel(1, ["expected_date": "2026-11-05"]),
            Rows.parcel(8, ["expected_date": "2026-12-01"]),
        ])
        let model = try await Round3.calendar(fake)
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

        // B (the newest) is cut off and ends: the move is not shown, and not dropped either.
        b.cancel()
        gateB.open()
        await b.value
        #expect(model.month == "2026-11")
        #expect(model.isMoving, "the move is on the way until a read shows it")

        // A ends (superseded by B): nothing changes.
        gateA.open()
        await move.value
        #expect(model.month == "2026-11")

        // Shown again: the month moved to is read and shown.
        await model.onAppear()
        #expect(model.month == "2026-12")
        #expect(model.entries(on: "2026-12-01").map(\.id) == [Rows.id(8)])
        #expect(model.isMoving == false)
    }
}

// MARK: - [N-r2-4] the Turnstile page's CSP meta is inside <head>

/// [N-r2-4] The round-2 check (Round2TurnstileCSPTests.cspComesFirst) does not look at </head>: the meta
/// must also be inside <head> (a CSP meta in <body> is ignored by the browser).
@Suite("Round 3: the Turnstile page's CSP meta is inside <head> (N-r2-4)")
struct Round3TurnstileCSPInHeadTests {
    static let meta = "<meta http-equiv=\"Content-Security-Policy\" content=\"\(Round2TurnstileCSPTests.agreed)\">"

    /// The round-2 check, and the meta after the one <head> and before the one </head>.
    static func cspInHeadFirst(_ html: String) -> Bool {
        guard Round2TurnstileCSPTests.cspComesFirst(html),
              html.components(separatedBy: "<head>").count == 2,
              html.components(separatedBy: "</head>").count == 2,
              let head = html.range(of: "<head>"),
              let headEnd = html.range(of: "</head>"),
              let m = html.range(of: meta) else { return false }
        return head.upperBound <= m.lowerBound && m.upperBound <= headEnd.lowerBound
    }

    @Test(arguments: [0, 1, 7, 12345])
    func thePageCarriesItInsideHead(generation: Int) {
        #expect(Self.cspInHeadFirst(Turnstile.html(generation: generation)))
    }

    /// Negative controls: the meta moved to the top of <body> fails; also with the <style> moved along
    /// (a shape the round-2 check alone lets through).
    @Test func theCheckCatchesTheMetaInBody() {
        let page = Turnstile.html(generation: 1)
        #expect(page.contains(Self.meta))
        #expect(page.contains("<body>"))
        let without = page.replacingOccurrences(of: Self.meta, with: "")

        let bodyFirst = without.replacingOccurrences(of: "<body>", with: "<body>" + Self.meta)
        #expect(Self.cspInHeadFirst(bodyFirst) == false)

        let style = "<style>html,body{margin:0;padding:0;background:transparent;}</style>"
        #expect(page.contains(style))
        let bodyFirstWithStyle = without
            .replacingOccurrences(of: style, with: "")
            .replacingOccurrences(of: "<body>", with: "<body>" + Self.meta + style)
        #expect(Round2TurnstileCSPTests.cspComesFirst(bodyFirstWithStyle), "the round-2 check alone misses it")
        #expect(Self.cspInHeadFirst(bodyFirstWithStyle) == false)
    }
}

// MARK: - [N-r2-5] a read on the way that was not cut off is not started twice

/// [N-r2-5] Negative controls for CX-f2 on the calendar and spend (the settings has one in round 2): an
/// appearance while a read is on the way and not cut off sends no second GET (the cut-off signal must
/// be raised, not merely there).
@Suite("Round 3: no second read while a read is on the way (N-r2-5)", .serialized)
@MainActor
struct Round3NoSecondReadTests {
    @Test func theCalendar() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["expected_date": "2026-11-05"])])
        let changes = DataChanges()
        let model = try await Round3.calendar(fake, changes: changes)
        await model.load()

        // Stale (another screen wrote): read on appearing, and shown again while it is on the way.
        await fake.insert("parcels", [Rows.parcel(2, ["expected_date": "2026-11-06"])])
        changes.publish()
        let gate = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        await model.onAppear()
        #expect(await fake.count("GET", "parcels") == reads + 1)

        gate.open()
        await first.value
        #expect(model.entries(on: "2026-11-06").map(\.id) == [Rows.id(2)])
        #expect(await fake.count("GET", "parcels") == reads + 1)
    }

    @Test func spend() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1000])])
        let changes = DataChanges()
        let model = try await Round3.spend(fake, changes: changes)
        await model.load()
        #expect(model.total?.total == 1000)

        await fake.insert("parcels", [Rows.parcel(2, ["ordered_at": "2026-11-03", "total_amount": 500])])
        changes.publish()
        let gate = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        await model.onAppear()
        #expect(await fake.count("GET", "parcels") == reads + 1)

        gate.open()
        await first.value
        #expect(model.total?.total == 1500)
        #expect(await fake.count("GET", "parcels") == reads + 1)
    }
}
