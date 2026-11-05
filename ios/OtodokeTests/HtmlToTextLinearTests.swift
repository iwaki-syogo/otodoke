import Foundation
import Testing
@testable import Otodoke

/// [Fix C5] The hidden-element, link, image, line-break and tag steps of htmlToText walk forward once
/// instead of searching from every start tag. They must give what the Web's regexes give (here run with ICU, letters
/// written as [xX] classes as the port did before), and take time close to linear on start tags
/// that are never closed.
@Suite("HtmlToText linear steps (fix C5)")
struct HtmlToTextLinearTests {
    // MARK: the regexes the steps replace (the previous port)

    private static func ci(_ text: String) -> String {
        text.map { ch -> String in
            guard ch.isASCII, ch.isLetter else { return String(ch) }
            return "[\(ch.lowercased())\(ch.uppercased())]"
        }.joined()
    }

    private static let hidden = try! NSRegularExpression(
        pattern: "<(?:" + ["script", "style", "head", "title"].map { "\(ci($0))[\\s\\S]*?</\(ci($0))>" }.joined(separator: "|") + ")"
    )
    private static let link = try! NSRegularExpression(
        pattern: "<\(ci("a"))(?![A-Za-z0-9_])[^>]*\(ci("href"))=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)</\(ci("a"))>"
    )

    private static let image = try! NSRegularExpression(
        pattern: "<\(ci("img"))(?![A-Za-z0-9_])[^>]*\(ci("alt"))=[\"']([^\"']*)[\"'][^>]*>"
    )
    private static let lineBreak = try! NSRegularExpression(pattern: "<(?:\(ci("br"))|\(ci("hr")))(?![A-Za-z0-9_])[^>]*/?>")
    private static let tag = try! NSRegularExpression(pattern: "<[^>]+>")

