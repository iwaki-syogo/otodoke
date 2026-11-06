import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 5] The M1 ports against the Web's own answers (web-expected.json, written by
/// scripts/ios-fixtures.ts from the TypeScript functions of 2541793): calendar, spend, shop, the month
/// helpers and forwarding. Every case, in every time zone the batch-1 parity suites use.
@Suite("Web parity 3: calendar, spend, shop, month, forwarding (batch 2, task 5)", .serialized)
struct WebParity3Tests {
    /// A missing section fails each test (never the whole process).
    let fx: WebExpectedM1

    init() throws {
        fx = try WebExpectedM1.load()
    }

    private static func category(_ raw: String?) -> ParcelCategory? { raw.flatMap(ParcelCategory.init(rawValue:)) }
    private static func ids(_ rows: [ParcelRow]) -> [String] { rows.map(\.id) }

    private static func filter(c: String?, set: Bool) -> CategoryFilter {
        guard set else { return .any }
        guard let c else { return .uncategorized }
        return ParcelCategory(rawValue: c).map(CategoryFilter.only) ?? .any
    }

    private static func bars(_ out: [WebExpectedM1.BarOut]) -> [Spend.MonthBar] {
        out.map { b in
            Spend.MonthBar(month: b.month, total: b.total, segments: b.segments.map { Spend.Segment(category: category($0.category), amount: $0.amount) })
        }
    }

    @Test func theFixtureHasEverySection() {
        let f = fx
        #expect(!f.calendar.upcomingByDay.isEmpty)
        #expect(!f.spend.spendSlices.isEmpty)
        #expect(!f.spend.axisTicks.isEmpty)
        #expect(!f.spend.tickLabel.isEmpty)
        #expect(!f.shop.shopLabel.isEmpty)
        #expect(!f.month.shiftMonth.isEmpty)
        #expect(!f.forwarding.confirmUrl.isEmpty)
    }

    // MARK: calendar

    @Test(arguments: parityTimeZones)
    func upcomingByDay(zone: String) {
        withDefaultTimeZone(zone) {
            for c in fx.calendar.upcomingByDay {
                let got = CalendarRules.upcomingByDay(c.parcels, today: c.today, first: c.first, last: c.last).mapValues(Self.ids)
                #expect(got == c.out, "today \(c.today) \(c.first)…\(c.last)")
            }
        }
    }

    // MARK: spend

    @Test func spendMonthParam() {
        for c in fx.spend.spendMonthParam {
            #expect(Spend.spendMonthParam(c.m, today: c.today) == c.out, "\(String(describing: c.m))")
        }
    }

    @Test func spendTotal() {
        for c in fx.spend.spendTotal {
            let t = Spend.total(c.parcels)
            #expect(WebExpectedM1.TotalOut(total: t.total, priced: t.priced, unpriced: t.unpriced) == c.out)
        }
    }

    @Test func categoryOf() {
        for c in fx.spend.categoryOf {
            #expect(Spend.categoryOf(c.input)?.rawValue == c.out, "\(String(describing: c.input))")
        }
    }

    @Test func spendByCategory() {
        for c in fx.spend.spendByCategory {
            let want = c.out.map { Spend.CategoryAmount(category: Self.category($0.category), amount: $0.amount, share: $0.share) }
            #expect(Spend.byCategory(c.parcels) == want)
        }
    }

    @Test func sharePercent() {
        for c in fx.spend.sharePercent {
            #expect(Spend.sharePercent(c.input) == c.out, "\(c.input)")
        }
    }

    @Test func spendByMonth() {
        for c in fx.spend.spendByMonth {
            #expect(Spend.byMonth(c.parcels) == Self.bars(c.out))
        }
    }

    @Test func withEmptyMonths() {
        for c in fx.spend.withEmptyMonths {
            #expect(Spend.withEmptyMonths(Self.bars(c.input)) == Self.bars(c.out), "\(c.input.first?.month ?? "")…\(c.input.last?.month ?? "")")
        }
        #expect(Spend.maxFilledMonths == 240)
    }

    @Test func axisTicks() {
        for c in fx.spend.axisTicks {
            #expect(Spend.axisTicks(c.input) == c.out, "\(c.input)")
        }
    }

