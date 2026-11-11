// Pages that open in Safari (「Web で開く」). Every URL is absolute (no baseURL), so it compares equal to
// the same address written out.

import Foundation

enum WebLink {
    /// https://otodoke.app (the same as AppConfig.webBase).
    static let base = AppConfig.webBase

    // The Web's settings are one page per item (origin/dev 84255fc, src/app/app/settings/): each button opens the page
    // that holds it. The old section hashes (#demo, #gmail-approval) are not used. A vitest checks each path against
    // the page that exists in src/app/app/settings/.

    /// https://otodoke.app/privacy
    static let privacy = page("/privacy")

    /// base + path ("/app/..."), as an absolute URL. Falls back to the base for a path that is not a URL.
    private static func page(_ path: String) -> URL {
        URL(string: base.absoluteString + path) ?? base
    }
}
