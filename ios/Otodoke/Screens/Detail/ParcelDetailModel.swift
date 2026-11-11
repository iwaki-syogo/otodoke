// The view model of ParcelDetailView (src/app/app/parcels/[id]/page.tsx, not-delivered-button.tsx and
// category-sheet.tsx). The three reads fail on their own. A write either succeeded, surely did not happen,
// or its result is unknown (Codex-P3): an unknown result is never sent again; the parcel is read again
// instead, and when that read fails too the screen says 「確かめられませんでした」 without deciding.

import Foundation
import Observation
import SwiftUI

/// How the tracking row opens the carrier's page. Every URL here is https.
enum TrackingAction: Equatable, Sendable {
    case open(URL)
    /// Submit this form (in an in-app WKWebView), as the Web's <form method="post">.
    case post(URL, fields: [String: String])
    /// Sagawa: copy `number`, open the page, paste (the three-step sheet).
    case copyThenOpen(URL, number: String, shown: String, pageName: String, carrierName: String)
}

/// One mail in 「メールの履歴」.
struct TimelineEntry: Equatable, Sendable, Identifiable {
    let id: String
    /// RELEVANCE_LABEL[classification] ?? classification ?? "メール"
    let label: String
    /// formatDateTimeJa(sent_at)
    let dateText: String
    let subject: String?
    /// "name <address>" or the address.
    let fromText: String?
    /// "確信度 87%", nil without a confidence.
    let confidenceText: String?
    /// text_body trimmed if not empty, else htmlToText(html_body), else "".
    let body: String
    let notes: String?
    /// MailBody.display(email) of this mail: what the row shows, by body_state. The fields above are the
    /// plain mail's (a sealed or dropped mail has them null); the screen goes by this.
    var mail: MailDisplay? = nil
    /// emails.id of this mail (the sealed mail's AAD and its body_envelope read).
    var emailID: String? = nil
    /// The delivery extraction's own evidence, selected before display.
    var deliveryEvidence: String? = nil
    var evidenceAt: String = ""
}

/// A sealed mail in 「メールの履歴」, by what opening it came to.
enum SealedState: Equatable, Sendable {
    /// 「🔒 暗号化されたメール」, not opened yet.
    case closed
    /// The key is needed: UnlockView (Face ID or the passphrase).
    case unlocking
    /// 「開いています…」
    case opening
    case opened(OpenedMail)
    /// 「開けませんでした」: the envelope could not be read, was null, or was not an envelope (or did not open).
    case failed
    /// UnlockModel.oldKeyText.
    case oldKey
    /// 「読み込めませんでした」: the key row could not be read again.
    case readFailed
}

/// The fields of the detail card, as the Web words them.
struct ParcelDetailFields: Equatable, Sendable {
    let shop: String
    /// title ?? "品名の記載なし"
    let title: String
    let statusLabel: String
    /// BadgeText.presence(for: parcel, compact: false)
    let presenceBadge: String?
    let needsReview: Bool
    /// "11/5(木)〜11/7(土) 午前中"; nil when there is no date (shown as 未定).
    let expected: String?
    /// expected_text as stored (shown as 原文).
    let expectedOriginal: String?
    /// 対面受け取りが必要 / 念のため対面 / 置き配・投函でOK / メールに記載なし
    let presence: String
    let presenceEvidence: String?
    /// formatDateJa(ordered_at, withYear: true); nil when unknown (shown as 不明).
    let ordered: String?
    let orderNumber: String?
    /// yen(total_amount)
    let amount: String
    /// When faceToFaceAssumed, the line where the evidence would be: 「指定なし」 (source = manual) or
    /// 「メールに記載なし」; nil otherwise. The evidence (presenceEvidence) is nil then.
    var presenceAssumedNote: String? = nil

