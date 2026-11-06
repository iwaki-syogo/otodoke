import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, M1, review fix 1, implementer's own] normalizeTracking as the Web's ded1789: only the
/// full-width ASCII forms are folded (not NFKC: № and ① are dropped like any mark), and a leading
/// "No." / "No:" label goes. The expected values follow the Web's rule
/// (halfWidth(raw).replace(/^[^0-9A-Za-z]*no\s*[.:]/i, "").replace(/[^0-9A-Za-z]/g, "").toUpperCase()).
/// web-expected.json takes these cases once the Web is on dev.
@Suite("Tracking numbers: full-width forms and the No. label (review fix 1)")
struct TrackingLabelTests {
    @Test(arguments: [
        ("№1234-5678-9012", "123456789012"),
        ("①1234-5678-9012", "123456789012"),
        ("Ｎｏ．１２３４－５６７８－９０１２", "123456789012"),
        ("伝票No.1234-5678-9012", "123456789012"),
        ("No:EJ123456789JP", "EJ123456789JP"),
        ("No . 123", "123"),
        ("No.", ""),
        ("No123456789012", "NO123456789012"),
        ("NO123456789JP", "NO123456789JP"),
        ("Nov.123", "NOV123"),
        // JavaScript's \s between the label and its mark (ideographic space, no-break space, a tab).
        ("No\u{3000}.123", "123"),
        ("no\u{00A0}:123", "123"),
        ("NO\t.123", "123"),
        // Only at the start (after marks), once.
        ("（No.123）", "123"),
        ("123 No.456", "123NO456"),
        ("No.No.123", "NO123"),
    ])
    func theWebsRule(input: String, expected: String) {
        #expect(Carriers.normalizeTracking(input) == expected, "in=\(input)")
    }

    @Test func theFullWidthCasesOfTheFixtureAreUnchanged() {
        #expect(Carriers.normalizeTracking("１２３４－５６７８－９０１２") == "123456789012")
        #expect(Carriers.normalizeTracking("ＴＢＡ１２３") == "TBA123")
    }

    @Test func otherScriptsAndCompatibilityFormsAreDropped() {
        #expect(Carriers.normalizeTracking("١٢٣abc") == "ABC")
        // Not NFKC: the circled digit and the numero sign are marks, not "1" and "No".
        #expect(Carriers.normalizeTracking("①②③") == "")
        #expect(Carriers.normalizeTracking("№") == "")
    }

    @Test func theCarrierFollowsTheNumberWithoutItsLabel() {
        #expect(Carriers.identifyCarrier("No:EJ123456789JP", hint: nil).key == .japanpost)
        // ① no longer makes 13 digits (a Japan Post shape).
        #expect(Carriers.identifyCarrier("①1234-5678-9012", hint: nil).key == .unknown)
        #expect(Carriers.identifyCarrier("伝票No.1234-5678-9012", hint: "ヤマト運輸").key == .yamato)
    }

    @Test func aFullWidthAmazonOrderNumberStillGetsNoLink() {
        #expect(Carriers.amazonOrderTrackingUrl("２５０-１２３４５６７-１２３４５６７") == nil)
        #expect(Carriers.amazonOrderTrackingUrl("250-1234567-1234567") != nil)
    }
}
