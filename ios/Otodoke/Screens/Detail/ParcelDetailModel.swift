// TDD-STUB(task 8): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// The view model of ParcelDetailView (src/app/app/parcels/[id]/page.tsx).

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
        ParcelDetailFields(
            shop: "", title: "", statusLabel: "", presenceBadge: nil, needsReview: false, expected: nil,
            expectedOriginal: nil, presence: "", presenceEvidence: nil, ordered: nil, orderNumber: nil, amount: ""
        )
    }
}

@MainActor
@Observable
final class ParcelDetailModel {
    let id: String
    let reader: ParcelReader
    let writer: ParcelWriter

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

    init(id: String, reader: ParcelReader, writer: ParcelWriter, today: @escaping @Sendable () -> String) {
        self.id = id
        self.reader = reader
        self.writer = writer
    }

    func load() async {}

    var fields: ParcelDetailFields? { nil }
    var tracking: TrackingAction? { nil }
    var amazonURL: URL? { nil }
    /// Only for a delivered parcel.
    var showsNotDelivered: Bool { false }
    /// Only for a parcel typed in by hand (source = manual): the Web's edit page.
    var editURL: URL? { nil }

    func markNotDelivered() async {}

    func setCategory(_ category: ParcelCategory) async {}

    /// trackingLinkFor(number, carrier) ?? (stored URL if isHttpsUrl) — only when there is a tracking number.
    static func trackingAction(for p: ParcelRow) -> TrackingAction? { nil }

    /// Amazon's order tracking page, only for shop_key = amazon with a valid order number.
    static func amazonURL(for p: ParcelRow) -> URL? { nil }

    /// Mails with their e-mail, sorted by sent_at (text order, nil as "").
    static func timeline(_ extractions: [ExtractionWithEmail], today: String) -> [TimelineEntry] { [] }
}
