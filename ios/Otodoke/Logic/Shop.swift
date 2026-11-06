// TDD-STUB(task 5) — agreed API, placeholder bodies. Remove this marker once written.
// Port of src/lib/shop.ts.

import Foundation

/// What `?c=` narrows to: no filter, 未分類 only, or one of the seven.
enum CategoryFilter: Equatable, Hashable, Sendable {
    case any
    case uncategorized
    case only(ParcelCategory)
}

enum Shop {
    /// NONE: 未分類 in `?c=`.
    static let none = ""
    /// SHOP_LABEL_MAX
    static let labelMax = 0

    /// normalizeShop: Amazon (shop_key = amazon) reads as one shop.
    static func normalizeShop(shop: String, shopKey: String?) -> String { "" }
    static func normalizeShop(_ p: ParcelRow) -> String { normalizeShop(shop: p.shop, shopKey: p.shopKey) }

    /// shopLabel: cut to labelMax code points with 「…」.
    static func shopLabel(_ name: String) -> String { "" }

    /// firstParam: the first of the values; nil for none (a single value is a one-element array).
    static func firstParam(_ values: [String]?) -> String? { nil }

    /// categoryParam: "none" → .uncategorized, one of the seven → .only, anything else → .any.
    static func categoryParam(_ values: [String]?) -> CategoryFilter { .any }
}
