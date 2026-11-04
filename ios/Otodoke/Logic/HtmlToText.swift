// Port of src/lib/text/html-to-text.ts. JS regular expressions and slice() count UTF-16 units: so does this
// (NSRegularExpression works on UTF-16 text). The Web's patterns carry the `i` flag without `u`, which folds
// ASCII letters only; ICU's case-insensitive mode folds more (ſ matches s), so every letter is written as
// an explicit [xX] class instead. `\b` is ASCII in JS (Unicode in ICU) and `$` means the very end in JS
// (ICU also matches before a final newline), so both are spelled out too.

import Foundation

enum HtmlText {
    static func htmlToText(_ html: String) -> String {
        var s = stripInvisible(html)
        s = stripComments(s)
        s = replace(s, Pattern.hidden) { _, _ in "" }
        // Links: keep the visible text and the target when the target is informative.
        s = replace(s, Pattern.link) { m, ns in
            let href = ns.substring(with: m.range(at: 1))
            let inner = ns.substring(with: m.range(at: 2))
            let text = JSText.trim(replace(inner, Pattern.tag) { _, _ in "" })
            let url = decodeEntities(JSText.trim(href))
            if text.isEmpty { return " " }
            if Pattern.noiseHref.firstMatch(in: url, range: NSRange(location: 0, length: (url as NSString).length)) != nil
                || url.utf16.first == 0x23 { // "#"
                return " \(text) "
            }
            let shown = url.utf16.count > 300 ? JSText.slice(url, 0, 300) + "…" : url
            return " \(text) (\(shown)) "
        }
        s = replace(s, Pattern.image) { m, ns in " \(ns.substring(with: m.range(at: 1))) " }
        s = replace(s, Pattern.lineBreak) { _, _ in "\n" }
        s = replace(s, Pattern.blockEnd) { _, _ in "\n" }
        s = replace(s, Pattern.cellEnd) { _, _ in "\t" }
        s = replace(s, Pattern.tag) { _, _ in "" }
        s = decodeEntities(s)
        return collapseWhitespace(s)
    }

    static func decodeEntities(_ input: String) -> String {
        replace(input, Pattern.entity) { m, ns in
            let match = ns.substring(with: m.range)
            let body = Array(ns.substring(with: m.range(at: 1)).utf16)
            if body.first == 0x23 { // "#"
                let isHex = body.count > 1 && (body[1] == 0x78 || body[1] == 0x58) // x / X
                let digits = String(decoding: body.dropFirst(isHex ? 2 : 1), as: UTF16.self)
                // Too large to parse is also above 0x10FFFF: the text stays as it is.
                guard let code = UInt32(digits, radix: isHex ? 16 : 10), code <= 0x10FFFF else { return match }
                // A lone surrogate cannot live in a Swift string: it becomes U+FFFD (as it would in UTF-8).
                return Unicode.Scalar(code).map { String(Character($0)) } ?? "\u{FFFD}"
            }
            let name = String(decoding: body.map { (0x41...0x5A).contains($0) ? $0 + 0x20 : $0 }, as: UTF16.self)
            return entities[name] ?? match
        }
    }

    static func stripInvisible(_ text: String) -> String {
        var out = String.UnicodeScalarView()
        for s in text.unicodeScalars {
            switch s.value {
            case 0x200B...0x200F, 0x202A...0x202E, 0x2060...0x2064, 0xFEFF: continue
            default: out.append(s)
            }
        }
        return String(out)
    }

    // MARK: - Private

    private static let entities: [String: String] = [
        "amp": "&",
        "lt": "<",
        "gt": ">",
        "quot": "\"",
        "apos": "'",
        "nbsp": " ",
        "yen": "¥",
        "hellip": "…",
        "copy": "©",
        "reg": "®",
        "trade": "™",
        "mdash": "—",
        "ndash": "–",
    ]

    private enum Pattern {
        /// Letters as [xX] classes: the JS `i` flag on ASCII only.
        static func ci(_ text: String) -> String {
            text.map { ch -> String in
                guard ch.isASCII, ch.isLetter else { return String(ch) }
                return "[\(ch.lowercased())\(ch.uppercased())]"
            }.joined()
        }

        static func make(_ pattern: String) -> NSRegularExpression {
            try! NSRegularExpression(pattern: pattern)
        }

        /// The JS `\b` after a word character: the next unit is not [A-Za-z0-9_].
        static let wordEnd = "(?![A-Za-z0-9_])"

