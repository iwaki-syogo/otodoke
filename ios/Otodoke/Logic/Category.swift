// TDD-STUB(task 5): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Port of src/lib/category.ts (the only source of the keys, labels and colours). Case order = CATEGORIES.

import Foundation

enum ParcelCategory: String, CaseIterable, Codable, Sendable {
    case food, daily, hobby, fashion, electronics, beauty, other

    var label: String { "" }

    /// "#2a78d6" style, as in category.ts.
    var colorHex: String { "" }

    static let uncategorizedLabel = ""
    static let uncategorizedColorHex = ""

    static func isCategory(_ value: String?) -> Bool { false }

    /// categoryLabel: the label of a stored value, 未分類 for nil or an unknown value.
    static func label(for raw: String?) -> String { "" }
}
