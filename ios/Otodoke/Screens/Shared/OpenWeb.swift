// TDD-STUB(task 8): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Pages that open in Safari (「Web で開く」).

import Foundation

enum WebLink {
    /// https://otodoke.app (the same as AppConfig.webBase).
    static let base = URL(string: "about:blank")!

    /// https://otodoke.app/app/parcels/new
    static let newParcel = URL(string: "about:blank")!

    /// https://otodoke.app/app/settings#demo
    static let settingsDemo = URL(string: "about:blank")!

    /// https://otodoke.app/app/parcels/{id}/edit
    static func parcelEdit(id: String) -> URL { URL(string: "about:blank")! }
}
