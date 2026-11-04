// TDD-STUB(task 8): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// StatusBadge / PresenceBadge (the SwiftUI views) go in this file too and take their text from here.

import Foundation

enum BadgeText {
    /// STATUS_LABEL[status] ?? status.
    static func status(_ status: String) -> String { "" }

    /// faceToFace → "🤝 対面受け取り" (compact) / "🤝 対面受け取りが必要" / "置き配・投函OK" / nil.
    static func presence(_ faceToFace: Bool?, compact: Bool) -> String? { nil }
}
