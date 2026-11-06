// Port of src/lib/shop.ts (2541793): shops and the URL values the delivered and spend pages read.

import Foundation

/// What `?c=` narrows to: no filter, 未分類 only, or one of the seven.
enum CategoryFilter: Equatable, Hashable, Sendable {
    case any
    case uncategorized
    case only(ParcelCategory)
}

enum Shop {
    /// NONE: 未分類 in `?c=`.
    static let none = "none"
    /// SHOP_LABEL_MAX: how much of a shop name is shown where it comes from the URL.
    static let labelMax = 40

    /// normalizeShop: Amazon (shop_key = amazon) signs its mails under several names; they read as one.
    static func normalizeShop(shop: String, shopKey: String?) -> String {
        shopKey == "amazon" ? "Amazon" : shop
    }

    static func normalizeShop(_ p: ParcelRow) -> String { normalizeShop(shop: p.shop, shopKey: p.shopKey) }

    /// shopLabel: cut to labelMax code points (Array.from) with 「…」. Only for showing.
    static func shopLabel(_ name: String) -> String {
        let scalars = Array(name.unicodeScalars)
        guard scalars.count > labelMax else { return name }
        var view = String.UnicodeScalarView()
        view.append(contentsOf: scalars[0..<labelMax])
        return String(view) + "…"
    }

    /// firstParam: the first of the values; nil for none (a single value is a one-element array).
    static func firstParam(_ values: [String]?) -> String? {
        values?.first
    }

    /// categoryParam: "none" → .uncategorized, one of the seven → .only, anything else → .any.
    static func categoryParam(_ values: [String]?) -> CategoryFilter {
        guard let v = firstParam(values) else { return .any }
        if JSText.equal(v, none) { return .uncategorized }
        return Spend.categoryOf(v).map(CategoryFilter.only) ?? .any
    }
}
