// The parcel page (src/app/app/parcels/[id]/page.tsx): the header with the badges and 「届いていない」,
// the fields, 内容 and メールの履歴. The three reads fail on their own with 「読み込めませんでした」.
// A parcel typed in by hand is edited (and deleted) in the app: 編集 opens the form as a sheet.

import SwiftUI

struct ParcelDetailView: View {
    @State private var model: ParcelDetailModel
    @State private var editForm: ManualParcelModel?
    /// The typed-in parcel was deleted in the sheet: this page goes back once the sheet has gone.
    @State private var deletedInSheet = false
    @Environment(\.dismiss) private var dismiss
    /// Mails shown open from the start (for the screen checks).
    private let initiallyOpen: Set<String>
    /// At the accessibility text sizes each label goes above its value.
    @Environment(\.dynamicTypeSize) private var typeSize
    /// Inactive (the app switcher, a system sheet) hides every opened sealed mail.
    @Environment(\.scenePhase) private var scenePhase

    init(model: ParcelDetailModel, initiallyOpen: Set<String> = []) {
        _model = State(initialValue: model)
        self.initiallyOpen = initiallyOpen
    }

    init(id: String, reader: ParcelReader, writer: ParcelWriter) {
        self.init(model: ParcelDetailModel(id: id, reader: reader, writer: writer, today: { Format.todayJst(now: Date()) }))
    }