    static func make(_ p: ParcelRow, today: String) -> ParcelDetailFields {
        let face = ParcelRules.faceToFace(p)
        let assumed = ParcelRules.faceToFaceAssumed(p)
        let expected: String? = {
            guard let start = p.expectedDate.jsTruthy else { return nil }
            var text = Format.formatDateJa(start, today: today)
            if let end = p.expectedDateEnd.jsTruthy { text += "〜" + Format.formatDateJa(end, today: today) }
            let window = Format.formatWindow(start: p.expectedWindowStart, end: p.expectedWindowEnd)
            if !window.isEmpty { text += " " + window }
            return text
        }()
        let presence: String
        switch face {
        case true?: presence = assumed ? BadgeText.assumedFaceToFace : "対面受け取りが必要"
        case false?: presence = "置き配・投函でOK"
        case nil: presence = "メールに記載なし"
        }
        return ParcelDetailFields(
            shop: p.shop,
            title: p.title ?? "品名の記載なし",
            statusLabel: BadgeText.status(p.status, receivedAt: p.receivedAt),
            presenceBadge: BadgeText.presence(for: p, compact: false),
            needsReview: p.needsReview,
            expected: expected,
            expectedOriginal: p.expectedText.jsTruthy,
            presence: presence,
            // The default rests on nothing being said, so that fact stands where evidence would.
            presenceEvidence: assumed ? nil : p.presenceEvidence.jsTruthy,
            ordered: p.orderedAt.jsTruthy.map { Format.formatDateJa($0, withYear: true, today: today) },
            orderNumber: p.orderNumber.jsTruthy,
            amount: Format.yen(p.totalAmount),
            presenceAssumedNote: assumed ? (p.source == "manual" ? "指定なし" : "メールに記載なし") : nil
        )
    }
}

@MainActor
@Observable
final class ParcelDetailModel {
    /// The words of the Web's buttons and of Codex-P3's unknown result.
    static let notDeliveredFailed = "更新できませんでした。開き直してください"
    static let categoryFailed = "保存できませんでした"
    static let categoryNotFound = "見つかりません"
    static let categoryNotAllowed = "選べない分類です"
    static let unconfirmed = "確かめられませんでした"
    /// A tap after 「確かめられませんでした」 read the parcel, and the last write had not gone through.
    static let notDeliveredNotSaved = "保存されていませんでした。もう一度押してください。"
    static let categoryNotSaved = "保存されていませんでした。もう一度選んでください。"

    @ObservationIgnored private var retired = false

    let id: String
    let reader: ParcelReader
    let writer: ParcelWriter
    @ObservationIgnored private let today: @Sendable () -> String

    /// nil until the first load finishes. The three reads fail on their own.
    private(set) var parcel: LoadResult<ParcelRow?>?
    private(set) var items: LoadResult<[ParcelItemRow]>?
    private(set) var timeline: LoadResult<[TimelineEntry]>?

    private(set) var isMarkingNotDelivered = false
    private(set) var notDeliveredError: String?
    private(set) var isChangingReceipt = false
    private(set) var receiptError: String?

    /// The category the chip shows (nil = 未分類), including while a choice is being saved.
    private(set) var shownCategory: ParcelCategory?
    private(set) var isSavingCategory = false
    private(set) var categoryError: String?

    /// The last write's result is unknown and no read of the parcel has settled it (Codex-P3).
    /// Nothing is written (「届いていない」, the category) until a read does: a tap only reads again.
    private(set) var isUnconfirmed = false

    /// What became of a read of the parcel.
    private enum ReadOutcome: Equatable {
        case applied
        case failed
        /// A newer read of the parcel was started: its answer is the one shown.
        case superseded
        /// A write started or finished while it was read: not shown; read again (now, or once the
        /// writes in flight are done).
        case stale
    }

    /// Each read of the parcel gets a number (only the newest is shown); so does each read of the
    /// items and mails.
    @ObservationIgnored private var parcelReadNumber = 0
    @ObservationIgnored private var restReadNumber = 0
    /// Bumped when a write is sent and when it is answered: a read of the parcel that saw it change
    /// is not shown.
    @ObservationIgnored private var writeGeneration = 0
    @ObservationIgnored private var writesInFlight = 0
    @ObservationIgnored private var readAfterWrites = false

