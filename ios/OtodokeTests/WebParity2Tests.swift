import Foundation
import Testing
@testable import Otodoke

/// [Task 5] Differential tests: every case of web-expected.json's `carriers`, `safeUrl`, `category` and
/// `text`, run through the Swift ports (also under other default time zones; the scheme runs TZ=UTC).
@Suite("Web parity 2: carriers, safeUrl, category, text (task 5)", .serialized)
struct WebParity2Tests {
    let expected: WebExpected

    init() throws {
        expected = try WebExpected.load()
    }

    // MARK: carriers

    @Test func normalizeTracking() {
        let cases = expected.carriers.normalizeTracking
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(Carriers.normalizeTracking(c.input) == c.out, "in=\(c.input)")
        }
    }

    @Test(arguments: parityTimeZones)
    func identifyCarrier(zone: String) {
        let cases = expected.carriers.identifyCarrier
        #expect(!cases.isEmpty)
        for c in cases {
            let info = withDefaultTimeZone(zone) { Carriers.identifyCarrier(c.tracking, hint: c.hint) }
            #expect(info.key.rawValue == c.out.key, "tracking=\(c.tracking.debugDescription) hint=\(c.hint.debugDescription)")
            #expect(info.name == c.out.name, "tracking=\(c.tracking.debugDescription) hint=\(c.hint.debugDescription)")
        }
    }

    @Test func trackingLinkFor() {
        let cases = expected.carriers.trackingLinkFor
        #expect(!cases.isEmpty)
        for c in cases {
            let want = c.out?.trackingLink
            if c.out != nil { #expect(want != nil, "unknown kind \(c.out?.kind ?? "")") }
            #expect(Carriers.trackingLinkFor(c.tracking, hint: c.hint) == want, "tracking=\(c.tracking.debugDescription) hint=\(c.hint.debugDescription)")
        }
    }

    @Test func amazonOrderTrackingUrl() {
        let cases = expected.carriers.amazonOrderTrackingUrl
        #expect(!cases.isEmpty)
        for c in cases {
            #expect(Carriers.amazonOrderTrackingUrl(c.input) == c.out, "in=\(c.input.debugDescription)")
        }
    }

    @Test func everyCarrierLinkIsHttps() {
        for c in expected.carriers.trackingLinkFor {
            guard let link = Carriers.trackingLinkFor(c.tracking, hint: c.hint) else { continue }
            let url: String
            switch link {
            case let .open(u): url = u
            case let .post(u, _): url = u
            case let .copy(u, _): url = u
            }
            #expect(URL(string: url)?.scheme == "https", "\(url)")
        }
    }

    // MARK: safeUrl

    @Test func safeUrl() {
        let cases = expected.safeUrl
        #expect(!cases.isEmpty)
        for c in cases {
            switch c.input {
            case let .string(s):
                #expect(SafeURL.isHttpsUrl(s) == c.out, "in=\(s)")
            case .null:
                #expect(SafeURL.isHttpsUrl(nil) == c.out)
            default:
                // Not text: the Web answers false, and Swift only ever sees text or nil.
                #expect(c.out == false)
            }
        }
    }

    @Test(arguments: [
        "http://example.com/t/1",
        "HTTP://example.com/t/1",
        "javascript:alert(1)",
        "JavaScript:alert(1)",
        "data:text/html,<b>x</b>",
        "https://",
        "ftp://example.com/x",
        "",
        "//example.com/t/1",
        "/t/1",
    ])
    func refusesWhatIsNotAnHttpsLink(raw: String) {
        #expect(SafeURL.isHttpsUrl(raw) == false)
    }

    @Test func acceptsAnHttpsLink() {
        #expect(SafeURL.isHttpsUrl("https://example.com/track?id=1") == true)
        #expect(SafeURL.isHttpsUrl(nil) == false)
    }

    // MARK: category

    @Test func categoryKeysLabelsAndColors() {
        let c = expected.category
        #expect(c.keys.count == 7)
        #expect(ParcelCategory.allCases.map(\.rawValue) == c.keys)
        for cat in ParcelCategory.allCases {
            #expect(cat.label == c.labels[cat.rawValue], "\(cat)")
            #expect(cat.colorHex == c.colors[cat.rawValue], "\(cat)")
            #expect(ParcelCategory.label(for: cat.rawValue) == cat.label)
        }
        #expect(ParcelCategory.uncategorizedLabel == c.uncategorizedLabel)
        #expect(ParcelCategory.uncategorizedColorHex == c.uncategorizedColor)
        #expect(ParcelCategory.label(for: nil) == c.uncategorizedLabel)
        #expect(ParcelCategory.label(for: "bogus") == c.uncategorizedLabel)
    }

    @Test func isCategory() {
        let cases = expected.category.isCategory
        #expect(!cases.isEmpty)
        for c in cases {
            switch c.input {
            case let .string(s): #expect(ParcelCategory.isCategory(s) == c.out, "in=\(s)")
            case .null: #expect(ParcelCategory.isCategory(nil) == c.out)
            default: #expect(c.out == false)
            }
        }
    }

    // MARK: text

    @Test(arguments: parityTimeZones)
    func htmlToText(zone: String) {
        let cases = expected.text.htmlToText
        #expect(!cases.isEmpty)
        for (i, c) in cases.enumerated() {
            #expect(withDefaultTimeZone(zone) { HtmlText.htmlToText(c.input) } == c.out, "case \(i)")
        }
    }

    @Test func decodeEntities() {
        let cases = expected.text.decodeEntities
        #expect(!cases.isEmpty)
        for (i, c) in cases.enumerated() {
            #expect(HtmlText.decodeEntities(c.input) == c.out, "case \(i)")
        }
    }

    @Test func stripInvisible() {
        let cases = expected.text.stripInvisible
        #expect(!cases.isEmpty)
        for (i, c) in cases.enumerated() {
            #expect(HtmlText.stripInvisible(c.input) == c.out, "case \(i)")
        }
    }
}
