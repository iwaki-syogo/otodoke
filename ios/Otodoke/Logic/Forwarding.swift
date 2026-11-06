// Port of src/lib/forwarding.ts and the choice of settings/page.tsx (2541793):
//   forwardingConfirmUrl(forwarding_confirm_url ?? "") ?? forwardingConfirmUrl(text_body ?? html_body ?? "")
// The sender alone proves nothing (it can be forged), so the link itself must point at Google's page.

import Foundation

enum Forwarding {
    private static let sender = "forwarding-noreply@google.com"
    private static let host = "mail-settings.google.com"

    /// isForwardingConfirmation: from forwarding-noreply@google.com (trimmed, lowercased).
    static func isForwardingConfirmation(_ from: String) -> Bool {
        JSText.equal(JSText.trim(from).lowercased(), sender)
    }

    /// forwardingConfirmUrl: the first `https://[^\s<>"')]+` in the text whose host is
    /// mail-settings.google.com and whose path starts with /mail/ (as the WHATWG URL parser reads the
    /// hostname and pathname); nil when none. The URL is given back as written.
    static func forwardingConfirmUrl(_ body: String) -> String? {
        for candidate in candidates(body) {
            guard let url = WhatwgURL.https(candidate) else { continue }
            if JSText.equal(url.hostname, host) && url.pathname.hasPrefix("/mail/") { return candidate }
        }
        return nil
    }

    /// The approval link the settings screen shows: the stored value first, then the body, both
    /// through forwardingConfirmUrl. text_body "" is a body (html_body is not looked at then).
    static func confirmURL(stored: String?, textBody: String?, htmlBody: String?) -> String? {
        forwardingConfirmUrl(stored ?? "") ?? forwardingConfirmUrl(textBody ?? htmlBody ?? "")
    }

    /// `body.match(/https:\/\/[^\s<>"')]+/g)`: left to right, on UTF-16 units, each match ending where the
    /// next one may start.
    private static func candidates(_ body: String) -> [String] {
        let u = Array(body.utf16)
        let prefix = Array("https://".utf16)
        var out: [String] = []
        var i = 0
        while i + prefix.count < u.count {
            guard u[i..<(i + prefix.count)].elementsEqual(prefix) else {
                i += 1
                continue
            }
            var j = i + prefix.count
            while j < u.count && !isStop(u[j]) { j += 1 }
            if j == i + prefix.count {
                i += 1
                continue
            }
            out.append(String(decoding: u[i..<j], as: UTF16.self))
            i = j
        }
        return out
    }

    /// `\s` of a JavaScript regex, and < > " ' ).
    private static func isStop(_ c: UInt16) -> Bool {
        switch c {
        case 0x3C, 0x3E, 0x22, 0x27, 0x29: return true
        default: return JSText.isTrimmable(c)
        }
    }
}

/// The hostname and pathname the WHATWG URL parser (Node's `new URL`) gives an `https://` URL, as far as
/// comparing them with one plain host and a path prefix needs: slashes and backslashes after the
/// scheme skipped, the last "@" ends the credentials, a port of digits only (up to 65535), the host
/// percent-decoded and mapped as UTS #46 does for these purposes (compatibility forms, lower case,
/// ideographic full stops, ignored characters), the path's backslashes read as slashes and its
/// "." and ".." segments resolved. Nil where the parser would throw. A host this cannot read the way
/// the parser does comes out unequal to a plain ASCII host, so it never accepts more than the Web.
enum WhatwgURL {
    struct Parts: Equatable {
        let hostname: String
        let pathname: String
    }

    static func https(_ text: String) -> Parts? {
        var u = Array(text.utf16)
        let scheme = Array("https:".utf16)
        guard u.count >= scheme.count, u[0..<scheme.count].elementsEqual(scheme) else { return nil }
        u.removeFirst(scheme.count)
        let isSlash = { (c: UInt16) in c == 0x2F || c == 0x5C }
        var i = 0
        while i < u.count && isSlash(u[i]) { i += 1 }
        var end = i
        while end < u.count && !isSlash(u[end]) && u[end] != 0x3F && u[end] != 0x23 { end += 1 }
        var authority = Array(u[i..<end])
        if let at = authority.lastIndex(of: 0x40) { // @
            authority = Array(authority[(at + 1)...])
            if authority.isEmpty { return nil }
        }
        if authority.first == 0x5B { return nil } // an IPv6 address is never the host compared with
        var hostUnits = authority
        if let colon = authority.firstIndex(of: 0x3A) {
            hostUnits = Array(authority[..<colon])
            let port = authority[(colon + 1)...]
            guard port.allSatisfy({ (0x30...0x39).contains($0) }) else { return nil }
            var value = 0
            for c in port {
                value = value * 10 + Int(c - 0x30)
                if value > 65535 { return nil }
            }
        }
        guard !hostUnits.isEmpty, let hostname = host(hostUnits) else { return nil }

        // The path: up to "?" or "#".
        var pathEnd = end
        while pathEnd < u.count && u[pathEnd] != 0x3F && u[pathEnd] != 0x23 { pathEnd += 1 }
        let rawPath = Array(u[end..<pathEnd])
        return Parts(hostname: hostname, pathname: pathname(rawPath))
    }

    private static func host(_ units: [UInt16]) -> String? {
        // Percent-decoded as UTF-8 bytes.
        var bytes: [UInt8] = []
        let utf8 = Array(String(decoding: units, as: UTF16.self).utf8)
        var k = 0
        while k < utf8.count {
            if utf8[k] == 0x25, k + 2 < utf8.count, let h = hex(utf8[k + 1]), let l = hex(utf8[k + 2]) {
                bytes.append(h << 4 | l)
                k += 3
            } else {
                bytes.append(utf8[k])
                k += 1
            }
        }
        let decoded = String(decoding: bytes, as: UTF8.self)
        var mapped = String.UnicodeScalarView()
        for s in decoded.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars {
            switch s.value {
            case 0x3002, 0xFF0E, 0xFF61: mapped.append(".")
            case 0x00AD, 0x034F, 0x180B...0x180D, 0x180F, 0x200B, 0x2060, 0xFE00...0xFE0F, 0xFEFF, 0x1BCA0...0x1BCA3, 0xE0100...0xE01EF:
                continue // ignored by UTS #46
            default: mapped.append(s)
            }
        }
        let h = String(mapped)
        return h.isEmpty ? nil : h
    }

    private static func hex(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x41...0x46: return c - 0x41 + 10
        case 0x61...0x66: return c - 0x61 + 10
        default: return nil
        }
    }

    private static func pathname(_ raw: [UInt16]) -> String {
        guard !raw.isEmpty else { return "/" }
        let text = String(decoding: raw.dropFirst(), as: UTF16.self)
        let pieces = text.split(omittingEmptySubsequences: false) { $0 == "/" || $0 == "\\" }.map(String.init)
        var segments: [String] = []
        for (n, piece) in pieces.enumerated() {
            let isLast = n == pieces.count - 1
            let lower = piece.lowercased()
            let single = lower == "." || lower == "%2e"
            let double = [".." , ".%2e", "%2e.", "%2e%2e"].contains(lower)
            if double {
                if !segments.isEmpty { segments.removeLast() }
                if isLast { segments.append("") }
            } else if single {
                if isLast { segments.append("") }
            } else {
                segments.append(piece)
            }
        }
        return "/" + segments.joined(separator: "/")
    }
}
