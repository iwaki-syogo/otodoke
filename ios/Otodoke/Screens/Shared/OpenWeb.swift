// Pages that open in Safari (「Web で開く」). Every URL is absolute (no baseURL), so it compares equal to
// the same address written out.

import Foundation

enum WebLink {
    /// https://otodoke.app (the same as AppConfig.webBase).
    static let base = AppConfig.webBase

    /// https://otodoke.app/app/parcels/new
    static let newParcel = page("/app/parcels/new")

    /// https://otodoke.app/app/settings#demo
    static let settingsDemo = page("/app/settings#demo")

    /// https://otodoke.app/app/parcels/{id}/edit
    static func parcelEdit(id: String) -> URL {
        page("/app/parcels/\(segment(id))/edit")
    }

    /// https://otodoke.app/app/parcels/{id} (a sealed mail, M1)
    static func parcel(id: String) -> URL {
        page("/app/parcels/\(segment(id))")
    }

    /// https://otodoke.app/app/settings
    static let settings = page("/app/settings")
    /// https://otodoke.app/app
    static let app = page("/app")

    /// An id as one path segment ("/" and "?" encoded too).
    private static func segment(_ id: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove("/")
        return id.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
    }

    /// base + path ("/app/..."), as an absolute URL. Falls back to the base for a path that is not a URL.
    private static func page(_ path: String) -> URL {
        URL(string: base.absoluteString + path) ?? base
    }
}
