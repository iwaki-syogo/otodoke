// Port of src/lib/category.ts (the only source of the keys, labels and colours). Case order = CATEGORIES.

import Foundation

enum ParcelCategory: String, CaseIterable, Codable, Sendable {
    case food, daily, hobby, fashion, electronics, beauty, other

    var label: String {
        switch self {
        case .food: return "食費"
        case .daily: return "日用品"
        case .hobby: return "趣味・レジャー"
        case .fashion: return "ファッション"
        case .electronics: return "家電・ガジェット"
        case .beauty: return "美容・健康"
        case .other: return "その他"
        }
    }

    /// "#2a78d6" style, as in category.ts.
    var colorHex: String {
        switch self {
        case .food: return "#2a78d6"
        case .daily: return "#eb6834"
        case .hobby: return "#1baf7a"
        case .fashion: return "#eda100"
        case .electronics: return "#e87ba4"
        case .beauty: return "#008300"
        case .other: return "#6250d6"
        }
    }

    static let uncategorizedLabel = "未分類"
    static let uncategorizedColorHex = "#a8a7a0"

    static func isCategory(_ value: String?) -> Bool {
        guard let value else { return false }
        return allCases.contains { JSText.equal($0.rawValue, value) }
    }

    /// categoryLabel: the label of a stored value, 未分類 for nil or an unknown value.
    static func label(for raw: String?) -> String {
        guard let raw, let category = allCases.first(where: { JSText.equal($0.rawValue, raw) }) else {
            return uncategorizedLabel
        }
        return category.label
    }
}
