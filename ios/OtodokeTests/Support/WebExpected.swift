import Foundation
@testable import Otodoke

/// ios/OtodokeTests/Fixtures/web-expected.json, written by scripts/ios-fixtures.ts from the Web's own
/// TypeScript functions. Decoding it here pins the key names both sides agreed on.
struct WebExpected: Decodable {
    let generatedBy: String
    let format: FormatCases
    let match: MatchCases
    let sections: [SectionCase]
    let undelivered: [UndeliveredCase]
    let unread: [UnreadCase]
    let carriers: CarrierCases
    let safeUrl: [SafeUrlCase]
    let category: CategoryCases
    let text: TextCases

    struct FormatCases: Decodable {
        struct TodayJst: Decodable { let now: String; let out: String }
        struct DateJa: Decodable { let ymd: String?; let withYear: Bool?; let today: String; let out: String }
        struct Relative: Decodable { let ymd: String?; let today: String; let out: String }
        struct Window: Decodable { let start: String?; let end: String?; let out: String }
        struct Yen: Decodable { let n: Int?; let out: String }
        struct DateTime: Decodable { let iso: String?; let today: String; let out: String }

        let todayJst: [TodayJst]
        let formatDateJa: [DateJa]
        let relativeDateJa: [Relative]
        let formatWindow: [Window]
        let yen: [Yen]
        let formatDateTimeJa: [DateTime]
        let statusLabel: [String: String]
        let relevanceLabel: [String: String]
    }

    struct MatchCase: Decodable {
        let parcel: ParcelRow
        let today: String?
        let out: JSONValue
    }

    struct MatchCases: Decodable {
        let lastExpectedDay: [MatchCase]
        let needsCheck: [MatchCase]
        let isLate: [MatchCase]
        let faceToFace: [MatchCase]
    }

    struct SectionIDs: Decodable, Equatable {
        let toCheck: [String]
        let delivering: [String]
        let soon: [String]
        let ordered: [String]
    }

    struct SectionCase: Decodable {
        let today: String
        /// In the database's order.
        let parcels: [ParcelRow]
        let out: SectionIDs
    }

    struct UndeliveredCase: Decodable {
        struct Input: Decodable {
            let trackingNumber: String?
            let carrier: String?
            enum CodingKeys: String, CodingKey {
                case trackingNumber = "tracking_number"
                case carrier
            }
        }

        let row: Input
        let out: String
    }

    struct UnreadCase: Decodable { let now: String; let out: String }

    struct InOut<I: Decodable, O: Decodable>: Decodable {
        let input: I
        let out: O
        enum CodingKeys: String, CodingKey {
            case input = "in"
            case out
        }
    }

    struct CarrierCases: Decodable {
        struct Identify: Decodable {
            struct Out: Decodable { let key: String; let name: String }
            let tracking: String?
            let hint: String?
            let out: Out
        }

        struct Link: Decodable {
            let kind: String
            let url: String
            let fields: [String: String]?
            let pageName: String?
        }

        struct LinkCase: Decodable {
            let tracking: String?
            let hint: String?
            let out: Link?
        }

        let normalizeTracking: [InOut<String, String>]
        let identifyCarrier: [Identify]
        let trackingLinkFor: [LinkCase]
        let amazonOrderTrackingUrl: [InOut<String?, String?>]
    }

    typealias SafeUrlCase = InOut<JSONValue, Bool>

    struct CategoryCases: Decodable {
        let keys: [String]
        let labels: [String: String]
        let colors: [String: String]
        let uncategorizedLabel: String
        let uncategorizedColor: String
        let isCategory: [InOut<JSONValue, Bool>]
    }

    struct TextCases: Decodable {
        let htmlToText: [InOut<String, String>]
        let decodeEntities: [InOut<String, String>]
        let stripInvisible: [InOut<String, String>]
    }
}

final class FixtureBundleToken {}

extension WebExpected {
    /// The copy in the test bundle (project.yml puts OtodokeTests/Fixtures into OtodokeTests' resources).
    static func bundledURL() -> URL? {
        let bundle = Bundle(for: FixtureBundleToken.self)
        return bundle.url(forResource: "web-expected", withExtension: "json", subdirectory: "Fixtures")
            ?? bundle.url(forResource: "web-expected", withExtension: "json")
    }

    /// The bundled copy, or the file next to this source when run outside the app's test bundle.
    static func load() throws -> WebExpected {
        let fallback = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/web-expected.json")
        let url = bundledURL() ?? fallback
        return try JSONDecoder().decode(WebExpected.self, from: Data(contentsOf: url))
    }
}

extension WebExpected.CarrierCases.Link {
    var trackingLink: TrackingLink? {
        switch kind {
        case "open": return .open(url: url)
        case "post": return .post(url: url, fields: fields ?? [:])
        case "copy": return .copy(url: url, pageName: pageName ?? "")
        default: return nil
        }
    }
}
