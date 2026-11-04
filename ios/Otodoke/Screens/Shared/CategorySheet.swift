// src/app/app/category-sheet.tsx: a parcel's category as a chip; tapping it opens a sheet with the seven
// to pick from. The saving is the caller's (it takes only what to show and how to save), so the spend
// list can use it too.

import SwiftUI

struct CategoryChip: View {
    /// What the chip shows (nil = 未分類): the choice while it is being saved.
    let shown: ParcelCategory?
    /// The stored category: the sheet's ✓.
    let current: ParcelCategory?
    let isSaving: Bool
    let error: String?
    /// Saves the choice; true when it was saved (the sheet then closes).
    let choose: @MainActor (ParcelCategory) async -> Bool

    @State private var isOpen = false
    @State private var picked: ParcelCategory?

    var body: some View {
        Button {
            isOpen = true
        } label: {
            HStack(spacing: 6) {
                if isSaving {
                    ProgressView().controlSize(.mini)
                } else {
                    Circle().fill(color(shown)).frame(width: 8, height: 8)
                }
                Text(ParcelCategory.label(for: shown?.rawValue))
                    .lineLimit(1)
            }
            .font(.caption)
            .foregroundStyle(.primary)
            .fixedSize()
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .overlay(Capsule().stroke(Color(.systemGray4)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("分類: \(ParcelCategory.label(for: shown?.rawValue))（変える）")
        .sheet(isPresented: $isOpen) {
            CategorySheet(current: current, picked: picked, isSaving: isSaving, error: error) { category in
                picked = category
                if await choose(category) { isOpen = false }
            } close: {
                isOpen = false
            }
        }
    }

    private func color(_ category: ParcelCategory?) -> Color {
        OtodokeColor.hex(category?.colorHex ?? ParcelCategory.uncategorizedColorHex)
    }
}

/// The sheet: 分類 / 閉じる, the seven with their colours, ✓ on the stored one, a spinner on the one
/// being saved, and the error under the list.
struct CategorySheet: View {
    let current: ParcelCategory?
    let picked: ParcelCategory?
    let isSaving: Bool
    let error: String?
    let choose: @MainActor (ParcelCategory) async -> Void
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("分類")
                    .font(.headline)
                Spacer()
                Button("閉じる", action: close)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            VStack(spacing: 0) {
                ForEach(ParcelCategory.allCases, id: \.self) { category in
                    Button {
                        Task { await choose(category) }
                    } label: {
                        HStack(spacing: 12) {
                            Circle()
                                .fill(OtodokeColor.hex(category.colorHex))
                                .frame(width: 12, height: 12)
                            Text(category.label)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if isSaving && picked == category {
                                ProgressView().controlSize(.small)
                            } else if category == current {
                                Text("✓")
                            }
                        }
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 12)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(isSaving)
                    .opacity(isSaving && picked != category ? 0.6 : 1)
                    .accessibilityAddTraits(category == current ? .isSelected : [])
                }
            }
            if let error {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(OtodokeColor.errorText)
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(isSaving)
    }
}
