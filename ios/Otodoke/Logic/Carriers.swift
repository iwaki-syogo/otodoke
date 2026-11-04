// TDD-STUB(task 5): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Port of src/lib/carriers/index.ts.

import Foundation

enum CarrierKey: String, CaseIterable, Sendable {
    case yamato, sagawa, japanpost, amazon, seino, fukutsu, unknown
}

struct CarrierInfo: Equatable, Sendable {
    let key: CarrierKey
    let name: String
}

/// TrackingLink: open (a link), post (a form to submit), copy (copy the number, then open the page).
enum TrackingLink: Equatable, Sendable {
    case open(url: String)
    case post(url: String, fields: [String: String])
    case copy(url: String, pageName: String)
}

enum Carriers {
    static func normalizeTracking(_ raw: String) -> String { "" }

    static func identifyCarrier(_ tracking: String?, hint: String?) -> CarrierInfo {
        CarrierInfo(key: .unknown, name: "")
    }

    static func trackingLinkFor(_ tracking: String?, hint: String?) -> TrackingLink? { nil }

    static func amazonOrderTrackingUrl(_ orderNumber: String?) -> String? { nil }
}
