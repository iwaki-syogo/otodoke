// StatusBadge / PresenceBadge of src/app/app/parcel-card.tsx. The text comes from BadgeText, the colours
// from the Web's STATUS_STYLE (Tailwind's palette).

import SwiftUI
import UIKit

enum BadgeText {
    /// STATUS_LABEL[status] ?? status.
    static func status(_ status: String, receivedAt: String? = nil) -> String {
        if status == "delivered", ParcelRules.isReceivedAt(receivedAt) { return "受け取り済み" }
        return Format.statusLabel[status] ?? status
    }

    /// ASSUMED_FACE_TO_FACE of parcel-card.tsx: the same words everywhere.
    static let assumedFaceToFace = "念のため対面"

    /// PresenceBadge of parcel-card.tsx (2541793): "🤝 念のため対面" when faceToFaceAssumed, else as
    /// `presence(_:compact:)`.
    static func presence(for p: ParcelRow, compact: Bool) -> String? {
        presence(ParcelRules.faceToFace(p), assumed: ParcelRules.faceToFaceAssumed(p), compact: compact)
    }

    static func presence(_ faceToFace: Bool?, assumed: Bool, compact: Bool) -> String? {
        if faceToFace == true && assumed { return "🤝 \(assumedFaceToFace)" }
        return presence(faceToFace, compact: compact)
    }

    /// faceToFace → "🤝 対面受け取り" (compact) / "🤝 対面受け取りが必要" / "置き配・投函OK" / nil.
    static func presence(_ faceToFace: Bool?, compact: Bool) -> String? {
        switch faceToFace {
        case true?: return compact ? "🤝 対面受け取り" : "🤝 対面受け取りが必要"
        case false?: return "置き配・投函OK"
        case nil: return nil
        }
    }
}

/// The colours the screens share, as the Web names them.
enum OtodokeColor {
    /// "#2a78d6" → Color. A string that is not six hex digits gives gray.
    static func hex(_ text: String) -> Color {
        let digits = text.hasPrefix("#") ? String(text.dropFirst()) : text
        guard digits.count == 6, let v = UInt32(digits, radix: 16) else { return .gray }
        return Color(
            red: Double((v >> 16) & 0xFF) / 255,
            green: Double((v >> 8) & 0xFF) / 255,
            blue: Double(v & 0xFF) / 255
        )
    }

    /// A colour for light mode and one for dark mode.
    static func adaptive(light: String, dark: String) -> Color {
        let l = UIColor(hex(light)), d = UIColor(hex(dark))
        return Color(UIColor { $0.userInterfaceStyle == .dark ? d : l })
    }

    /// text-sky-700 (links): sky-400 in dark mode.
    static let link = adaptive(light: "#0369a1", dark: "#38bdf8")
    /// The red of 「読み込めませんでした」 and the errors (red-800 / red-300).
    static let errorText = adaptive(light: "#991b1b", dark: "#fca5a5")
}

/// The status pill (STATUS_STYLE).
struct StatusBadge: View {
    let status: String
    var receivedAt: String? = nil

    var body: some View {
        let style = Self.style(status, receivedAt: receivedAt)
        Text(BadgeText.status(status, receivedAt: receivedAt))
            .font(.caption2.weight(.medium))
            .strikethrough(status == "cancelled")
            .foregroundStyle(OtodokeColor.adaptive(light: style.light.text, dark: style.dark.text))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(OtodokeColor.adaptive(light: style.light.background, dark: style.dark.background), in: Capsule())
    }

    typealias Pair = (background: String, text: String)

    /// The Web's STATUS_STYLE in light mode. The Web has no dark mode: in dark mode each pill takes the
    /// same hue, dark (the 900s / 950s) behind a light text (the 200s / 300s), as the amber and red boxes do.
    static func style(_ status: String, receivedAt: String? = nil) -> (light: Pair, dark: Pair) {
        if status == "delivered", ParcelRules.isReceivedAt(receivedAt) {
            return (("#f5f5f5", "#525252"), ("#262626", "#d4d4d4"))
        }
        switch status {
        case "ordered": return (("#f5f5f5", "#404040"), ("#262626", "#d4d4d4"))
        case "shipped": return (("#e0f2fe", "#075985"), ("#082f49", "#bae6fd"))
        case "out_for_delivery": return (("#fef3c7", "#78350f"), ("#3a2a0a", "#fde68a"))
        case "attempted": return (("#fee2e2", "#991b1b"), ("#3b0d0d", "#fca5a5"))
        case "delivered": return (("#d1fae5", "#065f46"), ("#022c22", "#6ee7b7"))
        default: return (("#f5f5f5", "#737373"), ("#262626", "#a3a3a3")) // cancelled, unknown and anything else
        }
    }
}

/// Face-to-face or not (ParcelRules.faceToFace): nothing when unknown. The default (念のため対面) keeps the red.
struct PresenceBadge: View {
    let faceToFace: Bool?
    var compact = false
    var assumed = false

    init(faceToFace: Bool?, compact: Bool = false, assumed: Bool = false) {
        self.faceToFace = faceToFace
        self.compact = compact
        self.assumed = assumed
    }

    init(parcel: ParcelRow, compact: Bool = false) {
        self.init(faceToFace: ParcelRules.faceToFace(parcel), compact: compact, assumed: ParcelRules.faceToFaceAssumed(parcel))
    }

    var body: some View {
        if let text = BadgeText.presence(faceToFace, assumed: assumed, compact: compact) {
            let face = faceToFace == true
            Text(text)
                .font(.caption2.weight(face ? .bold : .medium))
                .foregroundStyle(face ? Color.white : OtodokeColor.adaptive(light: "#065f46", dark: "#6ee7b7"))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(face ? OtodokeColor.hex("#dc2626") : OtodokeColor.adaptive(light: "#ecfdf5", dark: "#022c22"), in: Capsule())
        }
    }
}

/// 「要確認」 as a pill (the detail page's header).
struct ReviewBadge: View {
    var body: some View {
        Text("要確認")
            .font(.caption2.weight(.medium))
            .foregroundStyle(OtodokeColor.adaptive(light: "#78350f", dark: "#fde68a"))
            .lineLimit(1)
            .fixedSize()
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(OtodokeColor.adaptive(light: "#fef3c7", dark: "#3a2a0a"), in: Capsule())
    }
}

/// Lays its children out in rows, wrapping to the next row when one is full (flex-wrap).
struct WrappingRow: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + lineSpacing * CGFloat(max(rows.count - 1, 0))
        return CGSize(width: proposal.width.map { min($0, width) } ?? width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y + (row.height - size.height) / 2), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + lineSpacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width limit: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let next = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            if !row.indices.isEmpty && next > limit {
                rows.append(row)
                row = Row()
            }
            row.width = row.indices.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}
