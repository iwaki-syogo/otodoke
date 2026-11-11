// The view model of ManualParcelView (src/app/app/parcels/manual-form.tsx, createManualParcel,
// updateManualParcel, deleteManualParcel): one form for a new parcel and for an edit.
// 登録 / 保存 checks the form like the Web's schema and sends ONE write; then:
//  - success: the sheet closes, the list (or the parcel) is read again;
//  - the write surely did not happen: the Web's words, the form keeps what was typed;
//  - the result is unknown (the answer was lost): the screen is read again and the form says it could
//    not be confirmed. The form stays open, and pressing again is safe by how each write is made:
//    a new parcel is sent with the id the form made when it was opened. The first send having made it answers
//    23505, and the stored row is read: the same as the form is a success; one nobody has touched since
//    (updated_at == created_at) is written over with what is typed now; one a mail joined is not written
//    and says 「changed」 (the parcel exists, opening it again shows it).
//    An edit is conditioned on the updated_at the form was opened with: when the first send went through the
//    stored updated_at has moved, so the second save is a success if the form says exactly what is stored
//    (nothing is written), and 「changed」 (nothing written) if anything differs.
//    A delete of a parcel that is gone answers 0 rows and the parcel is read to see.
// A second press while one is on its way is ignored (the button shows the spinner, it is not disabled).

import Foundation
import Observation

@MainActor
@Observable
final class ManualParcelModel: Identifiable {
    typealias Save = @Sendable (ManualParcelRow) async -> WriteOutcome<String>
    typealias Update = @Sendable (String, ManualParcelInput, String) async -> ParcelWriter.ManualEditOutcome
    typealias Delete = @Sendable (String) async -> WriteOutcome<String>
    typealias UserID = @Sendable () async -> String?
    /// Whether the parcel is still there: nil when it could not be read.
    typealias StillThere = @Sendable () async -> Bool?

    /// The parcel being edited; nil for a new one.
    let editing: ParcelRow?
    var input: ManualParcelInput
    private(set) var error: String?
    private(set) var isSending = false
    /// The parcel was saved: the sheet closes.
    private(set) var isSaved = false
    /// How many write calls were made for 登録 / 保存 (a second press while sending adds none).
    private(set) var sendCount = 0

    // The delete (an edit only).
    var deleteConfirmed = false
    private(set) var deleteError: String?
    private(set) var isDeleting = false
    /// The parcel is gone: the sheet closes and the detail with it.
    private(set) var isDeleted = false
    private(set) var deleteCount = 0
    private var deleteUnconfirmed = false

    /// The id of a new parcel, made when the form was opened and used for every send of this form.
    let newID: String

    @ObservationIgnored private let save: Save
    @ObservationIgnored private let update: Update
    @ObservationIgnored private let delete: Delete
    @ObservationIgnored private let stillThere: StillThere
    @ObservationIgnored private let userID: UserID
    @ObservationIgnored private let reload: @MainActor () async -> Void
    @ObservationIgnored private let now: @Sendable () -> Date

    /// A new parcel.
    init(
        today: String,
        save: @escaping Save,
        userID: @escaping UserID,
        reload: @escaping @MainActor () async -> Void,
        now: @escaping @Sendable () -> Date = { Date() },
        newID: String = UUID().uuidString.lowercased()
    ) {
        editing = nil
        input = .defaults(today: today)
        self.newID = newID
        self.save = save
        update = { _, _, _ in .failed }
        delete = { _ in .notUpdated(.failed) }
        stillThere = { nil }
        self.userID = userID
        self.reload = reload
        self.now = now
    }

    /// A parcel typed in by hand, edited: the form starts with what is stored.
    init(
        editing parcel: ParcelRow,
        update: @escaping Update,
        delete: @escaping Delete,
        stillThere: @escaping StillThere,
        userID: @escaping UserID,
        reload: @escaping @MainActor () async -> Void
    ) {
        editing = parcel
        input = ManualParcelInput(editing: parcel)
        newID = parcel.id
        save = { _ in .notUpdated(.failed) }
        self.update = update
        self.delete = delete
        self.stillThere = stillThere
        self.userID = userID
        self.reload = reload
        now = { Date() }
    }

    /// The app's: the list's writer and list.
    static func live(list: ParcelListModel) -> ManualParcelModel {
        let writer = list.writer
        return ManualParcelModel(
            today: list.todayJst,
            save: { await writer.createManual($0) },
            userID: { await writer.provider.currentUserID() },
            reload: { await list.load() }
        )
    }

    /// The app's, for the parcel the detail page shows.
    static func live(editing parcel: ParcelRow, writer: ParcelWriter, reader: ParcelReader, reload: @escaping @MainActor () async -> Void) -> ManualParcelModel {
        let id = parcel.id
        return ManualParcelModel(
            editing: parcel,
            update: { await writer.updateManual(id: $0, input: $1, openedUpdatedAt: $2) },
            delete: { await writer.deleteManual(id: $0) },
            stillThere: {
                switch await reader.parcel(id: id) {
                case let .loaded(row): row != nil
                case .failed: nil
                }
            },
            userID: { await writer.provider.currentUserID() },
            reload: reload
        )
    }

