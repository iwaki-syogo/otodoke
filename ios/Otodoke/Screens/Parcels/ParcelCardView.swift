// ParcelCardView shows ParcelCardContent, the branches of src/app/app/parcel-card.tsx.

import SwiftUI

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
        // A window ("10/23〜10/31") is late only after its last day.
        let lastDay = p.expectedDateEnd ?? p.expectedDate
        let late = lastDay.map { JSText.less($0, today) } == true && p.status != "delivered" && p.status != "cancelled"
        let days: String
        if let end = p.expectedDateEnd, !end.isEmpty {
            days = "\(Format.relativeDateJa(p.expectedDate, today: today))〜\(Format.relativeDateJa(end, today: today))"
        } else {
            days = Format.relativeDateJa(p.expectedDate, today: today)
        }
        let when: String? = if let date = p.expectedDate, !date.isEmpty { "\(days)\(late ? "の予定" : "")" } else { nil }
        return ParcelCardContent(
            shop: p.shop,
            title: p.title ?? "品名の記載なし",
            statusLabel: BadgeText.status(p.status),
            when: when,
            window: Format.formatWindow(start: p.expectedWindowStart, end: p.expectedWindowEnd),
            undecided: when == nil && p.status == "ordered",
            presenceBadge: BadgeText.presence(ParcelRules.faceToFace(p), compact: true),
            needsReview: p.needsReview
        )
    }
}

/// The card of a parcel in the list (ParcelCard). The row around it opens the detail.
struct ParcelCardView: View {
    let parcel: ParcelRow
    let today: String

    var body: some View {
        let c = ParcelCardContent.make(parcel, today: today)
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.shop)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text(c.title)
                        .font(.system(size: 15, weight: .medium))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                StatusBadge(status: parcel.status)
            }
            WrappingRow(spacing: 12, lineSpacing: 6) {
                if let when = c.when {
                    HStack(spacing: 4) {
                        Text(when).fontWeight(.bold)
                        if !c.window.isEmpty {
                            Text(c.window).foregroundStyle(.secondary)
                        }
                    }
                    .font(.subheadline)
                } else if c.undecided {
                    Text("お届け日はまだ未定")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                if c.presenceBadge != nil {
                    PresenceBadge(faceToFace: ParcelRules.faceToFace(parcel), compact: true)
                }
                if c.needsReview {
                    Text("要確認")
                        .font(.caption)
                        .foregroundStyle(OtodokeColor.adaptive(light: "#b45309", dark: "#fbbf24"))
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator).opacity(0.6)))
        .contentShape(RoundedRectangle(cornerRadius: 16))
    }
}
