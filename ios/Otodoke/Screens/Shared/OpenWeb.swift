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
    /// Until the Web's split of the settings reaches main, every Web page the settings buttons open is a section
    /// of this one. When it does, each button goes to its own page (SettingsModel.webLink):
    ///   鍵を作る・パスワードを変える・暗号化する -> /app/settings/password
    ///   読み取る -> /app/settings/trouble,  これは荷物 -> /app/settings/dropped,  すべての荷物を消す -> /app/settings/demo
    static let settings = page("/app/settings")

    /// https://otodoke.app/privacy
    static let privacy = page("/privacy")

    /// https://otodoke.app/app/settings (the deletion sits inside this page for now).
    /// When the Web's split reaches main, change this to page("/app/settings/delete").
    static let accountDeletion = page("/app/settings")
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
