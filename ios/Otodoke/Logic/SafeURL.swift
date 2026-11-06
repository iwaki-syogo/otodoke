// Port of src/lib/safe-url.ts.

import Foundation

enum SafeURL {
    /// True only for an absolute https: URL with a host (as the Web's `new URL` reads it).
    /// Foundation's parser is mostly stricter than WHATWG's (it refuses "https:example.com", backslashes,
    /// surrounding spaces, and invalid characters are not percent-encoded for it). Whatever the parser,
    /// only an https URL with a host passes, so script and data URLs never become links.
    static func isHttpsUrl(_ raw: String?) -> Bool {
        guard let raw, !raw.isEmpty else { return false }
        guard let url = URL(string: raw, encodingInvalidCharacters: false),
              url.scheme?.lowercased() == "https",
              let host = url.host(percentEncoded: true), !host.isEmpty
        else { return false }
        if let port = url.port, !(0...65535).contains(port) { return false }
        return true
    }
}
