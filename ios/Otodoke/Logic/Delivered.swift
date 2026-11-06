// TDD-STUB(task 20): src/lib/delivered.ts (2541793): groupByOrderMonth, NO_ORDER_DATE_LABEL, itemNamesByParcel,
// searchWord (JS trim, then the first SEARCH_MAX UTF-16 units), filterDelivered (the word, the title, the
// shop, normalizeShop and the item names folded by NFKC then JS toLowerCase; a value that cannot narrow is
// left out), deliveredFilterOptions, monthChoices. Code-unit order, stable sorts, Asia/Tokyo nowhere needed.
// Names and signatures are the contract with WebParity4Tests; the bodies return placeholders.

import Foundation

/// parcel_items(parcel_id, name).
struct ParcelItemName: Codable, Equatable, Sendable {
    let parcelId: String
    let name: String

    enum CodingKeys: String, CodingKey {
        case parcelId = "parcel_id"
        case name
    }
}

/// ?q= ?s= ?c= ?m= (nil is not given; "" is given empty, as the page passes it).
struct DeliveredFilterValues: Equatable, Sendable {
    var q: String?
    var s: String?
    var c: String?
    var m: String?

    init(q: String? = nil, s: String? = nil, c: String? = nil, m: String? = nil) {
        self.q = q
        self.s = s
        self.c = c
        self.m = m
    }
}

struct DeliveredCategoryOption: Equatable, Sendable {
    let value: String
    let label: String
}

struct DeliveredFilterOptions: Equatable, Sendable {
    let shops: [String]
    let months: [String]
    let categories: [DeliveredCategoryOption]
}

enum Delivered {
    static let noOrderDateLabel = "注文日不明"
    static let searchMax = 100

    /// Newest month first, 「2026年5月に注文」; within a month the newest order date first (stable);
    /// no order date last under 「注文日不明」.
    static func groupByOrderMonth(_ parcels: [ParcelRow]) -> [(label: String, parcels: [ParcelRow])] {
        [] // TDD-STUB(task 20)
    }

    /// Item names by parcel id, in input order.
    static func itemNamesByParcel(_ items: [ParcelItemName]) -> [String: [String]] {
        [:] // TDD-STUB(task 20)
    }

    static func searchWord(_ q: String?) -> String {
        "" // TDD-STUB(task 20)
    }

    static func filterDelivered(_ parcels: [ParcelRow], itemNames: [String: [String]], values: DeliveredFilterValues) -> [ParcelRow] {
        [] // TDD-STUB(task 20)
    }

    static func deliveredFilterOptions(_ parcels: [ParcelRow]) -> DeliveredFilterOptions {
        DeliveredFilterOptions(shops: [], months: [], categories: []) // TDD-STUB(task 20)
    }

    static func monthChoices(_ months: [String], m: String?) -> [String] {
        [] // TDD-STUB(task 20)
    }
}
