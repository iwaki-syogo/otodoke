// The view model of ParcelDetailView (src/app/app/parcels/[id]/page.tsx, not-delivered-button.tsx and
// category-sheet.tsx). The three reads fail on their own. A write either succeeded, surely did not happen,
// or its result is unknown (Codex-P3): an unknown result is never sent again; the parcel is read again
// instead, and when that read fails too the screen says 「確かめられませんでした」 without deciding.

import Foundation
import Observation

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
}

/// The fields of the detail card, as the Web words them.
struct ParcelDetailFields: Equatable, Sendable {
    let shop: String
    /// title ?? "品名の記載なし"
    let title: String
    let statusLabel: String
    /// BadgeText.presence(faceToFace, compact: false)
    let presenceBadge: String?
    let needsReview: Bool
    /// "11/5(木)〜11/7(土) 午前中"; nil when there is no date (shown as 未定).
    let expected: String?
    /// expected_text as stored (shown as 原文).
    let expectedOriginal: String?
    /// 対面受け取りが必要 / 置き配・投函でOK / メールに記載なし
    let presence: String
    let presenceEvidence: String?
    /// formatDateJa(ordered_at, withYear: true); nil when unknown (shown as 不明).
    let ordered: String?
    let orderNumber: String?
    /// yen(total_amount)
    let amount: String

    static func make(_ p: ParcelRow, today: String) -> ParcelDetailFields {
        let face = ParcelRules.faceToFace(p)
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
        case true?: presence = "対面受け取りが必要"
        case false?: presence = "置き配・投函でOK"
        case nil: presence = "メールに記載なし"
        }
        return ParcelDetailFields(
            shop: p.shop,
            title: p.title ?? "品名の記載なし",
            statusLabel: BadgeText.status(p.status),
            presenceBadge: BadgeText.presence(face, compact: false),
            needsReview: p.needsReview,
            expected: expected,
            expectedOriginal: p.expectedText.jsTruthy,
            presence: presence,
            presenceEvidence: p.presenceEvidence.jsTruthy,
            ordered: p.orderedAt.jsTruthy.map { Format.formatDateJa($0, withYear: true, today: today) },
            orderNumber: p.orderNumber.jsTruthy,
            amount: Format.yen(p.totalAmount)
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

    /// The three reads at once (parcel, items, mails), each kept apart. The mails' text is made off the
    /// main thread. A parcel read that a write overlapped is not shown but read again.
    func load() async {
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

    /// Only for a delivered parcel.
    var showsNotDelivered: Bool {
        row?.status == "delivered"
    }

    /// Only for a parcel typed in by hand (source = manual): the Web's edit page.
    var editURL: URL? {
        guard let row, row.source == "manual" else { return nil }
        return WebLink.parcelEdit(id: row.id)
    }

    /// 「届いていない」: the spinner from the tap; on success everything is read again. While the last
    /// write is not known, a tap only reads the parcel again.
    func markNotDelivered() async {
        guard !isMarkingNotDelivered, showsNotDelivered else { return }
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

    /// The chip shows the choice from the tap; a choice that surely was not saved goes back, with the
    /// Web's words. On success the parcel takes the written values (no read needed). While the last
    /// write is not known, a choice only reads the parcel again. true when the choice was saved.
    @discardableResult
    func setCategory(_ category: ParcelCategory) async -> Bool {
        guard !isSavingCategory, let before = row else { return false }
        let previous = Self.category(of: before)

        if isUnconfirmed {
            isSavingCategory = true
            categoryError = nil
            defer { isSavingCategory = false }
            let outcome = await rereadParcel()
            if outcome != .applied, isUnconfirmed { categoryError = Self.unconfirmed }
            shownCategory = Self.category(of: row)
            // The category read is the one shown before: the lost choice had not gone through.
            // Otherwise the chip now shows what was saved.
            if outcome == .applied, row != nil, shownCategory == previous, shownCategory != category {
                categoryError = Self.categoryNotSaved
            }
            return false
        }

        shownCategory = category
        isSavingCategory = true
        categoryError = nil
        defer { isSavingCategory = false }

        beginWrite()
        let result = await writer.setCategory(id: id, category: category)
        endWrite()
        switch result {
        case let .success(written):
            var p = row ?? before
            p.category = category.rawValue
            p.categorySource = "user"
            p.status = written.status
            p.updatedAt = written.updatedAt
            parcel = .loaded(p)
            return true
        case let .notUpdated(reason):
            shownCategory = previous
            switch reason {
            case .conflict: categoryError = Self.categoryNotFound
            case .invalidInput: categoryError = Self.categoryNotAllowed
            case .failed: categoryError = Self.categoryFailed
            }
            return false
        case .unknown:
            isUnconfirmed = true
            if await rereadParcel() == .applied {
                guard let p = row else {
                    shownCategory = previous
                    categoryError = Self.categoryNotFound
                    return false
                }
                shownCategory = Self.category(of: p)
                if shownCategory != category { categoryError = Self.categoryFailed }
                return shownCategory == category
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
        guard number == parcelReadNumber else { return .superseded }
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
        if writesInFlight == 0, readAfterWrites {
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
            let text = JSText.trim(email.textBody ?? "")
            let body = !text.isEmpty ? text : (email.htmlBody.jsTruthy.map(HtmlText.htmlToText) ?? "")
            return TimelineEntry(
                id: x.id,
                label: label,
                dateText: Format.formatDateTimeJa(email.sentAt, today: today),
                subject: email.subject,
                fromText: from,
                confidenceText: confidence,
                body: body,
                notes: x.notes.jsTruthy
            )
        }
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
