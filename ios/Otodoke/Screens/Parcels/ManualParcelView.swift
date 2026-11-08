// 「荷物を登録」 (src/app/app/parcels/new/page.tsx + manual-form.tsx) as a sheet inside the app: the same
// fields in the same order with the same words and defaults. The page's colours are the other screens'
// (grouped ground, white cards, the black button that turns white in dark mode, red errors).

import SwiftUI

struct ManualParcelView: View {
    @Bindable var model: ManualParcelModel
    let close: () -> Void
    /// The parcel was deleted (the detail page behind the sheet goes too).
    var deleted: () -> Void = {}

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
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
                    field(ManualParcelText.orderedAtLabel) { DateChoice(text: $model.input.orderedAt, label: ManualParcelText.orderedAtLabel, canClear: false) }
                    field(ManualParcelText.expectedDateLabel) { DateChoice(text: $model.input.expectedDate, label: ManualParcelText.expectedDateLabel, canClear: true) }
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
                        choice(ManualParcelText.carrierLabel, $model.input.carrier, carrierChoices)
                    }
                    field(ManualParcelText.presenceLabel) {
                        choice(ManualParcelText.presenceLabel, $model.input.presence, ManualPresence.allCases.map { ($0.rawValue, ManualParcelText.presenceName($0)) })
                    }
                    field(ManualParcelText.statusLabel) {
                        choice(ManualParcelText.statusLabel, $model.input.status, model.statusChoices.map { ($0.value, $0.name) })
                    }
                }
                Section {
                    if let error = model.error {
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(OtodokeColor.errorText)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(Self.errorRow)
                    }
                    submitButton
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                if model.isEditing { deleteSection }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(model.isEditing ? ManualParcelText.editHeading : ManualParcelText.heading)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // Closing while a write is on its way would let the same form be opened and sent again.
                    Button(ManualParcelText.close, action: close)
                        .disabled(model.isBusy)
                }
            }
            .onChange(of: model.isSaved) { _, saved in
                if saved { close() }
            }
            .onChange(of: model.isDeleted) { _, gone in
                if gone {
                    close()
                    deleted()
                }
            }
            .onChange(of: model.error) { _, message in shown(message, proxy) }
            .onChange(of: model.deleteError) { _, message in shown(message, proxy, row: Self.deleteErrorRow) }
            }
        }
        .interactiveDismissDisabled(model.isBusy)
    }

    private static let errorRow = "error"
    private static let deleteErrorRow = "deleteError"

    /// A new error is read out by VoiceOver and scrolled into view (the keyboard has gone by then).
    private func shown(_ message: String?, _ proxy: ScrollViewProxy, row: String = errorRow) {
        guard let message else { return }
        AccessibilityNotification.Announcement(message).post()
        Task {
            try? await Task.sleep(for: .milliseconds(250))
            withAnimation { proxy.scrollTo(row, anchor: .center) }
        }
    }

    private var carrierChoices: [(String, String)] {
        var choices = ManualCarrier.allCases.map { ($0.rawValue, ManualParcelText.carrierName($0)) }
        // A carrier name a mail filled in that the five do not cover stays as a choice of its own.
        if let kept = model.keptCarrier { choices.insert((ManualParcel.keepCarrier, kept), at: 1) }
        return choices
    }

    /// The Web's 「この荷物を消す」 (a details element): the warning, 「本当に消す」, and 消す.
    private var deleteSection: some View {
        Section {
            DisclosureGroup(ManualParcelText.deleteSummary) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(ManualParcelText.deleteWarning).font(.subheadline)
                    ConfirmCheck(title: ManualParcelText.deleteConfirm, isOn: $model.deleteConfirmed, identifier: "manual-delete-check")
                    if let message = model.deleteError {
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(OtodokeColor.errorText)
                            .id(Self.deleteErrorRow)
                    }
                    Button {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                        Task { await model.deleteParcel() }
                    } label: {
                        HStack(spacing: 8) {
                            if model.isDeleting { ProgressView().controlSize(.small) }
                            Text(model.isDeleting ? ManualParcelText.deleting : ManualParcelText.deleteButton)
                        }
                        .font(.subheadline)
                        .foregroundStyle(OtodokeColor.errorText)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.red.opacity(0.4)))
                        .opacity(model.isDeleting ? 0.7 : 1)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, 8)
            }
            .font(.subheadline)
            .accessibilityIdentifier("manual-delete-section")
        }
    }

    private var submitButton: some View {
        Button {
            // The keyboard goes, so the answer (the error under the form) is in view.
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            Task { await model.submit() }
        } label: {
            HStack(spacing: 8) {
                if model.isSending { ProgressView().tint(Color(.systemBackground)) }
                Text(model.isSending ? ManualParcelText.submitting : (model.isEditing ? ManualParcelText.save : ManualParcelText.submit))
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
            // The control says its own label; reading the heading as well would say it twice.
            Text(label).font(.subheadline.weight(.medium)).accessibilityHidden(true)
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
    /// The Web's date field has a clear of its own. Not for the order date: left empty it is today for a new
    /// parcel and the stored date for an edit, so 「指定なし」 would say what is not so.
    let canClear: Bool

    /// The checks' range (isRealDate): 1900 to 2100.
    private static let range: ClosedRange<Date> = {
        let low = JST.calendar.date(from: DateComponents(year: 1900, month: 1, day: 1, hour: 12)) ?? .distantPast
        let high = JST.calendar.date(from: DateComponents(year: 2100, month: 12, day: 31, hour: 12)) ?? .distantFuture
        return low...high
    }()

    var body: some View {
        HStack(spacing: 12) {
            if let date = Self.date(text) {
                DatePicker(label, selection: Binding(get: { date }, set: { text = Self.text($0) }), in: Self.range, displayedComponents: .date)
                    .labelsHidden()
                    .environment(\.calendar, JST.calendar)
                    .environment(\.timeZone, JST.calendar.timeZone)
                    .environment(\.locale, Locale(identifier: "ja_JP"))
                Spacer(minLength: 0)
                if canClear {
                    Button(ManualParcelText.dateClear) { text = "" }
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .buttonStyle(.plain)
                        .accessibilityLabel(ManualParcelText.dateClearLabel(label))
                }
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
                .accessibilityValue(ManualParcelText.dateNone)
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
