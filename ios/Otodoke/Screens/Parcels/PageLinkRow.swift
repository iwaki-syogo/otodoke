// PageLinkRow: the way to another page at the end of a list (src/app/app/page-link.tsx),
// 「届いた荷物 ›」: the name and the arrow, no number (the number shows on the page it opens). The whole row is the link.

import SwiftUI

struct PageLinkRow: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(label)
                    .underline()
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                Text("›")
                    .accessibilityHidden(true)
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