    init(id: String, reader: ParcelReader, writer: ParcelWriter, today: @escaping @Sendable () -> String) {
        self.id = id
        self.reader = reader
        self.writer = writer
        self.today = today
    }

    /// Opening sealed mail. Set by MainScreens.detail(_:) (the one UnlockModel of the session and its
    /// reader of body_envelope).
    @ObservationIgnored var unlock: UnlockModel?
    @ObservationIgnored var mailKeys: (any MailKeyReading)?

    /// scenePhase inactive (or background) hides every opened body; active shows it again.
    private(set) var isBodyHidden = false

    /// Each sealed mail that was pressed, with the key's period and session it was pressed in. Only in
    /// memory; dropped in the background and at sign-out (OpenKeyStore → dropPlaintext).
    private var sealed: [String: (state: SealedState, stamp: UnlockStamp)] = [:]

    /// What a sealed mail of this detail shows now (closed when never opened, and again once the key's
    /// front period or the session moved on).
    func sealedState(emailID: String) -> SealedState {
        guard let entry = sealed[emailID], let store = unlock?.store, store.isCurrent(entry.stamp) else { return .closed }
        return entry.state
    }

    /// Whether a press of 「元メールを見る」 starts opening this sealed mail: never opened (closed), or the last
    /// try failed on a read (.failed: the envelope; .readFailed: the key row), so a lost read is tried again
    /// once the network is back (B1-2). Not while it is opening (no second start), once opened, while the key
    /// is asked for (UnlockView opens it), nor for an older passphrase's mail.
    func startsOpening(emailID: String) -> Bool {
        switch sealedState(emailID: emailID) {
        case .closed, .failed, .readFailed: return true
        case .unlocking, .opening, .opened, .oldKey: return false
        }
    }

    /// 「元メールを見る」 from the screen: openSealed in a task the key's store cancels in the background.
    func startOpeningSealed(emailID: String) {
        guard let store = unlock?.store else { return }
        let task = Task { [weak self] () -> Void in
            guard let self else { return }
            await self.openSealed(emailID: emailID)
        }
        store.track(task)
    }

    /// 「元メールを見る」 on a sealed mail: the key (memory, Face ID, else .unlocking), then body_envelope read
    /// and opened; the kid differing goes through UnlockModel.recipient(forKid:).
    func openSealed(emailID: String) async {
        guard !retired, let unlock, let mailKeys, let stamp = unlock.store.stamp() else { return }
        unlock.store.hold(self)
        // [B1-2] Opened, or being opened in this period of the key: nothing more is started.
        switch sealedState(emailID: emailID) {
        case .opened, .opening: return
        default: break
        }
        setSealed(emailID, .opening, stamp)
        guard let key = await unlock.key() else {
            setSealed(emailID, .unlocking, stamp)
            return
        }
        // Read only now, and only this mail's envelope.
        let read = await mailKeys.envelope(emailID: emailID)
        guard unlock.store.isCurrent(stamp) else { return }
        guard case let .loaded(data?) = read, let kid = Envelope.kidOf(jsonData: data) else {
            setSealed(emailID, .failed, stamp)
            return
        }
        var recipient = key
        if kid != key.keyID {
            switch await unlock.recipient(forKid: kid) {
            case let .key(other): recipient = other
            case .needsPassphrase:
                setSealed(emailID, .unlocking, stamp)
                return
            case .readFailed:
                setSealed(emailID, .readFailed, stamp)
                return
            case .oldKey:
                setSealed(emailID, .oldKey, stamp)
                return
            }
            guard unlock.store.isCurrent(stamp) else { return }
        }
        let opened = await Self.open(recipient, emailID: emailID, envelopeJSON: data)
        // The background, a sign-out or another account meanwhile: nothing is shown or kept (CX2).
        guard unlock.store.isCurrent(stamp) else { return }
        switch opened {
        case let .success(mail): setSealed(emailID, .opened(mail), stamp)
        case .failure(.wrongKey): setSealed(emailID, .oldKey, stamp)
        case .failure: setSealed(emailID, .failed, stamp)
        }
    }

