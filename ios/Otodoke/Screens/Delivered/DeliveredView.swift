// 「届いた荷物」: the heading with the number, the search box, the shop / category / month pickers,
// 「クリア」, the month groups of cards; a parcel opens its detail. As the Web's page.

import SwiftUI

struct DeliveredView<Detail: View>: View {
    @Bindable var model: DeliveredModel
    @ViewBuilder let detail: (String) -> Detail

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                StatusPageHeading(title: DeliveredModel.title, count: model.count, faded: model.isLoading)
                content
            }
            .padding(16)
        }
        .refreshable { await model.load() }
        .background(Color(.systemGroupedBackground))
        .navigationTitle(DeliveredModel.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.onAppear() }
    }

    @ViewBuilder
    private var content: some View {
        if let message = model.message, message != DeliveredModel.noMatchText {
            StatusPageMessage(text: message, isError: message == DeliveredModel.failedText)
        } else if let options = model.options, model.shown != nil {
            VStack(alignment: .leading, spacing: 24) {
                filters(options)
                Group {
                    if let message = model.message {
                        StatusPageMessage(text: message, isError: false)
                    } else {
                        StatusPageGroups(groups: model.groups, today: Format.todayJst(now: Date()), detail: detail)
                    }
                }
                .opacity(model.isLoading ? 0.5 : 1)
            }
        } else {
            ProgressView()
                .frame(maxWidth: .infinity)
                .padding(.top, 40)
        }
    }

    // MARK: the filters (filter-form.tsx)

    private func filters(_ options: DeliveredFilterOptions) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                TextField(DeliveredModel.searchPlaceholder, text: $model.query)
                    .textFieldStyle(.plain)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
                    .accessibilityLabel("検索")
                if model.isLoading {
                    ProgressView().controlSize(.small)
                }
                if model.isNarrowed {
                    Button(DeliveredModel.clearText) { model.clear() }
                        .font(.subheadline)
                        .underline()
                        .foregroundStyle(.secondary)
                        .buttonStyle(.plain)
                        .padding(.horizontal, 8)
                }
            }
            // The shop takes a row (its names run long); the category and the month share the next.
            picker(DeliveredModel.allShops, selection: $model.shop, choices: options.shops.map { ($0, $0) })
            HStack(spacing: 8) {
                picker(DeliveredModel.allCategories, selection: $model.category, choices: options.categories.map { ($0.value, $0.label) })
                picker(DeliveredModel.allMonths, selection: $model.month, choices: model.monthOptions.map { ($0, Self.monthName($0)) })
            }
        }
    }

    private func picker(_ all: String, selection: Binding<String>, choices: [(value: String, label: String)]) -> some View {
        let current = choices.first { $0.value == selection.wrappedValue }?.label ?? all
        return Menu {
            Picker(all, selection: selection) {
                Text(all).tag("")
                ForEach(choices, id: \.value) { choice in
                    Text(choice.label).tag(choice.value)
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(current)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .font(.body)
            .foregroundStyle(.primary)
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity)
            .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
        }
        // The chosen value in the text colour, as the Web's select (not the accent).
        .tint(.primary)
        .accessibilityLabel(all)
    }

    /// monthName of filter-form.tsx: 「2026年11月」.
    static func monthName(_ ym: String) -> String {
        let parts = ym.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        let y = parts.first.flatMap(JSNumber.integer).map(String.init) ?? "NaN"
        let m = parts.count > 1 ? (JSNumber.integer(parts[1]).map(String.init) ?? "NaN") : "NaN"
        return "\(y)年\(m)月"
    }
}

// MARK: - shared with the cancelled page

/// 「届いた荷物 1,101」: the page's heading with the number (none when not read or failed).
struct StatusPageHeading: View {
    let title: String
    let count: Int?
    var faded = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(title).font(.title3.bold())
            if let count {
                Text(StatusPageText.number(count))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .opacity(faded ? 0.5 : 1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// 「読み込めませんでした」 in the red box, or a grey line (届いた荷物はありません, 見つかりません).
struct StatusPageMessage: View {
    let text: String
    let isError: Bool

    var body: some View {
        if isError {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(OtodokeColor.errorText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Palette.errorBackground, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(Palette.errorBorder))
        } else {
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }
}

/// The order-month sections: 「2026年11月に注文 3」, then the cards; a card opens the detail.
struct StatusPageGroups<Detail: View>: View {
    let groups: [(label: String, parcels: [ParcelRow])]
    let today: String
    @ViewBuilder let detail: (String) -> Detail

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            ForEach(Array(groups.enumerated()), id: \.element.label) { _, group in
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(group.label).font(.headline)
                        Text("\(group.parcels.count)").font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(group.parcels) { parcel in
                        NavigationLink {
                            detail(parcel.id)
                        } label: {
                            ParcelCardView(parcel: parcel, today: today)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

enum StatusPageText {
    private static let grouping: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.numberStyle = .decimal
        f.usesGroupingSeparator = true
        return f
    }()

    /// count.toLocaleString("ja-JP"): 「1,101」.
    static func number(_ n: Int) -> String {
        grouping.string(from: NSNumber(value: n)) ?? String(n)
    }
}