    var body: some View {
        content
            .background(Color(.systemGroupedBackground))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.canEdit {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(ManualParcelText.edit) { editForm = model.makeEditForm() }
                    }
                }
            }
            .sheet(item: $editForm, onDismiss: {
                if deletedInSheet {
                    deletedInSheet = false
                    dismiss()
                }
            }) { form in
                ManualParcelView(model: form, close: { editForm = nil }, deleted: { deletedInSheet = true; editForm = nil })
            }
            .task { await model.onAppear() }
            .onChange(of: scenePhase, initial: true) { _, phase in
                model.sceneChanged(phase)
            }
    }

    @ViewBuilder private var content: some View {
        switch model.parcel {
        case nil:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .failed?:
            ScrollView {
                ErrorBox()
                    .padding(16)
            }
            .refreshableToTheEnd { await model.load() }
        case .loaded(nil)?:
            ScrollView {
                Text("見つかりません")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .refreshableToTheEnd { await model.load() }
        case let .loaded(p?)?:
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if let f = model.fields {
                        header(p, f)
                        fieldsCard(p, f)
                    }
                    itemsSection
                    mailsSection
                }
                .padding(16)
            }
            .refreshableToTheEnd { await model.load() }
        }
    }

    // MARK: header

    private func header(_ p: ParcelRow, _ f: ParcelDetailFields) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(f.shop)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(f.title)
                .font(.title3.bold())
                .lineLimit(3)
                .padding(.top, 4)
            WrappingRow {
                StatusBadge(status: p.status, receivedAt: p.receivedAt)
                PresenceBadge(parcel: p)
                if f.needsReview { ReviewBadge() }
            }
            .padding(.top, 12)
            WrappingRow {
                if model.showsMarkReceived {
                    receiptButton("受け取った", action: { await model.markReceived() })
                }
                if model.showsNotReceived {
                    receiptButton("受け取っていない", action: { await model.markNotReceived() })
                }
                if model.showsNotDelivered { notDeliveredButton }
            }
            .padding(.top, 12)
            if let error = model.receiptError {
                Text(error).font(.subheadline).foregroundStyle(OtodokeColor.errorText).padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func receiptButton(_ title: String, action: @escaping @MainActor () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            HStack(spacing: 8) {
                if model.isChangingReceipt { ProgressView().controlSize(.mini) }
                Text(title)
            }
            .font(.subheadline)
            .foregroundStyle(.primary)
            .padding(.horizontal, 12)
            .frame(minHeight: 44)
            .background(Color(.secondarySystemGroupedBackground), in: Capsule())
            .overlay(Capsule().stroke(Color(.systemGray3)))
        }
        .buttonStyle(.plain)
        .disabled(model.isChangingReceipt || model.isMarkingNotDelivered)
    }

    private var notDeliveredButton: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task { await model.markNotDelivered() }
            } label: {
                HStack(spacing: 8) {
                    if model.isMarkingNotDelivered {
                        ProgressView().controlSize(.mini)
                    }
                    Text("届いていない")
                }
                .font(.subheadline)
                .foregroundStyle(.primary)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .background(Color(.secondarySystemGroupedBackground), in: Capsule())
                .overlay(Capsule().stroke(Color(.systemGray3)))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(model.isMarkingNotDelivered || model.isChangingReceipt)
            .opacity(model.isMarkingNotDelivered ? 0.6 : 1)
            if let error = model.notDeliveredError {
                Text(error)
                    .font(.subheadline)
                    .foregroundStyle(OtodokeColor.errorText)
            }
        }
    }

    // MARK: fields

    private func fieldsCard(_ p: ParcelRow, _ f: ParcelDetailFields) -> some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 12) {
            field("お届け予定") {
                VStack(alignment: .leading, spacing: 2) {
                    if let expected = f.expected {
                        Text(expected).fontWeight(.medium)
                        if let original = f.expectedOriginal {
                            Text("原文: \(original)").font(.caption).foregroundStyle(.secondary)
                        }
                    } else {
                        Text("未定").foregroundStyle(.secondary)
                    }
                }
            }
            field("受け取り") {
                VStack(alignment: .leading, spacing: 2) {
                    Text(f.presence)
                        .foregroundStyle(ParcelRules.faceToFace(p) == nil ? .secondary : .primary)
                    if let note = f.presenceAssumedNote {
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    } else if let evidence = f.presenceEvidence {
                        Text("根拠: 「\(evidence)」").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            field("配送") {
                deliveryValue(p)
            }
            if let evidence = model.deliveryEvidence {
                field("配達完了") { Text("「\(evidence)」") }
            }
            field("注文") {
                VStack(alignment: .leading, spacing: 2) {
                    if let ordered = f.ordered {
                        Text(ordered)
                    } else {
                        Text("不明").foregroundStyle(.secondary)
                    }
                    if let number = f.orderNumber {
                        Text("番号 \(number)").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            field("金額") {
                Text(f.amount).fontWeight(.medium)
            }
            field("分類") {
                CategoryChip(
                    shown: model.shownCategory,
                    current: model.storedCategory,
                    isSaving: model.isSavingCategory,
                    error: model.categoryError
                ) { category in
                    await model.setCategory(category)
                }
            }
        }
        .font(.subheadline)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
    }

    /// One label and its value: a grid row (the label 6rem wide, as on the Web), or the label above
    /// the value at the accessibility text sizes.
    @ViewBuilder private func field(_ term: String, @ViewBuilder _ value: () -> some View) -> some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 2) {
                Text(term).foregroundStyle(.secondary)
                value()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            GridRow {
                Text(term)
                    .foregroundStyle(.secondary)
                    .frame(width: 96, alignment: .leading)
                value()
            }
        }
    }

    @ViewBuilder private func deliveryValue(_ p: ParcelRow) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if let carrier = p.carrier {
                Text(carrier)
            } else {
                Text("メールに記載なし").foregroundStyle(.secondary)
            }
            if let number = p.trackingNumber, !number.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("伝票 \(number)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    if let action = model.tracking {
                        TrackingLinkView(action: action)
                    }
                }
            }
        }
    }

    // MARK: 内容

    @ViewBuilder private var itemsSection: some View {
        switch model.items {
        case .failed?:
            VStack(alignment: .leading, spacing: 8) {
                sectionTitle("内容")
                ErrorBox()
            }
        case let .loaded(items)? where !items.isEmpty:
            VStack(alignment: .leading, spacing: 8) {
                sectionTitle("内容")
                VStack(spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                        if index > 0 { Divider() }
                        HStack(alignment: .top, spacing: 12) {
                            Text(item.name)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            let detail = Self.itemDetail(item)
                            if !detail.isEmpty {
                                Text(detail)
                                    .foregroundStyle(.secondary)
                                    .fixedSize()
                            }
                        }
                        .font(.subheadline)
                        .padding(12)
                    }
                }
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
            }
        default:
            EmptyView()
        }
    }

    /// "×2 ¥1,200": the quantity when not 0, then the unit price when known.
    static func itemDetail(_ item: ParcelItemRow) -> String {
        var text = ""
        if let q = item.quantity, q != 0 { text += "×\(q)" }
        if item.unitPrice != nil { text += " " + Format.yen(item.unitPrice) }
        return text.trimmingCharacters(in: .whitespaces)
    }

    // MARK: メールの履歴

    private var mailsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("メールの履歴")
            switch model.timeline {
            case .failed?:
                ErrorBox()
            case let .loaded(entries)? where entries.isEmpty:
                Text("元メールがありません")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            case let .loaded(entries)?:
                VStack(spacing: 8) {
                    ForEach(entries) { entry in
                        MailCard(entry: entry, model: model, startsOpen: initiallyOpen.contains(entry.id))
                    }
                }
            case nil:
                EmptyView()
            }
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.headline)
    }
}

/// 「読み込めませんでした」 in the Web's red box.
struct ErrorBox: View {
    var body: some View {
        Text("読み込めませんでした")
            .font(.subheadline)
            .foregroundStyle(OtodokeColor.errorText)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.red.opacity(0.25)))
    }
}

/// One mail: its kind and time, subject, sender, confidence, and 「元メールを見る」 with the text, by
/// body_state (MailBody): a sealed mail is opened here with Face ID or the passphrase (sealed-mail.tsx), a
/// dropped one says what was not kept, a state this version does not know is not opened.
private struct MailCard: View {
    let entry: TimelineEntry
    let model: ParcelDetailModel
    @State private var isOpen: Bool