    /// openMail and the text to show, off the main thread (htmlToText may be long).
    nonisolated private static func open(_ key: OpenedKey, emailID: String, envelopeJSON: Data) async -> Result<OpenedMail, CryptoError> {
        await Task.detached(priority: .userInitiated) { () -> Result<OpenedMail, CryptoError> in
            do throws(CryptoError) {
                let mail = try EnvelopeCrypto.openMail(key.recipient, userID: key.userID, emailID: emailID, envelopeJSON: envelopeJSON)
                return .success(MailBody.opened(mail))
            } catch {
                return .failure(error)
            }
        }.value
    }

    private func setSealed(_ emailID: String, _ state: SealedState, _ stamp: UnlockStamp) {
        guard !retired, unlock?.store.isCurrent(stamp) == true else { return }
        sealed[emailID] = (state, stamp)
    }

    /// The passphrase typed in UnlockView for this mail; opens it when the key opened.
    func submitPassphrase(_ passphrase: String, emailID: String) async {
        guard let unlock else { return }
        guard await unlock.submit(password: passphrase) else { return }
        await openSealed(emailID: emailID)
    }

    /// scenePhase changed (inactive / background hide the bodies; active shows them).
    func sceneChanged(_ phase: ScenePhase) {
        isBodyHidden = phase != .active
    }

    /// How many opened mails are held in memory (for the tests of dropping them).
    var heldPlaintextCount: Int {
        sealed.values.filter { if case .opened = $0.state { return true } else { return false } }.count
    }

    /// 「古くなった」 from the other tabs (CX1). Set by MainTabView; `onAppear()` reads again when it
    /// moved since this screen's last read.
    @ObservationIgnored var changes: DataChanges? {
        didSet { mark = ChangeMark(changes) }
    }
    @ObservationIgnored private var mark = ChangeMark(nil)

    /// Shown: reads the first time, and again when DataChanges moved since the last read (and does
    /// nothing otherwise).
    func onAppear() async {
        if parcel == nil || mark.isStale { await load() }
    }

    /// The three reads at once (parcel, items, mails), each kept apart. The mails' text is made off the
    /// main thread. A parcel read that a write overlapped is not shown but read again.
    func load() async {
        guard !retired else { return }
        mark.markRead()
        parcelReadNumber += 1
        restReadNumber += 1
        let parcelNumber = parcelReadNumber
        let restNumber = restReadNumber
        let generation = writeGeneration
        let day = today()
        async let parcelRead = reader.parcel(id: id)
        async let itemsRead = reader.items(parcelID: id)
        async let mailsRead = reader.extractions(parcelID: id)
        let (p, i, x) = await (parcelRead, itemsRead, mailsRead)
        let t = await Self.makeTimeline(x, today: day)
        guard !retired else { return }
        if restNumber == restReadNumber {
            items = i
            timeline = t
        }
        if finishParcelRead(number: parcelNumber, generation: generation, p, keepShownOnFailure: false) == .stale {
            if writesInFlight > 0 {
                readAfterWrites = true
            } else {
                _ = await rereadParcel()
            }
        }
    }

    /// The parcel as loaded, when there is one.
    var row: ParcelRow? {
        if case let .loaded(p?)? = parcel { return p }
        return nil
    }

    /// The category stored on the parcel (the sheet's ✓), nil for 未分類 or an unknown value.
    var storedCategory: ParcelCategory? {
        Self.category(of: row)
    }

    var fields: ParcelDetailFields? {
        row.map { ParcelDetailFields.make($0, today: today()) }
    }

    var tracking: TrackingAction? {
        row.flatMap(Self.trackingAction(for:))
    }

    var amazonURL: URL? {
        row.flatMap(Self.amazonURL(for:))
    }

    /// Delivery and receipt are separate; a receipt can be cleared without changing delivery.
    var showsNotDelivered: Bool {
        guard let row else { return false }
        return row.status == "delivered" && !ParcelRules.isReceived(row)
    }