    var isEditing: Bool { editing != nil }

    /// Nothing may close the sheet while a write is on its way.
    var isBusy: Bool { isSending || isDeleting }

    /// 状態's choices: the Web's three, and the one a mail set while the parcel is there.
    var statusChoices: [(value: String, name: String)] {
        ManualParcelText.statusChoices(keeping: editing?.status ?? "")
    }

    /// 運送会社's extra choice: a stored carrier name the five do not cover.
    var keptCarrier: String? {
        guard let editing, ManualParcel.carrierChoice(editing.carrier, tracking: editing.trackingNumber) == ManualParcel.keepCarrier else { return nil }
        return editing.carrier
    }

    /// 登録 / 保存.
    func submit() async {
        guard !isBusy, !isSaved, !isDeleted else { return }
        // Set before anything is awaited, so a second press in the gap is ignored too.
        isSending = true
        error = nil
        let typed = input
        defer { isSending = false }
        if let editing {
            await saveEdit(editing, typed)
            return
        }
        // The form is checked first, so a wrong form is told its fault whoever is signed in (the Web asks
        // for the sign-in first); then the row is made for the signed-in user.
        switch ManualParcel.check(typed, userId: "", now: now(), id: newID) {
        case let .invalid(message):
            error = message
        case .valid:
            guard let me = await userID(), case let .valid(row) = ManualParcel.check(typed, userId: me, now: now(), id: newID) else {
                error = ManualParcelText.notSignedIn
                return
            }
            sendCount += 1
            switch await save(row) {
            case .success:
                isSaved = true
                await reload()
            case let .notUpdated(reason):
                if reason == .conflict {
                    // The parcel exists but a mail joined it since the lost answer: nothing was written.
                    error = ManualParcelText.changed
                    await reload()
                } else {
                    error = ManualParcelText.failed
                }
            case .unknown:
                // Read again to see; pressing again sends the same id, so it cannot make a second parcel.
                error = ManualParcelText.unknown
                await reload()
            }
        }
    }

    private func saveEdit(_ parcel: ParcelRow, _ typed: ManualParcelInput) async {
        guard await userID() != nil else {
            error = ManualParcelText.notSignedIn
            return
        }
        sendCount += 1
        // The version the form was opened with, not one read now: a mail's update in between must not be written over.
        switch await update(parcel.id, typed, parcel.updatedAt) {
        case .saved:
            isSaved = true
            await reload()
        case let .invalid(message):
            error = message
        case .notFound:
            error = ManualParcelText.notFound
        case .changed:
            error = ManualParcelText.changed
            await reload()
        case .failed:
            error = ManualParcelText.failed
        case .unknown:
            error = ManualParcelText.unknown
            await reload()
        }
    }

    /// 消す (an edit only): needs 「本当に消す」 checked.
    func deleteParcel() async {
        guard let parcel = editing, !isBusy, !isSaved, !isDeleted else { return }
        isDeleting = true
        deleteError = nil
        defer { isDeleting = false }
        // The check box is local, so it is told first whoever is signed in (as the form is checked before the sign-in).
        guard deleteConfirmed else {
            deleteError = ManualParcelText.deleteUnchecked
            return
        }
        guard await userID() != nil else {
            deleteError = ManualParcelText.notSignedIn
            return
        }
        deleteCount += 1
        // Whatever came back, a parcel that is still there needs 「本当に消す」 checked again for the next press.
        defer { if !isDeleted { deleteConfirmed = false } }
        switch await delete(parcel.id) {
        case .success:
            isDeleted = true
        case let .notUpdated(reason):
            switch reason {
            case .failed:
                deleteError = ManualParcelText.deleteFailed
            case .invalidInput:
                deleteError = ManualParcelText.notFound
            case .conflict:
                // 0 rows: the parcel is gone (after a lost answer, the first send went through) or the row was
                // changed under us. The parcel tells which; the detail and the list are read again when it is there.
                switch await stillThere() {
                case false?:
                    isDeleted = true
                case true?:
                    deleteError = ManualParcelText.notFound
                    await reload()
                case nil:
                    deleteUnconfirmed = true
                    deleteError = ManualParcelText.deleteUnknown
                }
            }
        case .unknown:
            // Not sent again: the parcel tells whether it went through.
            switch await stillThere() {
            case false?:
                isDeleted = true
            case true?:
                deleteError = ManualParcelText.deleteFailed
            case nil:
                deleteUnconfirmed = true
                deleteError = ManualParcelText.deleteUnknown
            }
        }
    }
}