    @Test func tickLabel() {
        for c in fx.spend.tickLabel {
            #expect(Spend.tickLabel(c.input) == c.out, "\(c.input)")
        }
    }

    @Test(arguments: parityTimeZones)
    func spendSlices(zone: String) {
        withDefaultTimeZone(zone) {
            for c in fx.spend.spendSlices {
                let s = Spend.slices(c.parcels, all: c.all, category: Self.filter(c: c.c, set: c.cSet), shop: c.s)
                #expect(Self.ids(s.picked) == c.out.picked)
                #expect(Self.ids(s.orders) == c.out.orders)
                #expect(Self.ids(s.byCategory) == c.out.byCategory)
                #expect(Self.ids(s.byShop) == c.out.byShop)
                #expect(s.undated == c.out.undated)
            }
        }
    }

    // MARK: shop

    @Test func shopConstants() {
        #expect(Shop.none == fx.shop.none)
        #expect(Shop.labelMax == fx.shop.labelMax)
    }

    @Test func normalizeShop() {
        for c in fx.shop.normalizeShop {
            #expect(Shop.normalizeShop(shop: c.shop, shopKey: c.shopKey) == c.out)
        }
    }

    @Test func shopLabelCountsCodePoints() {
        for c in fx.shop.shopLabel {
            #expect(Shop.shopLabel(c.input) == c.out, "\(c.input.unicodeScalars.count) code points")
        }
    }

    @Test func firstParam() {
        for c in fx.shop.firstParam {
            #expect(Shop.firstParam(c.input.queryValues) == c.out, "\(c.input)")
        }
    }

    @Test func categoryParam() {
        for c in fx.shop.categoryParam {
            #expect(Shop.categoryParam(c.input.queryValues) == Self.filter(c: c.out, set: c.outSet), "\(c.input)")
        }
    }

    // MARK: month

    @Test func monthMinAndMax() {
        #expect(Format.monthMin == fx.month.min)
        for c in fx.month.monthMax {
            #expect(Format.monthMax(today: c.today) == c.out)
        }
    }

    @Test(arguments: parityTimeZones)
    func monthHelpers(zone: String) {
        withDefaultTimeZone(zone) {
            let m = fx.month
            for c in m.monthOf { #expect(Format.monthOf(c.input) == c.out, "\(c.input)") }
            for c in m.monthLabel { #expect(Format.monthLabel(c.ym, today: c.today) == c.out, "\(c.ym) \(c.today)") }
            for c in m.monthParam { #expect(Format.monthParam(c.m, today: c.today) == c.out, "\(String(describing: c.m))") }
            for c in m.shiftMonth { #expect(Format.shiftMonth(c.ym, c.delta) == c.out, "\(c.ym) \(c.delta)") }
            for c in m.splitDate {
                let got = Format.splitDate(c.input).map { WebExpectedM1.MonthCases.Parts(y: $0.y, m: $0.m, d: $0.d) }
                #expect(got == c.out, "\(c.input)")
            }
            for c in m.weekdayOf { #expect(Format.weekdayOf(c.input) == c.out, "\(c.input)") }
            for c in m.addDays { #expect(Format.addDays(c.ymd, c.days) == c.out, "\(c.ymd) \(c.days)") }
            for c in m.daysInMonth { #expect(Format.daysInMonth(c.y, c.m) == c.out, "\(c.y)-\(c.m)") }
        }
    }

    // MARK: forwarding (task 10's logic, CX4)

    @Test func isForwardingConfirmation() {
        for c in fx.forwarding.isForwardingConfirmation {
            #expect(Forwarding.isForwardingConfirmation(c.input) == c.out, "\(c.input)")
        }
    }

    @Test func forwardingConfirmUrl() {
        for c in fx.forwarding.forwardingConfirmUrl {
            #expect(Forwarding.forwardingConfirmUrl(c.input) == c.out, "\(c.input)")
        }
    }

    @Test func confirmUrlTriesTheStoredValueThenTheBody() {
        for c in fx.forwarding.confirmUrl {
            #expect(Forwarding.confirmURL(stored: c.forwardingConfirmUrl, textBody: c.textBody, htmlBody: c.htmlBody) == c.out)
        }
    }
}