    var showsMarkReceived: Bool {
        guard let row else { return false }
        return row.status != "cancelled" && !ParcelRules.isReceived(row)
    }

    var showsNotReceived: Bool { row.map(ParcelRules.isReceived) == true }

    /// Same latest-line choice as deliveryEvidence on the Web. A mail without evidence adds no row.
    var deliveryEvidence: String? {
        guard case let .loaded(entries)? = timeline else { return nil }
        var best: TimelineEntry?
        for entry in entries where entry.deliveryEvidence != nil {
            if best == nil || !JSText.less(entry.evidenceAt, best!.evidenceAt) { best = entry }
        }
        return best?.deliveryEvidence
    }

    /// Only for a parcel typed in by hand (source = manual): 編集 opens the form inside the app.
    var canEdit: Bool {
        row?.source == "manual"
    }

    #if DEBUG
    /// DEBUG only: the edit form of the screen checks, which answers without a server.
    @ObservationIgnored var debugEditForm: ((ParcelRow) -> ManualParcelModel)?
    #endif

    /// The edit form for this parcel; saving reads the parcel again.
    func makeEditForm() -> ManualParcelModel? {
        guard let row, row.source == "manual" else { return nil }
        #if DEBUG
        if let debugEditForm { return debugEditForm(row) }
        #endif
        return .live(editing: row, writer: writer, reader: reader, reload: { [weak self] in await self?.load() })
    }

    /// 「届いていない」: the spinner from the tap; on success everything is read again. While the last
    /// write is not known, a tap only reads the parcel again.
    func markNotDelivered() async {
        guard !retired, !isMarkingNotDelivered, !isChangingReceipt, showsNotDelivered else { return }
        isMarkingNotDelivered = true
        notDeliveredError = nil
        defer { isMarkingNotDelivered = false }

        if isUnconfirmed {
            switch await rereadParcel() {
            case .applied:
                // Still delivered: the lost 「届いていない」 had not gone through. Otherwise the page now
                // shows what it is.
                if row?.status == "delivered" { notDeliveredError = Self.notDeliveredNotSaved }
            default:
                if isUnconfirmed { notDeliveredError = Self.unconfirmed }
            }
            return
        }

        beginWrite()
        let result = await writer.markNotDelivered(id: id)
        endWrite()
        guard !retired else { return }
        switch result {
        case .success:
            await load()
        case .notUpdated:
            notDeliveredError = Self.notDeliveredFailed
        case .unknown:
            // Not sent again: the row tells whether it went through.
            isUnconfirmed = true
            if await rereadParcel() == .applied {
                if row?.status == "delivered" { notDeliveredError = Self.notDeliveredFailed }
            } else if isUnconfirmed {
                notDeliveredError = Self.unconfirmed
            }
        }
    }

    /// 「受け取った」 writes delivery and receipt together, on the version shown.
    func markReceived() async { await changeReceipt(received: true) }

    /// 「受け取っていない」 leaves the delivery status intact.
    func markNotReceived() async { await changeReceipt(received: false) }

