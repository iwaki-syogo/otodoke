// 「荷物を登録」 (src/app/app/parcels/new/page.tsx + manual-form.tsx) as a sheet inside the app: the same
// fields in the same order with the same words and defaults. The page's colours are the other screens'
// (grouped ground, white cards, the black button that turns white in dark mode, red errors).

import SwiftUI

struct ManualParcelView: View {
    @Bindable var model: ManualParcelModel
    let close: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    field(ManualParcelText.titleLabel) {
                        TextField("", text: $model.input.title)
                            .accessibilityLabel(ManualParcelText.titleLabel)
                    }
                    field(ManualParcelText.shopLabel) {
                        TextField("", text: $model.input.shop)
                            .accessibilityLabel(ManualParcelText.shopLabel)
                    }
                }
                Section {
                    field(ManualParcelText.orderedAtLabel) { DateChoice(text: $model.input.orderedAt, label: ManualParcelText.orderedAtLabel) }
                    field(ManualParcelText.expectedDateLabel) { DateChoice(text: $model.input.expectedDate, label: ManualParcelText.expectedDateLabel) }
                }
                Section {
                    field(ManualParcelText.amountLabel) {
                        HStack(spacing: 8) {
                            TextField(ManualParcelText.amountPlaceholder, text: $model.input.totalAmount)
                                .keyboardType(.numberPad)
                                .accessibilityLabel(ManualParcelText.amountLabel)
                            Text(ManualParcelText.amountUnit)
                        }
                    }
                    field(ManualParcelText.categoryLabel) {
                        choice(ManualParcelText.categoryLabel, $model.input.category, [("", ManualParcelText.uncategorized)] + ParcelCategory.allCases.map { ($0.rawValue, $0.label) })
                    }
                    field(ManualParcelText.trackingLabel) {
                        TextField("", text: $model.input.trackingNumber)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .accessibilityLabel(ManualParcelText.trackingLabel)
                    }
                    field(ManualParcelText.carrierLabel) {
                        choice(ManualParcelText.carrierLabel, $model.input.carrier, ManualCarrier.allCases.map { ($0.rawValue, ManualParcelText.carrierName($0)) })
                    }
                    field(ManualParcelText.presenceLabel) {
                        choice(ManualParcelText.presenceLabel, $model.input.presence, ManualPresence.allCases.map { ($0.rawValue, ManualParcelText.presenceName($0)) })
                    }
                    field(ManualParcelText.statusLabel) {
                        choice(ManualParcelText.statusLabel, $model.input.status, ManualStatus.allCases.map { ($0.rawValue, ManualParcelText.statusName($0)) })
                    }
                }
                Section {
                    if let error = model.error {
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(OtodokeColor.errorText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityAddTraits(.isStaticText)
                    }
                    submitButton
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(ManualParcelText.heading)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(ManualParcelText.close, action: close)
                }
            }
            .onChange(of: model.isSaved) { _, saved in
                if saved { close() }
            }
        }
        .interactiveDismissDisabled(model.isSending)
    }

    private var submitButton: some View {
        Button {
            // The keyboard goes, so the answer (the error under the form) is in view.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            Task { await model.submit() }
        } label: {
            HStack(spacing: 8) {
                if model.isSending { ProgressView().tint(Color(.systemBackground)) }
                Text(model.isSending ? ManualParcelText.submitting : ManualParcelText.submit)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color(.systemBackground))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(Color.primary, in: RoundedRectangle(cornerRadius: 12))
            .opacity(model.isSending ? 0.7 : 1)
        }
        .buttonStyle(.plain)
    }

    /// A label over its field, as the Web's `<label>`.
    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.subheadline.weight(.medium))
            content()
                .font(.body)
                .tint(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(.separator)))
        }
        .padding(.vertical, 2)
    }

    private func choice(_ label: String, _ selection: Binding<String>, _ options: [(value: String, name: String)]) -> some View {
        Picker(label, selection: selection) {
            ForEach(options, id: \.value) { Text($0.name).tag($0.value) }
        }
        .labelsHidden()
        .pickerStyle(.menu)
        .padding(.leading, -12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(label)
    }
}

/// A date that may be left empty: "YYYY-MM-DD" in Japan's calendar (the Web's `<input type="date">`).
private struct DateChoice: View {
    @Binding var text: String
    let label: String

    var body: some View {
        HStack(spacing: 12) {
            if let date = Self.date(text) {
                DatePicker(label, selection: Binding(get: { date }, set: { text = Self.text($0) }), displayedComponents: .date)
                    .labelsHidden()
                    .environment(\.calendar, JST.calendar)
                    .environment(\.timeZone, JST.calendar.timeZone)
                    .environment(\.locale, Locale(identifier: "ja_JP"))
                Spacer(minLength: 0)
                Button(ManualParcelText.dateClear) { text = "" }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
            } else {
                Button {
                    text = Format.todayJst(now: Date())
                } label: {
                    HStack(spacing: 6) {
                        Text(ManualParcelText.dateNone)
                        Image(systemName: "calendar").font(.footnote)
                    }
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
                Spacer(minLength: 0)
            }
        }
    }

    static func date(_ text: String) -> Date? {
        guard ManualParcel.isRealDate(text) else { return nil }
        let p = text.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        return JST.calendar.date(from: DateComponents(year: p[0], month: p[1], day: p[2], hour: 12))
    }

    static func text(_ date: Date) -> String { Format.todayJst(now: date) }
}
