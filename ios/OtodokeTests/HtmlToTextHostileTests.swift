import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, task 3] htmlToText follows the Web's rewrite of 2541793 (4fbbfde: forward scans instead of
/// regexes that went quadratic on unclosed tags). The answers are checked against the Web through the
/// fixture (WebParity2Tests.htmlToText, whose cases task 4 extends with the KEPT cases of
/// src/lib/__tests__/html-to-text-hostile.test.ts and short hostile inputs). Here: the same hostile
/// shapes stay close to linear in time (batch 1's rule), measured as growth between two lengths.
@Suite("htmlToText on hostile HTML (batch 2, task 3)", .serialized)
struct HtmlToTextHostileTests {
    /// The shapes of html-to-text-hostile.test.ts.
    static let shapes: [(name: String, make: @Sendable (Int) -> String)] = [
        ("'<' repeated", { fill("<", $0) }),
        ("'<a ' repeated", { fill("<a ", $0) }),
        ("'<img ' repeated", { fill("<img ", $0) }),
        ("'<script' repeated", { fill("<script", $0) }),
        ("unclosed '<a href=\"x\">' repeated", { fill("<a href=\"x\">", $0) }),
        ("'<br ' repeated", { fill("<br ", $0) }),
        ("'<style>' repeated", { fill("<style>", $0) }),
        ("unclosed '<img alt=\"x\"' repeated", { fill("<img alt=\"x\"", $0) }),
        ("one tag with many href= and no </a>", { "<a" + fill(" href=\"x\"", $0) + ">" }),
        ("a link whose text is '<' repeated", { "<a href=\"x\">" + fill("<", $0) + "</a>" }),
    ]

    static func fill(_ unit: String, _ length: Int) -> String {
        String(String(repeating: unit, count: length / unit.count + 1).prefix(length))
    }

    private static func seconds(_ html: String) -> Double {
        let clock = ContinuousClock()
        var best = Double.infinity
        for _ in 0..<2 {
            let started = clock.now
            _ = HtmlText.htmlToText(html)
            let d = clock.now - started
            best = min(best, Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18)
        }
        return best
    }

    @Test(arguments: 0..<10)
    func staysCloseToLinear(index: Int) {
        let shape = Self.shapes[index]
        let small = Self.seconds(shape.make(32_000))
        let large = Self.seconds(shape.make(128_000))
        // Four times the input: about four times the time when linear, sixteen when quadratic.
        #expect(large < max(small, 0.002) * 9, "\(shape.name): \(small)s → \(large)s")
        #expect(large < 5, "\(shape.name): \(large)s at 128K")
    }
}