    private func changeReceipt(received: Bool) async {
        guard !retired, !isChangingReceipt, !isMarkingNotDelivered, let before = row,
              received ? showsMarkReceived : showsNotReceived else { return }
        isChangingReceipt = true
        receiptError = nil
        defer { isChangingReceipt = false }
        if isUnconfirmed {
            if await rereadParcel() == .applied {
                if row.map(ParcelRules.isReceived) == received { return }
                receiptError = Self.notDeliveredNotSaved
            } else if isUnconfirmed {
                receiptError = Self.unconfirmed
            }
            return
        }
        beginWrite()
        let result: WriteOutcome<ParcelVersion>
        if received {
            switch await writer.markDelivered(ParcelVersion(before)) {
            case let .success(token):
                result = .success(ParcelVersion(id: token.id, status: "delivered", updatedAt: token.deliveredUpdatedAt,
                                               receivedAt: token.deliveredReceivedAt, checkDismissedAt: before.checkDismissedAt))
            case let .notUpdated(reason): result = .notUpdated(reason)
            case .unknown: result = .unknown
            }
        } else {
            result = await writer.markNotReceived(id: id)
        }
        endWrite()
        guard !retired else { return }
        switch result {
        case let .success(version):
            var updated = row ?? before
            updated.status = version.status
            updated.receivedAt = version.receivedAt
            updated.checkDismissedAt = version.checkDismissedAt
            updated.updatedAt = version.updatedAt
            parcel = .loaded(updated)
            _ = await rereadParcel()
        case .notUpdated(.conflict):
            _ = await rereadParcel()
            guard !retired else { return }
            receiptError = Self.notDeliveredFailed
        case .notUpdated:
            receiptError = Self.notDeliveredFailed
        case .unknown:
            isUnconfirmed = true
            if await rereadParcel() == .applied {
                if row.map(ParcelRules.isReceived) != received {
                    receiptError = Self.notDeliveredFailed
                }
            } else if isUnconfirmed {
                receiptError = Self.unconfirmed
            }
        }
    }

    /// The chip shows the choice from the tap; a choice that surely was not saved goes back, with the
    /// Web's words. On success the parcel takes the written values (no read needed). While the last
    /// write is not known, a choice only reads the parcel again. true when the choice was saved.
    /// The choice is written only on the version shown (CF1): when the parcel changed meanwhile (or a
    /// lost choice went through late), nothing is written and the parcel is read again.
    @discardableResult
    func setCategory(_ category: ParcelCategory) async -> Bool {
        guard !retired, !isSavingCategory, let before = row else { return false }
        let previous = Self.category(of: before)

        if isUnconfirmed {
            isSavingCategory = true
            categoryError = nil
            defer { isSavingCategory = false }
            let outcome = await rereadParcel()
            guard !retired else { return false }
            if outcome != .applied, isUnconfirmed { categoryError = Self.unconfirmed }
            shownCategory = Self.category(of: row)
            if outcome == .applied {
                guard let p = row else {
                    categoryError = Self.categoryNotFound
                    return false
                }
                // This press only reads. A matching automatic category is not a saved user choice.
                if shownCategory != category || p.categorySource != "user" {
                    categoryError = Self.categoryNotSaved
                }
            }
            return false
        }

        shownCategory = category
        isSavingCategory = true
        categoryError = nil
        defer { isSavingCategory = false }

        beginWrite()
        let result = await writer.setCategory(ParcelVersion(before), category: category)
        endWrite()
        guard !retired else { return false }
        switch result {
        case let .success(written):
            var p = row ?? before
            p.category = category.rawValue
            p.categorySource = "user"
            p.status = written.status
            p.updatedAt = written.updatedAt
            parcel = .loaded(p)
            return true
        case .notUpdated(.conflict):
            // Changed since it was shown, or gone: show what is there now.
            let outcome = await rereadParcel()
            guard !retired else { return false }
            if outcome == .applied {
                guard let p = row else {
                    shownCategory = previous
                    categoryError = Self.categoryNotFound
                    return false
                }
                shownCategory = Self.category(of: p)
                // The same category set by the mail import (not "user") is not the choice: a later
                // mail may change it, so it is not taken as saved (NtH-C).
                let saved = shownCategory == category && p.categorySource == "user"
                if !saved { categoryError = Self.categoryNotSaved }
                return saved
            }
            shownCategory = Self.category(of: row) ?? previous
            categoryError = Self.categoryFailed
            return false
        case let .notUpdated(reason):
            shownCategory = previous
            categoryError = reason == .invalidInput ? Self.categoryNotAllowed : Self.categoryFailed
            return false
        case .unknown:
            isUnconfirmed = true
            let outcome = await rereadParcel()
            guard !retired else { return false }
            if outcome == .applied {
                guard let p = row else {
                    shownCategory = previous
                    categoryError = Self.categoryNotFound
                    return false
                }
                shownCategory = Self.category(of: p)
                let saved = shownCategory == category && p.categorySource == "user"
                if !saved { categoryError = shownCategory == category ? Self.categoryNotSaved : Self.categoryFailed }
                return saved
            }
            // Neither saved nor not saved is known: the chip keeps the last value read.
            shownCategory = Self.category(of: row) ?? previous
            if isUnconfirmed { categoryError = Self.unconfirmed }
            return false
        }
    }

