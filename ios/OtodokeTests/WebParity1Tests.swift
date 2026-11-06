import Foundation
import Testing
@testable import Otodoke

/// [Task 4] Differential tests: every case of web-expected.json's `format`, `match`, `sections`,
/// `undelivered` and `unread`, run through the Swift ports, under several default time zones
/// (the scheme also runs the whole suite with TZ=UTC). Each list must be non-empty: an empty
/// fixture must not pass.
@Suite("Web parity 1: format, match, sections, undelivered, unread (task 4)", .serialized)
struct WebParity1Tests {
    let expected: WebExpected

    init() throws {
        expected = try WebExpected.load()
    }

    // MARK: format

    @Test(arguments: parityTimeZones)
    func todayJst(zone: String) throws {
        let cases = expected.format.todayJst
        #expect(!cases.isEmpty)
        for c in cases {
            let now = try #require(ISO.date(c.now), "unparsable now \(c.now)")
            #expect(withDefaultTimeZone(zone) { Format.todayJst(now: now) } == c.out, "now=\(c.now)")
        }
    }

    @Test(arguments: parityTimeZones)
    func formatDateJa(zone: String) {
        let cases = expected.format.formatDateJa
        #expect(!cases.isEmpty)
        for c in cases {
            let got = withDefaultTimeZone(zone) { Format.formatDateJa(c.ymd, withYear: c.withYear ?? false, today: c.today) }
            #expect(got == c.out, "ymd=\(c.ymd ?? "nil") withYear=\(c.withYear ?? false) today=\(c.today)")
        }
    }

    @Test(arguments: parityTimeZones)
    func relativeDateJa(zone: String) {
        let cases = expected.format.relativeDateJa
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(withDefaultTimeZone(zone) { Format.relativeDateJa(c.ymd, today: c.today) } == c.out, "ymd=\(c.ymd ?? "nil") today=\(c.today)")
        }
    }

    @Test func formatWindow() {
        let cases = expected.format.formatWindow
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(Format.formatWindow(start: c.start, end: c.end) == c.out, "start=\(c.start ?? "nil") end=\(c.end ?? "nil")")
        }
    }

    @Test func yen() {
        let cases = expected.format.yen
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(Format.yen(c.n) == c.out, "n=\(c.n.map(String.init) ?? "nil")")
        }
    }

    @Test(arguments: parityTimeZones)
    func formatDateTimeJa(zone: String) {
        let cases = expected.format.formatDateTimeJa
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(withDefaultTimeZone(zone) { Format.formatDateTimeJa(c.iso, today: c.today) } == c.out, "iso=\(c.iso ?? "nil") today=\(c.today)")
        }
    }

    @Test func labels() {
        #expect(!expected.format.statusLabel.isEmpty)
        #expect(Format.statusLabel == expected.format.statusLabel)
        #expect(!expected.format.relevanceLabel.isEmpty)
        #expect(Format.relevanceLabel == expected.format.relevanceLabel)
    }

    // MARK: match

    @Test func lastExpectedDay() {
        let cases = expected.match.lastExpectedDay
        #expect(!cases.isEmpty)
        for c in cases {
            let got: JSONValue = ParcelRules.lastExpectedDay(c.parcel).map { .string($0) } ?? .null
            #expect(got == c.out, "parcel \(c.parcel.id)")
        }
    }

    @Test(arguments: parityTimeZones)
    func needsCheck(zone: String) throws {
        let cases = expected.match.needsCheck
        #expect(!cases.isEmpty)
        for c in cases {
            let today = try #require(c.today)
            let got = withDefaultTimeZone(zone) { ParcelRules.needsCheck(c.parcel, today: today) }
            #expect(JSONValue.bool(got) == c.out, "parcel \(c.parcel.id) today=\(today)")
        }
    }

    @Test(arguments: parityTimeZones)
    func isLate(zone: String) throws {
        let cases = expected.match.isLate
        #expect(!cases.isEmpty)
        for c in cases {
            let today = try #require(c.today)
            let got = withDefaultTimeZone(zone) { ParcelRules.isLate(c.parcel, today: today) }
            #expect(JSONValue.bool(got) == c.out, "parcel \(c.parcel.id) today=\(today)")
        }
    }

    @Test func faceToFace() {
        let cases = expected.match.faceToFace
        #expect(!cases.isEmpty)
        for c in cases {
            let got: JSONValue = ParcelRules.faceToFace(c.parcel).map { .bool($0) } ?? .null
            #expect(got == c.out, "parcel \(c.parcel.id)")
        }
    }

    // MARK: sections and order

    @Test(arguments: parityTimeZones)
    func sections(zone: String) {
        let cases = expected.sections
        #expect(!cases.isEmpty)
        for (i, c) in cases.enumerated() {
            let s = withDefaultTimeZone(zone) { ParcelRules.sections(c.parcels, today: c.today) }
            #expect(s.toCheck.map(\.id) == c.out.toCheck, "case \(i) 要確認")
            #expect(s.delivering.map(\.id) == c.out.delivering, "case \(i) 配達中")
            #expect(s.soon.map(\.id) == c.out.soon, "case \(i) もうすぐ届く")
            #expect(s.ordered.map(\.id) == c.out.ordered, "case \(i) 注文中")
            let open = c.parcels.filter { $0.status != "delivered" && $0.status != "cancelled" }.map(\.id)
            #expect(s.open.map(\.id) == open, "case \(i) open")
        }
    }

    @Test func baseOrderRebuildsTheDatabasesOrderFromAShuffle() {
        let cases = expected.sections
        #expect(!cases.isEmpty)
        for (i, c) in cases.enumerated() {
            for seed in UInt64(1)...UInt64(8) {
                var rng = SplitMix64(seed: seed)
                let shuffled = c.parcels.shuffled(using: &rng)
                #expect(ParcelRules.baseOrder(shuffled).map(\.id) == c.parcels.map(\.id), "case \(i) seed \(seed)")
            }
        }
    }

    @Test func sectionsOfAShuffleInBaseOrderMatchTheWeb() {
        for (i, c) in expected.sections.enumerated() {
            var rng = SplitMix64(seed: 42)
            let s = ParcelRules.sections(ParcelRules.baseOrder(c.parcels.shuffled(using: &rng)), today: c.today)
            #expect(s.soon.map(\.id) == c.out.soon, "case \(i)")
            #expect(s.toCheck.map(\.id) == c.out.toCheck, "case \(i)")
        }
    }

    // MARK: undelivered and unread

    @Test func undeliveredStatus() {
        let cases = expected.undelivered
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(StatusRules.undeliveredStatus(trackingNumber: c.row.trackingNumber, carrier: c.row.carrier) == c.out,
                    "tracking=\(c.row.trackingNumber.debugDescription) carrier=\(c.row.carrier.debugDescription)")
        }
    }

    @Test(arguments: parityTimeZones)
    func unreadFilter(zone: String) throws {
        let cases = expected.unread
        #expect(!cases.isEmpty)
        for c in cases {
            let now = try #require(ISO.date(c.now))
            #expect(withDefaultTimeZone(zone) { StatusRules.unreadFilter(now: now) } == c.out, "now=\(c.now)")
        }
    }

    @Test func restorableIsTheWebsList() {
        #expect(StatusRules.restorable == ["ordered", "shipped", "out_for_delivery", "attempted", "unknown"])
        #expect(StatusRules.pendingGrace == 180)
        #expect(ParcelRules.checkAfterDays == 14)
    }
}
