// OrderList of src/app/app/spend/order-list.tsx: date, shop, title, amount and the category chip (the
// first batch's CategoryChip, saved through the model). Over the whole period the orders sit under
// order-month headings with their count; a month is one list.

import SwiftUI

struct SpendOrderList: View {
    @Bindable var model: SpendModel
    let open: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(model.orderGroups.enumerated()), id: \.offset) { _, group in
                VStack(alignment: .leading, spacing: 8) {
                    if !group.label.isEmpty {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(group.label).font(.caption.bold())
                            Text("\(group.parcels.count)").font(.caption)
                        }
                        .foregroundStyle(.secondary)
                    }
                    orders(group.parcels)
                }
            }
        }
    }

    private func orders(_ parcels: [ParcelRow]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(parcels.enumerated()), id: \.element.id) { i, p in
                if i > 0 { Divider() }
                row(p)
            }
        }
        .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color(.separator).opacity(0.6)))
    }

    private func row(_ p: ParcelRow) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                open(p.id)
            } label: {
                HStack(alignment: .top, spacing: 12) {
                    Text(Self.date(p.orderedAt, today: model.todayText))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(width: 56, alignment: .leading)
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.shop)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                        Text(p.title ?? "品名の記載なし")
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if p.totalAmount == nil {
                        Text("—").font(.subheadline).foregroundStyle(.tertiary)
                    } else {
                        Text(Format.yen(p.totalAmount))
                            .font(.subheadline.weight(.medium).monospacedDigit())
                            .foregroundStyle(.primary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            let category = Spend.categoryOf(p.category)
            CategoryChip(
                shown: category,
                current: category,
                isSaving: model.savingCategory.contains(p.id),
                error: model.categoryErrors[p.id],
                openEditor: { model.openCategoryEditor(p) }
            ) { chosen in
                await model.setCategory(parcelID: p.id, to: chosen)
            }
            .disabled(model.categoryLocked)
            .padding(.leading, 68)
        }
        .padding(16)
    }

    /// formatDateJa without the weekday: 「11/2」, 「2025/11/2」 in another year.
    static func date(_ orderedAt: String?, today: String) -> String {
        guard let orderedAt, !orderedAt.isEmpty else { return "" }
        let text = Format.formatDateJa(orderedAt, today: today)
        // .replace(/\(.\)/, ""): the first 「(x)」 of one character.
        let units = Array(text.utf16)
        var i = 0
        while i + 2 < units.count {
            if units[i] == 0x28, units[i + 2] == 0x29, !UTF16.isLeadSurrogate(units[i + 1]) {
                return String(decoding: units[..<i] + units[(i + 3)...], as: UTF16.self)
            }
            i += 1
        }
        return text
    }
}