    // MARK: reading the parcel again

    /// Reads the parcel again and shows it unless a newer read or a write overlapped it (then reads
    /// again, at most twice here). A failed read keeps the parcel shown.
    private func rereadParcel() async -> ReadOutcome {
        var retries = 0
        while true {
            parcelReadNumber += 1
            let number = parcelReadNumber
            let generation = writeGeneration
            let result = await reader.parcel(id: id)
            let outcome = finishParcelRead(number: number, generation: generation, result, keepShownOnFailure: true)
            guard outcome == .stale else { return outcome }
            if writesInFlight > 0 {
                readAfterWrites = true
                return .stale
            }
            retries += 1
            guard retries <= 2 else {
                readAfterWrites = true
                return .stale
            }
        }
    }

    /// Shows a parcel read when it is the newest and no write overlapped it. A read that is shown
    /// settles an unknown write.
    private func finishParcelRead(number: Int, generation: Int, _ result: LoadResult<ParcelRow?>, keepShownOnFailure: Bool) -> ReadOutcome {
        guard !retired, number == parcelReadNumber else { return .superseded }
        guard generation == writeGeneration, writesInFlight == 0 else { return .stale }
        guard case .loaded = result else {
            if !keepShownOnFailure { show(result) }
            return .failed
        }
        show(result)
        if isUnconfirmed {
            isUnconfirmed = false
            if notDeliveredError == Self.unconfirmed { notDeliveredError = nil }
            if categoryError == Self.unconfirmed { categoryError = nil }
            if receiptError == Self.unconfirmed { receiptError = nil }
        }
        return .applied
    }

    private func beginWrite() {
        writesInFlight += 1
        writeGeneration &+= 1
    }

    private func endWrite() {
        writesInFlight -= 1
        writeGeneration &+= 1
        if !retired, writesInFlight == 0, readAfterWrites {
            readAfterWrites = false
            Task { [weak self] in _ = await self?.rereadParcel() }
        }
    }

    /// The mail history, made off the main thread (a long or broken HTML body never holds the screen).
    nonisolated private static func makeTimeline(_ read: LoadResult<[ExtractionWithEmail]>, today: String) async -> LoadResult<[TimelineEntry]> {
        guard case let .loaded(rows) = read else { return .failed }
        let entries = await Task.detached(priority: .userInitiated) {
            ParcelDetailModel.timeline(rows, today: today)
        }.value
        return .loaded(entries)
    }

    /// trackingLinkFor(number, carrier) ?? (stored URL if isHttpsUrl) — only when there is a tracking number.
    static func trackingAction(for p: ParcelRow) -> TrackingAction? {
        guard let number = p.trackingNumber.jsTruthy else { return nil }
        if let link = Carriers.trackingLinkFor(number, hint: p.carrier) {
            switch link {
            case let .open(url):
                return httpsURL(url).map { .open($0) }
            case let .post(url, fields):
                return httpsURL(url).map { .post($0, fields: fields) }
            case let .copy(url, pageName):
                return httpsURL(url).map {
                    .copyThenOpen(
                        $0, number: Carriers.normalizeTracking(number), shown: number, pageName: pageName,
                        carrierName: Carriers.identifyCarrier(number, hint: p.carrier).name
                    )
                }
            }
        }
        // A stored URL is linked only when it is https: (never javascript: or data:).
        return httpsURL(p.trackingUrl).map { .open($0) }
    }

    /// Amazon's order tracking page, only for shop_key = amazon with a valid order number.
    static func amazonURL(for p: ParcelRow) -> URL? {
        guard p.shopKey == "amazon" else { return nil }
        return httpsURL(Carriers.amazonOrderTrackingUrl(p.orderNumber))
    }