    private static func regexReplace(_ s: String, _ re: NSRegularExpression, _ with: (NSTextCheckingResult, NSString) -> String) -> String {
        let ns = s as NSString
        var out = ""
        var at = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: at, length: m.range.location - at))
            out += with(m, ns)
            at = m.range.location + m.range.length
        }
        out += ns.substring(from: at)
        return out
    }

    private static func referenceHidden(_ s: String) -> String {
        regexReplace(s, hidden) { _, _ in "" }
    }

    private static func referenceLinks(_ s: String) -> String {
        regexReplace(s, link) { m, ns in "[\(ns.substring(with: m.range(at: 1)))|\(ns.substring(with: m.range(at: 2)))]" }
    }

    private static func referenceImages(_ s: String) -> String {
        regexReplace(s, image) { m, ns in "[\(ns.substring(with: m.range(at: 1)))]" }
    }

    private static func referenceLineBreaks(_ s: String) -> String {
        regexReplace(s, lineBreak) { _, _ in "\n" }
    }

    private static func referenceTags(_ s: String) -> String {
        regexReplace(s, tag) { _, _ in "" }
    }

    private static func linearImages(_ s: String) -> String {
        HtmlText.rewriteImages(s) { alt in "[\(alt)]" }
    }

    private static func linear(_ s: String) -> String {
        HtmlText.rewriteLinks(s) { href, inner in "[\(href)|\(inner)]" }
    }

    // MARK: same answers

    @Test(arguments: [
        "<p>a</p><script>x()</script><p>b</p>",
        "<SCRIPT type=x>1</ScRiPt>2<style>.a{}</style>3",
        "<head><title>t</title></head>body",
        "<header>keep?</header></head>after",
        "<script>never closed <p>text</p>",
        "<title>a</title><title>b",
        "<scripts>x</script>y",
        "</script><script></script>",
        "<style><script></style></script>z",
    ])
    func hiddenAsTheRegex(input: String) {
        #expect(HtmlText.stripHidden(input) == Self.referenceHidden(input))
    }

    @Test(arguments: [
        "<a href=\"https://example.com/x\">見る</a>",
        "<A HREF='https://e.example/'>x</A>tail",
        "<a class=x href=\"one\" data-href=\"two\">t</a>",
        "<a href=\"a>b\" title=x>t</a>",
        "<a href=\"\">empty</a><a href=\"ok\">ok</a>",
        "<a href='x\">mixed</a>",
        "<abbr href=\"x\">no</abbr><a href=\"y\">yes</a>",
        "<a href=\"x\">no close",
        "<a href=\"x\"><a href=\"y\">inner</a></a>",
        "<a\nhref=\"x\"\n>multi\nline</a>",
        "<a href=\"x\" <a href=\"y\">z</a>",
        "<a>no href</a><a href=x>unquoted</a>",
        "<a href=\"x\">a</a><a href=\"y\">b</a>",
        "<a href=\"x\"",
        "<a",
        "",
    ])
    func linksAsTheRegex(input: String) {
        #expect(Self.linear(input) == Self.referenceLinks(input))
    }

    @Test(arguments: [
        "<img src=x alt=\"写真\">", "<IMG ALT=''>", "<img alt=\"a>b\" alt='c'>", "<imgs alt=\"x\">", "<img alt=\"x\"",
        "<br><BR/><hr class=x /><bra>", "<br", "<>", "a<b>c<d", "<<p>>", "<p><q",
    ])
    func imagesBreaksAndTagsAsTheRegexes(input: String) {
        #expect(Self.linearImages(input) == Self.referenceImages(input))
        #expect(HtmlText.lineBreaksToNewlines(input) == Self.referenceLineBreaks(input))
        #expect(HtmlText.stripTags(input) == Self.referenceTags(input))
    }

    @Test func randomTagSoupAsTheRegexes() {
        let pieces = [
            "<a", "<A", " href=", "HREF=", "\"", "'", "x", "y", ">", "</a>", "</A>", "<script", "</script>",
            "<STYLE", "</style>", "<head", "</head>", "<title", "</title>", " ", "\n", "<abbr", "日本", "<", "/", "=",
            "<img", " alt=", "ALT=", "<br", "<HR", "/>", "<>",
        ]
        var rng = SplitMix64(seed: 2026_11_05)
        for _ in 0..<4000 {
            let count = Int.random(in: 1...24, using: &rng)
            let s = (0..<count).map { _ in pieces.randomElement(using: &rng)! }.joined()
            #expect(HtmlText.stripHidden(s) == Self.referenceHidden(s), "\(s)")
            #expect(Self.linear(s) == Self.referenceLinks(s), "\(s)")
            #expect(Self.linearImages(s) == Self.referenceImages(s), "\(s)")
            #expect(HtmlText.lineBreaksToNewlines(s) == Self.referenceLineBreaks(s), "\(s)")
            #expect(HtmlText.stripTags(s) == Self.referenceTags(s), "\(s)")
        }
    }

    // MARK: time

    /// The best of five runs, in seconds (the least disturbed by other work on the machine).
    private static func time(_ body: () -> Void) -> Double {
        var best = Double.infinity
        for _ in 0..<5 {
            let start = ContinuousClock.now
            body()
            let d = ContinuousClock.now - start
            best = min(best, Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18)
        }
        return best
    }

    @Test(arguments: [
        "<script>x ",
        "<a href=\"https://example.com/\">x ",
        "<style><title><head>",
        "<a href='x' ",
        "<img alt='x' ",
        "<img <br <p ",
        "<a <img <a ",
    ])
    func unclosedStartTagsTakeAboutLinearTime(unit: String) {
        let small = String(repeating: unit, count: 2000)
        let large = String(repeating: unit, count: 8000)
        _ = HtmlText.htmlToText(small) // warm up
        let t1 = Self.time { _ = HtmlText.htmlToText(small) }
        let t2 = Self.time { _ = HtmlText.htmlToText(large) }
        // Four times the input: about four times the time when linear, sixteen times when quadratic.
        // Eight leaves room for a busy machine and still tells the two apart.
        #expect(t2 < max(t1, 0.001) * 8, "\(unit): \(t1)s → \(t2)s")
        #expect(t2 < 1.0, "\(unit): \(t2)s")
    }
}
