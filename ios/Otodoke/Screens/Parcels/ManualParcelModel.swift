// The view model of ManualParcelView (src/app/app/parcels/manual-form.tsx, createManualParcel).
// 登録 checks the form like ManualParcelSchema, sends ONE insert, and:
//  - success: the sheet closes, the list is read again;
//  - the write surely did not happen: 保存できませんでした, the form keeps what was typed;
//  - the result is unknown (the answer was lost): nothing is sent again; the list is read again and the
//    form says it could not be confirmed.
// A second press while one is on its way is ignored (the button shows the spinner, it is not disabled).

import Foundation
import Observation

@MainActor
@Observable
final class ManualParcelModel: Identifiable {
    typealias Save = @Sendable (ManualParcelRow) async -> WriteOutcome<String>
    typealias UserID = @Sendable () async -> String?

    var input: ManualParcelInput
    private(set) var error: String?
    private(set) var isSending = false
    /// The parcel was saved: the sheet closes.
    private(set) var isSaved = false
    /// How many insert calls were made (a second press while sending adds none).
    private(set) var sendCount = 0

    @ObservationIgnored private let save: Save
    @ObservationIgnored private let userID: UserID
    @ObservationIgnored private let reload: @MainActor () async -> Void
    @ObservationIgnored private let now: @Sendable () -> Date

    init(
        today: String,
        save: @escaping Save,
        userID: @escaping UserID,
        reload: @escaping @MainActor () async -> Void,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        input = .defaults(today: today)
        self.save = save
        self.userID = userID
        self.reload = reload
        self.now = now
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

    /// 登録.
    func submit() async {
        guard !isSending, !isSaved else { return }
        // Set before anything is awaited, so a second press in the gap is ignored too.
        isSending = true
        error = nil
        let typed = input
        // The form is checked first, so a wrong form is told its fault whoever is signed in (the Web asks
        // for the sign-in first); then the row is made for the signed-in user.
        switch ManualParcel.check(typed, userId: "", now: now()) {
        case let .invalid(message):
            error = message
            isSending = false
        case .valid:
            guard let me = await userID(), case let .valid(row) = ManualParcel.check(typed, userId: me, now: now()) else {
                error = ManualParcelText.notSignedIn
                isSending = false
                return
            }
            sendCount += 1
            let outcome = await save(row)
            switch outcome {
            case .success:
                isSaved = true
                isSending = false
                await reload()
            case .notUpdated:
                error = ManualParcelText.failed
                isSending = false
            case .unknown:
                // Never sent again: read the list to see whether it was made.
                error = ManualParcelText.unknown
                isSending = false
                await reload()
            }
        }
    }
}
