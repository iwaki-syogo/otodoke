import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 20] The delivered page's logic (src/lib/delivered.ts of 2541793) against the Web's own answers
/// in web-expected.json (the delivered section scripts/ios-fixtures.ts writes): every case, in every time zone
/// the parity suites use. NFKC and JavaScript's toLowerCase on the special characters (a capital sigma at a
/// word's end, a dotted capital I, half-width katakana, compatibility characters), UTF-16 order, stable sorts.
@Suite("Web parity 4: delivered (batch 2, task 20)", .serialized)
struct WebParity4Tests {
    let fx: WebExpectedM2

    init() throws {
        fx = try WebExpectedM2.load()
    }

    private static func ids(_ rows: [ParcelRow]) -> [String] { rows.map(\.id) }
    private static func groups(_ g: [(label: String, parcels: [ParcelRow])]) -> [WebExpectedM2.Group] {
        g.map { WebExpectedM2.Group(label: $0.label, ids: ids($0.parcels)) }
    }

    @Test func theSectionIsThere() {
        let d = fx.delivered
        #expect(!d.groupByOrderMonth.isEmpty)
        #expect(!d.itemNamesByParcel.isEmpty)
        #expect(!d.searchWord.isEmpty)
        #expect(!d.filterDelivered.isEmpty)
        #expect(!d.deliveredFilterOptions.isEmpty)
        #expect(!d.monthChoices.isEmpty)
    }

    @Test func theConstants() {
        #expect(Delivered.noOrderDateLabel == fx.delivered.noOrderDateLabel)
        #expect(Delivered.searchMax == fx.delivered.searchMax)
    }

    @Test(arguments: parityTimeZones)
    func groupByOrderMonth(zone: String) {
        withDefaultTimeZone(zone) {
            for (i, c) in fx.delivered.groupByOrderMonth.enumerated() {
                #expect(Self.groups(Delivered.groupByOrderMonth(c.parcels)) == c.out, "case \(i)")
            }
        }
    }

    /// The spend screen's copy (M1) gives the same months.
    @Test func spendsGroupByOrderMonthIsTheSame() {
        for (i, c) in fx.delivered.groupByOrderMonth.enumerated() {
            #expect(Self.groups(Spend.groupByOrderMonth(c.parcels)) == c.out, "case \(i)")
        }
    }

    @Test func itemNamesByParcel() {
        for (i, c) in fx.delivered.itemNamesByParcel.enumerated() {
            #expect(Delivered.itemNamesByParcel(c.items) == c.out, "case \(i)")
        }
    }

    @Test func searchWord() {
        for c in fx.delivered.searchWord {
            #expect(Delivered.searchWord(c.q) == c.out, "\(String(describing: c.q))")
            #expect(Delivered.searchWord(c.q).utf16.count <= Delivered.searchMax)
        }
    }

    @Test(arguments: parityTimeZones)
    func filterDelivered(zone: String) {
        withDefaultTimeZone(zone) {
            for (i, c) in fx.delivered.filterDelivered.enumerated() {
                let got = Delivered.filterDelivered(c.parcels, itemNames: Delivered.itemNamesByParcel(c.items), values: DeliveredFilterValues(q: c.q, s: c.s, c: c.c, m: c.m))
                #expect(Self.ids(got) == c.out, "case \(i) q=\(String(describing: c.q)) s=\(String(describing: c.s)) c=\(String(describing: c.c)) m=\(String(describing: c.m))")
            }
        }
    }

    @Test func deliveredFilterOptions() {
        for (i, c) in fx.delivered.deliveredFilterOptions.enumerated() {
            let got = Delivered.deliveredFilterOptions(c.parcels)
            #expect(got.shops == c.out.shops, "case \(i)")
            #expect(got.months == c.out.months, "case \(i)")
            #expect(got.categories.map { WebExpectedM2.DeliveredCases.Category(value: $0.value, label: $0.label) } == c.out.categories, "case \(i)")
        }
    }

    @Test func monthChoices() {
        for c in fx.delivered.monthChoices {
            #expect(Delivered.monthChoices(c.months, m: c.m) == c.out, "\(c.months) \(String(describing: c.m))")
        }
    }

    // Hand-written checks of the folding, beside the fixture (the reasons a case is there).

    @Test func theWordAndTheTextsAreFoldedAlike() throws {
        let row = try Rows.parcelRow(Rows.parcel(1, ["title": "ＡＢＣカメラ ﾃﾞｼﾞﾀﾙ", "status": "delivered"]))
        for q in ["abc", "ＡＢＣ", "ABC", "デジタル", "ﾃﾞｼﾞﾀﾙ", "ａｂｃカメラ"] {
            #expect(Delivered.filterDelivered([row], itemNames: [:], values: DeliveredFilterValues(q: q)).count == 1, "\(q)")
        }
        #expect(Delivered.filterDelivered([row], itemNames: [:], values: DeliveredFilterValues(q: "xyz")).isEmpty)
        // Only the item names hold the word.
        #expect(Delivered.filterDelivered([row], itemNames: [row.id: ["予備バッテリー"]], values: DeliveredFilterValues(q: "バッテリー")).count == 1)
    }
}
