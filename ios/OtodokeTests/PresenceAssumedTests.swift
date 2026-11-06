import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 27 (iOS-6), moved to M1 on 11/6 13:55] 「🤝 念のため対面」: face-to-face only because no
/// mail said otherwise (faceToFaceAssumed of src/lib/match, 2541793), worded apart from what a mail said,
/// still red and counted as face-to-face. The Web's branches (parcel-card.tsx PresenceBadge, the detail
/// page's 受け取り row, the calendar's day heading) copied by hand.
@Suite("Presence assumed (batch 2, task 27)")
struct PresenceAssumedTests {
    private func row(_ over: Row) throws -> ParcelRow { try Rows.parcelRow(Rows.parcel(1, over)) }

    @Test func parityWithTheWeb() throws {
        let fx = try WebExpectedM1.load()
        #expect(fx.match.faceToFaceAssumed.contains { $0.out })
        #expect(fx.match.faceToFaceAssumed.contains { !$0.out })
        for c in fx.match.faceToFaceAssumed {
            #expect(ParcelRules.faceToFaceAssumed(c.parcel) == c.out, "\(c.parcel.id)")
        }
    }

    @Test func assumedOnlyByTheDefault() throws {
        #expect(ParcelRules.faceToFaceAssumed(try row(["requires_presence": nil])) == true)
        #expect(ParcelRules.faceToFaceAssumed(try row(["requires_presence": true])) == false)
        #expect(ParcelRules.faceToFaceAssumed(try row(["requires_presence": false])) == false)
        // Amazon with nothing stored is unknown, not face-to-face: never assumed.
        #expect(ParcelRules.faceToFaceAssumed(try row(["requires_presence": nil, "shop_key": "amazon"])) == false)
    }

    @Test func theWords() {
        #expect(BadgeText.assumedFaceToFace == "念のため対面")
    }

    @Test func theBadge() throws {
        let assumed = try row(["requires_presence": nil])
        let stated = try row(["requires_presence": true])
        let notNeeded = try row(["requires_presence": false])
        #expect(BadgeText.presence(for: assumed, compact: true) == "🤝 念のため対面")
        #expect(BadgeText.presence(for: assumed, compact: false) == "🤝 念のため対面")
        #expect(BadgeText.presence(for: stated, compact: true) == "🤝 対面受け取り")
        #expect(BadgeText.presence(for: stated, compact: false) == "🤝 対面受け取りが必要")
        #expect(BadgeText.presence(for: notNeeded, compact: true) == "置き配・投函OK")
        #expect(BadgeText.presence(for: try row(["shop_key": "amazon"]), compact: true) == nil)
    }

    @Test func theDetailRowSaysWhatItRestsOn() throws {
        let mail = ParcelDetailFields.make(try row(["requires_presence": nil, "presence_evidence": "置き配を指定できます"]), today: "2026-11-04")
        #expect(mail.presence == "念のため対面")
        #expect(mail.presenceAssumedNote == "メールに記載なし")
        // The evidence line is not shown for an assumption.
        #expect(mail.presenceEvidence == nil)

        let manual = ParcelDetailFields.make(try row(["requires_presence": nil, "source": "manual"]), today: "2026-11-04")
        #expect(manual.presence == "念のため対面")
        #expect(manual.presenceAssumedNote == "指定なし")
        #expect(manual.presenceBadge == "🤝 念のため対面")
    }

    @Test func aStatedPresenceKeepsItsEvidence() throws {
        let stated = ParcelDetailFields.make(try row(["requires_presence": true, "presence_evidence": "対面でお渡しします"]), today: "2026-11-04")
        #expect(stated.presence == "対面受け取りが必要")
        #expect(stated.presenceAssumedNote == nil)
        #expect(stated.presenceEvidence == "対面でお渡しします")
        #expect(stated.presenceBadge == "🤝 対面受け取りが必要")
    }
}

/// [Batch 2, task 29, M1] normalizeTracking reads full-width characters as half-width (NFKC) first, as
/// the Web does since 8a07200. The fixture (WebParity2Tests.normalizeTracking) carries the Web's answers;
/// these pin the two changed cases and the two meanings another session checked still hold.
@Suite("Tracking numbers NFKC (batch 2, task 29)")
struct TrackingNFKCTests {
    @Test func fullWidthDigitsAndLettersAreKept() {
        #expect(Carriers.normalizeTracking("１２３４－５６７８－９０１２") == "123456789012")
        #expect(Carriers.normalizeTracking("ＴＢＡ１２３") == "TBA123")
    }

    @Test func digitsOfOtherScriptsAreStillDropped() {
        #expect(Carriers.normalizeTracking("١٢٣abc") == "ABC")
    }

    @Test func aFullWidthAmazonOrderNumberGetsNoLink() {
        #expect(Carriers.amazonOrderTrackingUrl("２５０-１２３４５６７-１２３４５６７") == nil)
        #expect(Carriers.amazonOrderTrackingUrl("250-1234567-1234567") != nil)
    }
}
