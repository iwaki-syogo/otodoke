import Foundation
@testable import Otodoke

/// The section task 13 adds to ios/OtodokeTests/Fixtures/web-expected.json (iOS batch 2, M2), decoded on its
/// own like WebExpectedM1. The key names are the contract with scripts/ios-fixtures.ts
/// (src/lib/__tests__/ios-fixtures-m2.test.ts pins the same names).
struct WebExpectedM2: Decodable {
    let delivered: DeliveredCases

    struct Group: Decodable, Equatable {
        let label: String
        let ids: [String]
    }

    struct DeliveredCases: Decodable {
        struct ByMonth: Decodable { let parcels: [ParcelRow]; let out: [Group] }
        struct Names: Decodable { let items: [ParcelItemName]; let out: [String: [String]] }
        struct Word: Decodable { let q: String?; let out: String }
        struct Filter: Decodable {
            let parcels: [ParcelRow]
            let items: [ParcelItemName]
            /// null is not given (undefined on the Web).
            let q: String?
            let s: String?
            let c: String?
            let m: String?
            let out: [String]
        }
        struct Category: Decodable, Equatable { let value: String; let label: String }
        struct OptionsOut: Decodable { let shops: [String]; let months: [String]; let categories: [Category] }
        struct Options: Decodable { let parcels: [ParcelRow]; let out: OptionsOut }
        struct Choices: Decodable { let months: [String]; let m: String?; let out: [String] }

        let noOrderDateLabel: String
        let searchMax: Int
        let groupByOrderMonth: [ByMonth]
        let itemNamesByParcel: [Names]
        let searchWord: [Word]
        let filterDelivered: [Filter]
        let deliveredFilterOptions: [Options]
        let monthChoices: [Choices]
    }

    static func load() throws -> WebExpectedM2 {
        let fallback = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/web-expected.json")
        let url = WebExpected.bundledURL() ?? fallback
        return try JSONDecoder().decode(WebExpectedM2.self, from: Data(contentsOf: url))
    }
}
