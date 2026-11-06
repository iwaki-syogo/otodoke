// Pages that open in Safari (「Web で開く」). Every URL is absolute (no baseURL), so it compares equal to
// the same address written out.

import Foundation

enum WebLink {
    /// https://otodoke.app (the same as AppConfig.webBase).
    static let base = AppConfig.webBase

    /// https://otodoke.app/app/parcels/new
    static let newParcel = page("/app/parcels/new")

    // The Web's settings are one page per item (origin/dev 84255fc, src/app/app/settings/): each button opens the page
    // that holds it. The old section hashes (#demo, #gmail-approval) are not used. A vitest checks each path against
    // the page that exists in src/app/app/settings/.

    /// https://otodoke.app/app/settings/demo (the samples and 「すべての荷物を消す」)
    static let settingsDemo = page("/app/settings/demo")

    /// https://otodoke.app/app/settings/password (鍵を作る・パスワードを変える・暗号化する)
    static let settingsPassword = page("/app/settings/password")

    /// https://otodoke.app/app/settings/trouble (未読の「読み取る」)
    static let settingsTrouble = page("/app/settings/trouble")

    /// https://otodoke.app/app/settings/dropped (「これは荷物」)
    static let settingsDropped = page("/app/settings/dropped")

    /// https://otodoke.app/app/settings/delete (アカウントの削除)
    static let settingsDelete = page("/app/settings/delete")

    /// https://otodoke.app/app/parcels/{id}/edit
    static func parcelEdit(id: String) -> URL {
        page("/app/parcels/\(segment(id))/edit")
    }

    /// https://otodoke.app/app/parcels/{id} (a sealed mail, M1)
    static func parcel(id: String) -> URL {
        page("/app/parcels/\(segment(id))")
    }

    /// https://otodoke.app/privacy
    static let privacy = page("/privacy")

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
