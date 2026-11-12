// The trusted base used by native guide videos, and the full privacy policy's https URL.
// URLs are absolute so they compare equal to the same address written out.

import Foundation

enum WebLink {
    /// https://otodoke.app (the same as AppConfig.webBase).
    static let base = AppConfig.webBase

    /// https://otodoke.app/privacy
    static let privacy = page("/privacy")

    /// base + path as an absolute URL. Falls back to the base for a path that is not a URL.
    private static func page(_ path: String) -> URL {
        URL(string: base.absoluteString + path) ?? base
    }
}