    /// Mails with their e-mail, sorted by sent_at (text order, nil as "").
    nonisolated static func timeline(_ extractions: [ExtractionWithEmail], today: String) -> [TimelineEntry] {
        let withMail = extractions.enumerated().compactMap { offset, x in x.email.map { (offset, x, $0) } }
        // Stable, as Array.prototype.sort.
        let sorted = withMail.sorted { a, b in
            let l = a.2.sentAt ?? "", r = b.2.sentAt ?? ""
            if JSText.equal(l, r) { return a.0 < b.0 }
            return JSText.less(l, r)
        }
        return sorted.map { _, x, email in
            let classification = email.classification
            let label = Format.relevanceLabel[classification ?? ""] ?? classification ?? "メール"
            let from: String? = {
                if let name = email.fromName.jsTruthy { return "\(name) <\(email.fromAddress ?? "")>" }
                return email.fromAddress
            }()
            let confidence: String? = x.confidence.flatMap { c in
                guard c.isFinite else { return nil }
                // Math.round: halves go up.
                return "確信度 \(Int((c * 100 + 0.5).rounded(.down)))%"
            }
            let body = MailBody.plainBody(email)
            return TimelineEntry(
                id: x.id,
                label: label,
                dateText: Format.formatDateTimeJa(email.sentAt, today: today),
                subject: email.subject,
                fromText: from,
                confidenceText: confidence,
                body: body,
                notes: x.notes.jsTruthy,
                mail: MailBody.display(email),
                emailID: email.id,
                deliveryEvidence: x.relevance == "delivered" ? (x.relevanceEvidence?.trimmingCharacters(in: .whitespacesAndNewlines)).jsTruthy : nil,
                evidenceAt: email.sentAt ?? x.createdAt
            )
        }
    }

    /// Drops the account's detail and bodies, and rejects results of work started by the old session.
    func clearForSignOut() {
        retired = true
        parcelReadNumber &+= 1
        restReadNumber &+= 1
        writeGeneration &+= 1
        readAfterWrites = false
        parcel = nil
        items = nil
        timeline = nil
        shownCategory = nil
        categoryError = nil
        notDeliveredError = nil
        receiptError = nil
        isUnconfirmed = false
        isMarkingNotDelivered = false
        isChangingReceipt = false
        isSavingCategory = false
        dropPlaintext()
    }

    // MARK: helpers

    /// A new parcel read: the chip follows it unless a choice is being saved.
    private func show(_ result: LoadResult<ParcelRow?>) {
        parcel = result
        if !isSavingCategory, case let .loaded(p) = result {
            shownCategory = Self.category(of: p)
        }
    }

    private static func category(of p: ParcelRow?) -> ParcelCategory? {
        guard let raw = p?.category, ParcelCategory.isCategory(raw) else { return nil }
        return ParcelCategory(rawValue: raw)
    }

    /// The URL of an https link with a host; nil for anything else.
    private static func httpsURL(_ text: String?) -> URL? {
        guard let text, SafeURL.isHttpsUrl(text) else { return nil }
        return URL(string: text, encodingInvalidCharacters: false)
    }
}

private extension Optional where Wrapped == String {
    /// The string when it is not nil and not empty (JavaScript's truthiness for a string).
    var jsTruthy: String? {
        guard let self, !self.isEmpty else { return nil }
        return self
    }
}

#if DEBUG
extension ParcelDetailModel {
    /// DEBUG only: shows a given parcel without reading, for checking the screen on the simulator.
    func debugShow(parcel row: ParcelRow, items: [ParcelItemRow], timeline: [TimelineEntry]) {
        parcel = .loaded(row)
        shownCategory = ParcelCategory(rawValue: row.category ?? "")
        self.items = .loaded(items)
        self.timeline = .loaded(timeline)
    }
}
#endif

/// The detail holds opened mail; OpenKeyStore tells it to drop it (the background, sign-out).
extension ParcelDetailModel: PlaintextHolder {
    func dropPlaintext() {
        sealed = [:]
    }
}
