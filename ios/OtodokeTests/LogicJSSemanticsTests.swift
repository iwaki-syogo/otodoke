import Foundation
import Testing
@testable import Otodoke

/// [Tasks 4–5, implementer] Inputs where JavaScript's string and regex rules differ from Swift's or ICU's,
/// which web-expected.json does not cover. Every expected value was produced by the Web's own functions
/// (`npx tsx`, 2026-11-05).
@Suite("Logic follows JavaScript's string rules (tasks 4–5)")
struct LogicJSSemanticsTests {
    @Test func caseFoldingIsAsciiOnlyAsUnderTheIFlag() {
        // ICU's case-insensitive mode would read ſ as s and drop the whole "script".
        #expect(HtmlText.htmlToText("<\u{017F}cript>x</\u{017F}cript>y") == "xy")
        #expect(HtmlText.htmlToText("<SCRIPT>x</script>y") == "y")
        #expect(Carriers.identifyCarrier(nil, hint: "\u{017F}eino").key == .unknown)
        #expect(Carriers.identifyCarrier(nil, hint: "ＹＡＭＡＴＯ").key == .unknown)
        #expect(HtmlText.decodeEntities("&#0065;&#x0041;&AmP;&#99999999999999999999;") == "AA&&#99999999999999999999;")
    }

    @Test func wordBoundaryAndEndOfInputAreJavaScripts() {
        // \b is ASCII in JS: "あ" ends the tag name "a"; "b" does not.
        #expect(HtmlText.htmlToText("<a\u{3042} href=\"https://e.com/1\">t</a>") == "t (https://e.com/1)")
        #expect(HtmlText.htmlToText("<ab href=\"https://e.com/1\">t</a>") == "t")
        // $ is the very end in JS: ".png" before a final newline is not an image link.
        #expect(HtmlText.htmlToText("<a href=\"https://e.com/a.png&#10;\">t</a>") == "t (https://e.com/a.png\n)")
    }

    @Test func whitespaceIsCountedInCodeUnits() {
        // \v is only U+000B in JS (ICU's \v is every vertical space); \r\n is two units, not one character.
        #expect(HtmlText.htmlToText("a\u{000B}\u{000B}b") == "a b")
        #expect(HtmlText.htmlToText("a\r\n\r\n\r\n\r\nb") == "a\n\nb")
        #expect(Carriers.amazonOrderTrackingUrl("\u{3000}250-1234567-1234567\u{3000}")
            == "https://www.amazon.co.jp/gp/your-account/order-details?orderID=250-1234567-1234567")
    }

    @Test func textIsSearchedByCodeUnitNotByCharacter() {
        // "ト" + a combining sound mark is one Character in Swift but still contains "ヤマト" for JS.
        #expect(Carriers.identifyCarrier(nil, hint: "ヤマト\u{3099}").key == .yamato)
        #expect(Carriers.normalizeTracking("١٢٣abc") == "ABC")
        #expect(Carriers.amazonOrderTrackingUrl("２５０-1234567-1234567") == nil)
    }

    @Test func numbersAndDatesAsTheWebWritesThem() {
        #expect(Format.yen(-1234) == "¥-1,234")
        #expect(Format.yen(1_234_567_890_123) == "¥1,234,567,890,123")
        #expect(Format.formatWindow(start: "8:00", end: "") == "8:00〜")
        // Date.UTC rolls 2/30 over to 3/2, a Monday, but the text keeps the day as written.
        #expect(Format.relativeDateJa("2026-02-30", today: "2026-11-04") == "2/30(月)")
    }

    @Test func instantsAreReadAsNewDateReadsThem() throws {
        var p = try Rows.parcelRow(Rows.parcel(1))
        p.lastEmailAt = "2026-10-21 14:59:59+00"
        #expect(ParcelRules.needsCheck(p, today: "2026-11-04") == true)
        p.lastEmailAt = "not a time"
        #expect(ParcelRules.needsCheck(p, today: "2026-11-04") == false)
    }

    @Test func theBaseOrderComparesMicrosecondsAsTheDatabaseDoes() throws {
        let a = try Rows.parcelRow(Rows.parcel(1, ["last_email_at": "2026-11-03T22:10:00.000001+00:00"]))
        let b = try Rows.parcelRow(Rows.parcel(2, ["last_email_at": "2026-11-03T22:10:00.000002+00:00"]))
        #expect(ParcelRules.baseOrder([a, b]).map(\.id) == [b.id, a.id])
    }

    @Test func swiftIsStricterThanWhatwgOnOddHttpsText() {
        // The Web says true for both; refusing them only hides a link, never shows an unsafe one.
        #expect(SafeURL.isHttpsUrl("https:example.com") == false)
        #expect(SafeURL.isHttpsUrl(" https://example.com") == false)
        #expect(SafeURL.isHttpsUrl("https://exa mple.com") == false)
    }
}