        /// /<(script|style|head|title)[\s\S]*?<\/\1>/gi (no tag name is a prefix of another, so one
        /// alternative per name matches exactly what the back-reference does).
        static let hidden = make(
            "<(?:" + ["script", "style", "head", "title"].map { "\(ci($0))[\\s\\S]*?</\(ci($0))>" }.joined(separator: "|") + ")"
        )
        /// /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
        static let link = make(
            "<\(ci("a"))\(wordEnd)[^>]*\(ci("href"))=[\"']([^\"']+)[\"'][^>]*>([\\s\\S]*?)</\(ci("a"))>"
        )
        /// /<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi
        static let image = make("<\(ci("img"))\(wordEnd)[^>]*\(ci("alt"))=[\"']([^\"']*)[\"'][^>]*>")
        /// /<(br|hr)\b[^>]*\/?>/gi
        static let lineBreak = make("<(?:\(ci("br"))|\(ci("hr")))\(wordEnd)[^>]*/?>")
        /// /<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote|pre)>/gi
        static let blockEnd = make("</(?:\(ci("p|div|tr|li|h[1-6]|table|section|article|blockquote|pre")))>")
        /// /<\/(td|th)>/gi
        static let cellEnd = make("</(?:\(ci("td|th")))>")
        /// /<[^>]+>/g
        static let tag = make("<[^>]+>")
        /// /(unsubscribe|optout|opt-out|privacy|mailto:|\.(png|jpe?g|gif|webp)(\?|$))/i
        static let noiseHref = make(
            "(?:\(ci("unsubscribe|optout|opt-out|privacy|mailto:"))|\\.(?:\(ci("png|jpe?g|gif|webp")))(?:\\?|\\z))"
        )
        /// /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi
        static let entity = make("&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);")
    }

    /// `s.replace(re, fn)` for a global pattern.
    private static func replace(_ s: String, _ re: NSRegularExpression, _ with: (NSTextCheckingResult, NSString) -> String) -> String {
        let ns = s as NSString
        let matches = re.matches(in: s, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return s }
        var out = ""
        var at = 0
        for m in matches {
            out += ns.substring(with: NSRange(location: at, length: m.range.location - at))
            out += with(m, ns)
            at = m.range.location + m.range.length
        }
        out += ns.substring(from: at)
        return out
    }

    /// A loop rather than a regex: on many unclosed comments the regex takes quadratic time.
    private static func stripComments(_ html: String) -> String {
        let u = Array(html.utf16)
        let open: [UInt16] = Array("<!--".utf16), close: [UInt16] = Array("-->".utf16)
        func indexOf(_ needle: [UInt16], from: Int) -> Int? {
            guard from <= u.count - needle.count else { return nil }
            for i in from...(u.count - needle.count) where u[i..<(i + needle.count)].elementsEqual(needle) {
                return i
            }
            return nil
        }
        var out: [UInt16] = []
        var at = 0
        while true {
            guard let o = indexOf(open, from: at) else {
                out += u[at...]
                break
            }
            out += u[at..<o]
            guard let c = indexOf(close, from: o + 4) else { break }
            at = c + 3
        }
        return String(decoding: out, as: UTF16.self)
    }

    /// U+00A0 to a space, horizontal whitespace collapsed and trimmed per line, runs of blank lines
    /// shortened to one, the whole trimmed.
    private static func collapseWhitespace(_ s: String) -> String {
        let units = s.utf16.map { $0 == 0xA0 ? 0x20 : $0 }
        var lines: [ArraySlice<UInt16>] = []
        for line in units.split(separator: 0x0A, omittingEmptySubsequences: false) {
            var collapsed: [UInt16] = []
            var inRun = false
            for c in line {
                if c == 0x20 || c == 0x09 || c == 0x0C || c == 0x0B {
                    if !inRun { collapsed.append(0x20) }
                    inRun = true
                } else {
                    collapsed.append(c)
                    inRun = false
                }
            }
            lines.append(JSText.trim(collapsed[...]))
        }
        var joined: [UInt16] = []
        for (i, line) in lines.enumerated() {
            if i > 0 { joined.append(0x0A) }
            joined += line
        }
        var out: [UInt16] = []
        var newlines = 0
        for c in joined {
            if c == 0x0A {
                newlines += 1
                if newlines <= 2 { out.append(c) }
            } else {
                newlines = 0
                out.append(c)
            }
        }
        return String(decoding: JSText.trim(out[...]), as: UTF16.self)
    }
}
