// TDD-STUB(task 9): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// ParcelCardView (the SwiftUI view) goes in this file too and shows ParcelCardContent.
// The branches are those of src/app/app/parcel-card.tsx.

import Foundation

struct ParcelCardContent: Equatable, Sendable {
    let shop: String
    /// title ?? "品名の記載なし"
    let title: String
    let statusLabel: String
    /// "今日" / "明日〜11/6(金)" / "11/3(火)の予定"; nil without a date.
    let when: String?
    /// formatWindow(start, end), "" when none.
    let window: String
    /// 「お届け日はまだ未定」: no date and status ordered.
    let undecided: Bool
    /// BadgeText.presence(faceToFace, compact: true)
    let presenceBadge: String?
    let needsReview: Bool

    static func make(_ p: ParcelRow, today: String) -> ParcelCardContent {
        ParcelCardContent(shop: "", title: "", statusLabel: "", when: nil, window: "", undecided: false, presenceBadge: nil, needsReview: false)
    }
}
