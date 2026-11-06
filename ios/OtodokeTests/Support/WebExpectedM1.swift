import Foundation
@testable import Otodoke

/// The sections task 4 adds to ios/OtodokeTests/Fixtures/web-expected.json (iOS batch 2, M1), decoded
/// on their own so the batch-1 decoder (WebExpected) stays as it is. The key names are the contract
/// with scripts/ios-fixtures.ts (src/lib/__tests__/ios-fixtures-m1.test.ts pins the same names).
struct WebExpectedM1: Decodable {
    let calendar: CalendarCases
    let spend: SpendCases
    let shop: ShopCases
    let month: MonthCases
    let forwarding: ForwardingCases
    let match: MatchM1

    struct CalendarCases: Decodable {
        struct Upcoming: Decodable {
            let today: String
            let first: String
            let last: String
            /// In the order the Web's query returns them.
            let parcels: [ParcelRow]
            /// day → ids, input order kept.
            let out: [String: [String]]
        }

        let upcomingByDay: [Upcoming]
    }

    struct TotalOut: Decodable, Equatable { let total: Int; let priced: Int; let unpriced: Int }
    struct CategoryOut: Decodable { let category: String?; let amount: Int; let share: Double }
    struct SegmentOut: Decodable { let category: String?; let amount: Int }
    struct BarOut: Decodable { let month: String; let total: Int; let segments: [SegmentOut] }
    struct SlicesOut: Decodable {
        let picked: [String]
        let orders: [String]
        let byCategory: [String]
        let byShop: [String]
        let undated: Int
    }

    struct SpendCases: Decodable {
        struct MonthParam: Decodable { let m: String?; let today: String; let out: String }
        struct WithParcels<O: Decodable>: Decodable { let parcels: [ParcelRow]; let out: O }
        struct Slices: Decodable {
            let parcels: [ParcelRow]
            let all: Bool
            /// The category filter: cSet false is no filter (undefined); c null is 未分類.
            let c: String?
            let cSet: Bool
            /// null is no shop filter.
            let s: String?
            let out: SlicesOut
        }

        let spendMonthParam: [MonthParam]
        let spendTotal: [WithParcels<TotalOut>]
        let categoryOf: [WebExpected.InOut<String?, String?>]
        let spendByCategory: [WithParcels<[CategoryOut]>]
        let sharePercent: [WebExpected.InOut<Double, String>]
        let spendByMonth: [WithParcels<[BarOut]>]
        let withEmptyMonths: [WebExpected.InOut<[BarOut], [BarOut]>]
        let axisTicks: [WebExpected.InOut<Double, [Double]>]
        let tickLabel: [WebExpected.InOut<Double, String>]
        let spendSlices: [Slices]
    }

    struct ShopCases: Decodable {
        struct Normalize: Decodable {
            let shop: String
            let shopKey: String?
            let out: String
            enum CodingKeys: String, CodingKey {
                case shop
                case shopKey = "shop_key"
                case out
            }
        }

        struct CategoryParam: Decodable {
            /// A string, an array of strings, or null (undefined).
            let input: JSONValue
            /// outSet false: undefined (no filter); out null with outSet: 未分類.
            let out: String?
            let outSet: Bool
            enum CodingKeys: String, CodingKey {
                case input = "in"
                case out, outSet
            }
        }

        let none: String
        let labelMax: Int
        let normalizeShop: [Normalize]
        let shopLabel: [WebExpected.InOut<String, String>]
        let firstParam: [WebExpected.InOut<JSONValue, String?>]
        let categoryParam: [CategoryParam]
    }

    struct MonthCases: Decodable {
        struct Today: Decodable { let today: String; let out: String }
        struct Label: Decodable { let ym: String; let today: String; let out: String }
        struct Param: Decodable { let m: String?; let today: String; let out: String }
        struct Shift: Decodable { let ym: String; let delta: Int; let out: String }
        struct Parts: Decodable, Equatable { let y: Int; let m: Int; let d: Int }
        struct Add: Decodable { let ymd: String; let days: Int; let out: String }
        struct Days: Decodable { let y: Int; let m: Int; let out: Int }

        let min: String
        let monthMax: [Today]
        let monthOf: [WebExpected.InOut<String, String>]
        let monthLabel: [Label]
        let monthParam: [Param]
        let shiftMonth: [Shift]
        let splitDate: [WebExpected.InOut<String, Parts?>]
        let weekdayOf: [WebExpected.InOut<String, Int>]
        let addDays: [Add]
        let daysInMonth: [Days]
    }

    struct ForwardingCases: Decodable {
        struct Confirm: Decodable {
            let forwardingConfirmUrl: String?
            let textBody: String?
            let htmlBody: String?
            let out: String?
            enum CodingKeys: String, CodingKey {
                case forwardingConfirmUrl = "forwarding_confirm_url"
                case textBody = "text_body"
                case htmlBody = "html_body"
                case out
            }
        }

        let isForwardingConfirmation: [WebExpected.InOut<String, Bool>]
        let forwardingConfirmUrl: [WebExpected.InOut<String, String?>]
        let confirmUrl: [Confirm]
    }

    /// match.faceToFaceAssumed (task 27).
    struct MatchM1: Decodable {
        struct Case: Decodable { let parcel: ParcelRow; let out: Bool }
        let faceToFaceAssumed: [Case]
    }

    static func load() throws -> WebExpectedM1 {
        let fallback = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Fixtures/web-expected.json")
        let url = WebExpected.bundledURL() ?? fallback
        return try JSONDecoder().decode(WebExpectedM1.self, from: Data(contentsOf: url))
    }
}

extension JSONValue {
    /// A query value as the Web's page gets it: a string is one value, an array its strings, null none.
    var queryValues: [String]? {
        switch self {
        case let .string(s): return [s]
        case let .array(xs): return xs.compactMap { if case let .string(s) = $0 { return s } else { return nil } }
        default: return nil
        }
    }
}
