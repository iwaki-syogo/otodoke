// PageLinkRow: the way to another page at the end of a list (src/app/app/page-link.tsx),
// 「届いた荷物 N 件 ›」. The whole row is the link.

import SwiftUI

enum PageLinkText {
    private static let grouping: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.numberStyle = .decimal
        f.usesGroupingSeparator = true
        return f
    }()

    /// "1,234 件" (count.toLocaleString("ja-JP") + " 件").
    static func count(_ n: Int) -> String {
        "\(grouping.string(from: NSNumber(value: n)) ?? String(n)) 件"
    }
}

struct PageLinkRow: View {
    let label: String
    /// nil: the count could not be read, so none is shown.
    let count: Int?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(label)
                    .underline()
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                HStack(spacing: 8) {
                    if let count {
                        Text(PageLinkText.count(count))
                    }
                    Text("›").accessibilityHidden(true)
                }
                .foregroundStyle(.secondary)
            }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(.separator).opacity(0.6)))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}