    init(entry: TimelineEntry, model: ParcelDetailModel, startsOpen: Bool) {
        self.entry = entry
        self.model = model
        _isOpen = State(initialValue: startsOpen)
    }

    private var kind: MailDisplay.Kind { entry.mail?.kind ?? .plain }

    /// What this sealed mail came to (closed for every other kind).
    private var sealedState: SealedState {
        guard kind == .sealed, let emailID = entry.emailID else { return .closed }
        return model.sealedState(emailID: emailID)
    }

    /// The opened sealed mail, while it may be shown (not when the scene is inactive).
    private var openedMail: OpenedMail? {
        guard !model.isBodyHidden, case let .opened(mail) = sealedState else { return nil }
        return mail
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entry.label)
                    .fontWeight(.medium)
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
                Text(entry.dateText)
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
            if kind == .plain {
                if let subject = entry.subject {
                    Text(subject)
                        .font(.subheadline)
                        .padding(.top, 4)
                }
                if let from = entry.fromText {
                    Text(from)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.top, 2)
                }
            } else if let opened = openedMail {
                // sealed-mail.tsx: once open, the subject and the sender instead of the lock.
                if let subject = opened.subject {
                    Text(subject)
                        .font(.subheadline)
                        .padding(.top, 4)
                }
                if let from = opened.fromText {
                    Text(from)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.top, 2)
                }
            } else if let mail = entry.mail {
                if let headline = mail.headline {
                    Text(headline)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                }
                if let domain = mail.fromDomain {
                    Text(domain)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .padding(.top, 2)
                }
            }
            if kind != .unopenable {
                details
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16))
        .onChange(of: sealedState == .closed) { _, closed in
            // Dropped (the background, sign-out): folded again; the next press asks for the key again.
            if closed && kind == .sealed { isOpen = false }
        }
    }

    /// The confidence and 「元メールを見る」.
    @ViewBuilder private var details: some View {
        if let confidence = entry.confidenceText {
            Text(confidence)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.top, 4)
        }
        Button {
            isOpen.toggle()
            if isOpen, kind == .sealed, let emailID = entry.emailID, model.startsOpening(emailID: emailID) {
                model.startOpeningSealed(emailID: emailID)
            }
        } label: {
            Text("元メールを見る")
                .font(.caption)
                .foregroundStyle(OtodokeColor.link)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 8)
        if isOpen {
            if let notes = entry.notes {
                Text("読み取りメモ: \(notes)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
            }
            switch kind {
            case .plain:
                MailText(text: entry.mail?.detail ?? (entry.body.isEmpty ? MailBody.noBody : entry.body))
                    .padding(.top, 8)
            case .dropped:
                Text(entry.mail?.detail ?? MailBody.droppedDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(.top, 8)
            case .sealed:
                sealedDetail
                    .padding(.top, 8)
            case .unopenable:
                EmptyView()
            }
        }
    }
}

extension MailCard {
    /// Inside 「元メールを見る」 of a sealed mail, by what opening it came to (sealed-mail.tsx).
    @ViewBuilder fileprivate var sealedDetail: some View {
        switch sealedState {
        case .closed where model.unlock == nil:
            Text(UnlockModel.failedText)
                .font(.caption)
                .foregroundStyle(OtodokeColor.errorText)
        case .closed, .opening:
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text(UnlockModel.openingText)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        case .unlocking:
            if let unlock = model.unlock, let emailID = entry.emailID {
                UnlockView(model: unlock) { model.startOpeningSealed(emailID: emailID) }
            }
        case let .opened(mail):
            if !model.isBodyHidden {
                VStack(alignment: .leading, spacing: 8) {
                    MailText(text: mail.body.isEmpty ? MailBody.noBody : mail.body)
                    if model.unlock?.saveResult == .memoryOnly {
                        Text(FaceIDText.cannotSave(model.unlock?.biometry))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        case .failed:
            Text(UnlockModel.failedText)
                .font(.caption)
                .foregroundStyle(OtodokeColor.errorText)
        case .oldKey:
            Text(UnlockModel.oldKeyText)
                .font(.caption)
                .foregroundStyle(.secondary)
        case .readFailed:
            Text(UnlockModel.readFailedText)
                .font(.caption)
                .foregroundStyle(OtodokeColor.errorText)
        }
    }
}

/// The mail's text in a box at most 384 points tall, scrolling inside when longer.
private struct MailText: View {
    let text: String
    @State private var height: CGFloat = 0
    private static let maxHeight: CGFloat = 384

    var body: some View {
        ScrollView {
            Text(text)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .frame(height: min(max(height, 1), Self.maxHeight))
        .background(Color(.tertiarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 8))
    }
}
