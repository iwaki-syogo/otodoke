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
        s = stripHidden(s)
        // Links: keep the visible text and the target when the target is informative.
        s = rewriteLinks(s) { href, inner in
            let text = JSText.trim(stripTags(inner))
            let url = decodeEntities(JSText.trim(href))
            if text.isEmpty { return " " }
            if Pattern.noiseHref.firstMatch(in: url, range: NSRange(location: 0, length: (url as NSString).length)) != nil
                || url.utf16.first == 0x23 { // "#"
                return " \(text) "
            }
            let shown = url.utf16.count > 300 ? JSText.slice(url, 0, 300) + "…" : url
            return " \(text) (\(shown)) "
        }
        s = rewriteImages(s) { alt in " \(alt) " }
        s = lineBreaksToNewlines(s)
        s = replace(s, Pattern.blockEnd) { _, _ in "\n" }
        s = replace(s, Pattern.cellEnd) { _, _ in "\t" }
        s = stripTags(s)
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

        /// /<\/(p|div|tr|li|h[1-6]|table|section|article|blockquote|pre)>/gi
        static let blockEnd = make("</(?:\(ci("p|div|tr|li|h[1-6]|table|section|article|blockquote|pre")))>")
        /// /<\/(td|th)>/gi
        static let cellEnd = make("</(?:\(ci("td|th")))>")
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

    // MARK: hidden elements and links, without a regex

    // `[\s\S]*?<\/x>` searched again from every start tag takes quadratic time when the closing tag
    // is missing (受信メール由来の本文). These walk forward once, finding each closing tag from lists
    // made in one pass, and give what the Web's regexes give (checked against them in
    // HtmlToTextLinearTests).

    private static func lower(_ u: UInt16) -> UInt16 { (0x41...0x5A).contains(u) ? u + 0x20 : u }

    /// `word` (lowercase ASCII) at `i`, ASCII letters folded.
    private static func hasWord(_ u: [UInt16], at i: Int, _ word: [UInt16]) -> Bool {
        guard i >= 0, i + word.count <= u.count else { return false }
        for k in 0..<word.count where lower(u[i + k]) != word[k] { return false }
        return true
    }

    /// next[i] = the first start of `word` at or after i (u.count when none), for i in 0...u.count.
    private static func nextStarts(of word: [UInt16], in u: [UInt16]) -> [Int] {
        var next = [Int](repeating: u.count, count: u.count + 1)
        var i = u.count - 1
        while i >= 0 {
            next[i] = hasWord(u, at: i, word) ? i : next[i + 1]
            i -= 1
        }
        return next
    }

    /// next[i] = the first index at or after i whose unit is in `units` (u.count when none).
    private static func nextUnit(_ units: Set<UInt16>, in u: [UInt16]) -> [Int] {
        var next = [Int](repeating: u.count, count: u.count + 1)
        var i = u.count - 1
        while i >= 0 {
            next[i] = units.contains(u[i]) ? i : next[i + 1]
            i -= 1
        }
        return next
    }

    private static let hiddenNames: [[UInt16]] = ["script", "style", "head", "title"].map { Array($0.utf16) }

    /// `s.replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, "")`.
    static func stripHidden(_ s: String) -> String {
        let u = Array(s.utf16)
        let lt: UInt16 = 0x3C
        guard u.contains(lt) else { return s }
        let closes = hiddenNames.map { nextStarts(of: Array("</".utf16) + $0 + [0x3E], in: u) }
        var out: [UInt16] = []
        out.reserveCapacity(u.count)
        var at = 0
        var p = 0
        while p < u.count {
            // No name is a prefix of another, so at most one matches here.
            if u[p] == lt, let k = hiddenNames.firstIndex(where: { hasWord(u, at: p + 1, $0) }) {
                let close = closes[k][p + 1 + hiddenNames[k].count]
                if close < u.count {
                    out += u[at..<p]
                    p = close + hiddenNames[k].count + 3
                    at = p
                    continue
                }
            }
            p += 1
        }
        out += u[at...]
        return String(decoding: out, as: UTF16.self)
    }

    /// `s.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => ...)`.
    /// For a start tag at p the regex takes the rightmost `href=` before the first ">" after it (the
    /// greedy `[^>]*`) for which the rest matches; whether the rest matches depends on that href only,
    /// so it is worked out once per href.
    static func rewriteLinks(_ s: String, _ with: (_ href: String, _ inner: String) -> String) -> String {
        let u = Array(s.utf16)
        let n = u.count
        guard n > 0, u.contains(0x3C) else { return s }
        let nextGT = nextUnit([0x3E], in: u)
        let nextQuote = nextUnit([0x22, 0x27], in: u)
        let nextClose = nextStarts(of: Array("</a>".utf16), in: u)
        let hrefWord = Array("href=".utf16)
        // For each href that can complete a link: where its value ends, its tag ends, its </a> starts.
        var parts: [Int: (end: Int, tagEnd: Int, close: Int)] = [:]
        // lastHref[i] = the last href before i that can complete a link (-1 when none).
        var lastHref = [Int](repeating: -1, count: n + 1)
        var last = -1
        for h in 0..<n {
            lastHref[h] = last
            guard u[h] == 0x68 || u[h] == 0x48, hasWord(u, at: h, hrefWord), h + 6 < n,
                  u[h + 5] == 0x22 || u[h + 5] == 0x27 else { continue }
            let end = nextQuote[h + 6]
            guard end < n, end > h + 6 else { continue }
            let tagEnd = nextGT[end + 1]
            guard tagEnd < n else { continue }
            let close = nextClose[tagEnd + 1]
            guard close < n else { continue }
            parts[h] = (end, tagEnd, close)
            last = h
        }
        lastHref[n] = last

        var out: [UInt16] = []
        out.reserveCapacity(n)
        var at = 0
        var p = 0
        while p < n {
            if u[p] == 0x3C, p + 1 < n, lower(u[p + 1]) == 0x61, !(p + 2 < n && isWordUnit(u[p + 2])) {
                let h = lastHref[nextGT[min(p + 2, n)]]
                if h >= p + 2, let found = parts[h] {
                    out += u[at..<p]
                    let href = String(decoding: u[(h + 6)..<found.end], as: UTF16.self)
                    let inner = String(decoding: u[(found.tagEnd + 1)..<found.close], as: UTF16.self)
                    out += Array(with(href, inner).utf16)
                    p = found.close + 4
                    at = p
                    continue
                }
            }
            p += 1
        }
        out += u[at...]
        return String(decoding: out, as: UTF16.self)
    }

    private static func isWordUnit(_ c: UInt16) -> Bool {
        (0x30...0x39).contains(c) || (0x41...0x5A).contains(c) || (0x61...0x7A).contains(c) || c == 0x5F
    }

    /// `s.replace(/<[^>]+>/g, "")`. A "<" with no ">" after it starts no tag, and neither does any
    /// later "<": the rest is kept as it is.
    static func stripTags(_ s: String) -> String {
        let u = Array(s.utf16)
        guard u.contains(0x3C) else { return s }
        var out: [UInt16] = []
        out.reserveCapacity(u.count)
        var at = 0
        var p = 0
        var nextGT = -1
        while p < u.count {
            if u[p] == 0x3C {
                if nextGT <= p { nextGT = u[(p + 1)...].firstIndex(of: 0x3E) ?? u.count }
                if nextGT == u.count { break }
                if nextGT > p + 1 {
                    out += u[at..<p]
                    p = nextGT + 1
                    at = p
                    continue
                }
            }
            p += 1
        }
        out += u[at...]
        return String(decoding: out, as: UTF16.self)
    }

    /// `s.replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")`.
    static func lineBreaksToNewlines(_ s: String) -> String {
        let u = Array(s.utf16)
        guard u.contains(0x3C) else { return s }
        let nextGT = nextUnit([0x3E], in: u)
        var out: [UInt16] = []
        out.reserveCapacity(u.count)
        var at = 0
        var p = 0
        while p < u.count {
            if u[p] == 0x3C, hasWord(u, at: p + 1, [0x62, 0x72]) || hasWord(u, at: p + 1, [0x68, 0x72]),
               !(p + 3 < u.count && isWordUnit(u[p + 3])) {
                let end = nextGT[p + 3]
                if end == u.count { break }
                out += u[at..<p]
                out.append(0x0A)
                p = end + 1
                at = p
                continue
            }
            p += 1
        }
        out += u[at...]
        return String(decoding: out, as: UTF16.self)
    }

    /// `s.replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*>/gi, (_, alt) => ...)`: as rewriteLinks, the
    /// rightmost `alt=` before the first ">" after the start tag that completes a match.
    static func rewriteImages(_ s: String, _ with: (_ alt: String) -> String) -> String {
        let u = Array(s.utf16)
        let n = u.count
        guard n > 0, u.contains(0x3C) else { return s }
        let nextGT = nextUnit([0x3E], in: u)
        let nextQuote = nextUnit([0x22, 0x27], in: u)
        let altWord = Array("alt=".utf16)
        var parts: [Int: (end: Int, tagEnd: Int)] = [:]
        var lastAlt = [Int](repeating: -1, count: n + 1)
        var last = -1
        for h in 0..<n {
            lastAlt[h] = last
            guard u[h] == 0x61 || u[h] == 0x41, hasWord(u, at: h, altWord), h + 4 < n,
                  u[h + 4] == 0x22 || u[h + 4] == 0x27 else { continue }
            let end = nextQuote[h + 5]
            guard end < n else { continue }
            let tagEnd = nextGT[end + 1]
            guard tagEnd < n else { continue }
            parts[h] = (end, tagEnd)
            last = h
        }
        lastAlt[n] = last

        var out: [UInt16] = []
        out.reserveCapacity(n)
        var at = 0
        var p = 0
        let img: [UInt16] = Array("img".utf16)
        while p < n {
            if u[p] == 0x3C, hasWord(u, at: p + 1, img), !(p + 4 < n && isWordUnit(u[p + 4])) {
                let h = lastAlt[nextGT[min(p + 4, n)]]
                if h >= p + 4, let found = parts[h] {
                    out += u[at..<p]
                    out += Array(with(String(decoding: u[(h + 5)..<found.end], as: UTF16.self)).utf16)
                    p = found.tagEnd + 1
                    at = p
                    continue
                }
            }
            p += 1
        }
        out += u[at...]
        return String(decoding: out, as: UTF16.self)
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
