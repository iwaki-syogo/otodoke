// Port of src/lib/manual-parcel.ts: a parcel typed in by hand. The form's checks (ManualParcelSchema and
// manualParcelSchemaFor for an edit) and the parcels columns it becomes (manualParcelRow for a new one,
// manualParcelFields for an edit). The words of the errors are in ManualParcelText, the same ones as the Web.

import Foundation

/// MANUAL_LIMITS and MANUAL_MAX_AMOUNT.
enum ManualLimits {
    static let title = 300
    static let shop = 100
    static let tracking = 40
    static let maxAmount = 10_000_000
}

/// MANUAL_CARRIERS: "auto" lets the number's shape decide.
enum ManualCarrier: String, CaseIterable, Sendable {
    case auto, yamato, sagawa, japanpost, seino, fukutsu

    /// CARRIERS[key].name (nil for auto).
    var carrierName: String? {
        switch self {
        case .auto: nil
        case .yamato: "ヤマト運輸"
        case .sagawa: "佐川急便"
        case .japanpost: "日本郵便"
        case .seino: "西濃運輸"
        case .fukutsu: "福山通運"
        }
    }
}

/// MANUAL_PRESENCE: face to face, left at the door / in the mailbox, or not said.
enum ManualPresence: String, CaseIterable, Sendable {
    case none = ""
    case face
    case drop

    /// requires_presence: face → true, drop → false, not said → null.
    var requiresPresence: Bool? {
        switch self {
        case .none: nil
        case .face: true
        case .drop: false
        }
    }
}

/// MANUAL_STATUSES: what the form offers for a new parcel.
enum ManualStatus: String, CaseIterable, Sendable {
    case ordered, shipped, delivered
}

/// What the form holds, as strings (the Web's form values).
struct ManualParcelInput: Equatable, Sendable {
    var title = ""
    var shop = ""
    var orderedAt = ""
    var expectedDate = ""
    var totalAmount = ""
    var category = ""
    var trackingNumber = ""
    var carrier = ManualCarrier.auto.rawValue
    var presence = ManualPresence.none.rawValue
    var status = ManualStatus.ordered.rawValue

    /// manualFormDefaults(parcel, today) for a parcel being edited: what is stored.
    init(editing parcel: ParcelRow) {
        title = parcel.title ?? ""
        shop = parcel.shop
        orderedAt = parcel.orderedAt ?? ""
        expectedDate = parcel.expectedDate ?? ""
        totalAmount = parcel.totalAmount.map(String.init) ?? ""
        category = ParcelCategory.isCategory(parcel.category) ? (parcel.category ?? "") : ""
        trackingNumber = parcel.trackingNumber ?? ""
        carrier = ManualParcel.carrierChoice(parcel.carrier, tracking: parcel.trackingNumber)
        presence = switch parcel.requiresPresence {
        case nil: ManualPresence.none.rawValue
        case true?: ManualPresence.face.rawValue
        case false?: ManualPresence.drop.rawValue
        }
        status = ManualParcel.editableStatuses.contains(parcel.status) ? parcel.status : ManualStatus.ordered.rawValue
    }

    init() {}

    /// manualFormDefaults(null, today): a new parcel was ordered today.
    static func defaults(today: String) -> ManualParcelInput {
        var input = ManualParcelInput()
        input.orderedAt = today
        return input
    }
}

/// The parcels columns of a new typed-in parcel, with user_id. Every column is sent, nulls included,
/// as the Web's insert does. No tracking URL is built from typed input, and no parcel_items are written.
struct ManualParcelRow: Encodable, Equatable, Sendable {
    /// The id the form made when it was opened, kept for every send of that form: a send that is made twice
    /// (the first answer was lost) cannot make two parcels, the second is refused as a duplicate (23505).
    var id: String?
    var userId: String
    var title: String
    var shop: String
    var shopKey = "other"
    var orderedAt: String
    var expectedDate: String?
    var totalAmount: Int?
    var category: String?
    var categorySource: String?
    var trackingNumber: String?
    var carrier: String?
    var requiresPresence: Bool?
    var status: String
    var source = "manual"
    var lastEmailAt: String

    private enum Keys: String, CodingKey {
        case id, userId = "user_id", title, shop, shopKey = "shop_key", orderedAt = "ordered_at"
        case expectedDate = "expected_date", expectedDateEnd = "expected_date_end"
        case expectedWindowStart = "expected_window_start", expectedWindowEnd = "expected_window_end"
        case expectedText = "expected_text", totalAmount = "total_amount", category
        case categorySource = "category_source", trackingNumber = "tracking_number", carrier
        case trackingUrl = "tracking_url", requiresPresence = "requires_presence"
        case presenceEvidence = "presence_evidence", status, source, lastEmailAt = "last_email_at"
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        func put<T: Encodable>(_ value: T?, _ key: Keys) throws {
            if let value { try c.encode(value, forKey: key) } else { try c.encodeNil(forKey: key) }
        }
        if let id { try c.encode(id, forKey: .id) }
        try c.encode(userId, forKey: .userId)
        try c.encode(title, forKey: .title)
        try c.encode(shop, forKey: .shop)
        try c.encode(shopKey, forKey: .shopKey)
        try c.encode(orderedAt, forKey: .orderedAt)
        try put(expectedDate, .expectedDate)
        try put(nil as String?, .expectedDateEnd)
        try put(nil as String?, .expectedWindowStart)
        try put(nil as String?, .expectedWindowEnd)
        try put(nil as String?, .expectedText)
        try put(totalAmount, .totalAmount)
        try put(category, .category)
        try put(categorySource, .categorySource)
        try put(trackingNumber, .trackingNumber)
        try put(carrier, .carrier)
        try put(nil as String?, .trackingUrl)
        try put(requiresPresence, .requiresPresence)
        try put(nil as String?, .presenceEvidence)
        try c.encode(status, forKey: .status)
        try c.encode(source, forKey: .source)
        try c.encode(lastEmailAt, forKey: .lastEmailAt)
    }
}

enum ManualParcel {
    enum Result: Equatable, Sendable {
        case valid(ManualParcelRow)
        case invalid(String)
    }

    /// MANUAL_CARRIED_STATUSES: statuses a mail can move a typed-in parcel to. Offered only while the parcel is there.
    static let carriedStatuses = ["out_for_delivery", "attempted"]
    /// MANUAL_CANCELLED: only a parcel already cancelled may be saved with it.
    static let cancelled = "cancelled"
    /// MANUAL_KEEP_CARRIER: keeps a stored carrier name the five do not cover.
    static let keepCarrier = "keep"
    /// The statuses an edit's form can start with: the three, the two a mail sets, and cancelled.
    static let editableStatuses = ManualStatus.allCases.map(\.rawValue) + carriedStatuses + [cancelled]

    /// What the schema read from a form that passed its checks.
    private struct Validated {
        let title: String
        let shop: String
        let ordered: String
        let expected: String
        let amount: Int?
        let category: String
        let tracking: String
        let carrier: String
        let presence: ManualPresence
        let status: String
    }

    private enum Validation {
        case ok(Validated)
        case failed(String)
    }

    /// The first error found, in the schema's field order (title, shop, ordered_at, expected_date,
    /// total_amount, category, tracking_number, carrier, presence, status).
    private static func validate(_ input: ManualParcelInput, storedAmount: Int?, statuses: Set<String>, carriers: Set<String>) -> Validation {
        let title = JSText.trim(input.title)
        if title.isEmpty { return .failed(ManualParcelText.titleEmpty) }
        if title.utf16.count > ManualLimits.title { return .failed(ManualParcelText.titleTooLong) }
        let shop = JSText.trim(input.shop)
        if shop.isEmpty { return .failed(ManualParcelText.shopEmpty) }
        if shop.utf16.count > ManualLimits.shop { return .failed(ManualParcelText.shopTooLong) }
        let ordered = JSText.trim(input.orderedAt)
        if !ordered.isEmpty && !isRealDate(ordered) { return .failed(ManualParcelText.orderedAtInvalid) }
        let expected = JSText.trim(input.expectedDate)
        if !expected.isEmpty && !isRealDate(expected) { return .failed(ManualParcelText.expectedDateInvalid) }
        let amount: Int?
        switch parseAmount(input.totalAmount, stored: storedAmount) {
        case .empty: amount = nil
        case let .yen(n): amount = n
        case .invalid: return .failed(ManualParcelText.amountInvalid)
        }
        let category = JSText.trim(input.category)
        if !category.isEmpty && !ParcelCategory.isCategory(category) { return .failed(ManualParcelText.categoryInvalid) }
        let tracking = JSText.trim(input.trackingNumber)
        if tracking.utf16.count > ManualLimits.tracking { return .failed(ManualParcelText.trackingTooLong) }
        guard carriers.contains(input.carrier) else { return .failed(ManualParcelText.checkInput) }
        guard let presence = ManualPresence(rawValue: input.presence) else { return .failed(ManualParcelText.checkInput) }
        guard statuses.contains(input.status) else { return .failed(ManualParcelText.checkInput) }
        return .ok(Validated(
            title: title, shop: shop, ordered: ordered, expected: expected, amount: amount, category: category,
            tracking: tracking, carrier: input.carrier, presence: presence, status: input.status
        ))
    }

    /// ManualParcelSchema.safeParse + manualParcelRow(parsed, now) + user_id.
    static func check(_ input: ManualParcelInput, userId: String, now: Date, id: String? = nil) -> Result {
        let statuses = Set(ManualStatus.allCases.map(\.rawValue))
        let carriers = Set(ManualCarrier.allCases.map(\.rawValue))
        switch validate(input, storedAmount: nil, statuses: statuses, carriers: carriers) {
        case let .failed(message):
            return .invalid(message)
        case let .ok(v):
            let number = Carriers.normalizeTracking(v.tracking)
            let trackingNumber: String? = number.isEmpty ? nil : number
            return .valid(ManualParcelRow(
                id: id,
                userId: userId,
                title: v.title,
                shop: v.shop,
                orderedAt: v.ordered.isEmpty ? Format.todayJst(now: now) : v.ordered,
                expectedDate: v.expected.isEmpty ? nil : v.expected,
                totalAmount: v.amount,
                category: v.category.isEmpty ? nil : v.category,
                categorySource: v.category.isEmpty ? nil : "user",
                trackingNumber: trackingNumber,
                carrier: carrierName(ManualCarrier(rawValue: v.carrier) ?? .auto, tracking: trackingNumber),
                requiresPresence: v.presence.requiresPresence,
                status: v.status,
                lastEmailAt: isoString(now)
            ))
        }
    }

    // MARK: an edit

    /// What is stored for the parcel being edited (the columns updateManualParcel reads), with updated_at
    /// as it was read: the write is made only on that version.
    struct Saved: Decodable, Equatable, Sendable {
        var status: String
        var totalAmount: Int?
        var category: String?
        var orderedAt: String?
        var expectedDate: String?
        var trackingNumber: String?
        var carrier: String?
        var requiresPresence: Bool?
        var updatedAt: String

        enum CodingKeys: String, CodingKey {
            case status, category, carrier
            case totalAmount = "total_amount"
            case orderedAt = "ordered_at"
            case expectedDate = "expected_date"
            case trackingNumber = "tracking_number"
            case requiresPresence = "requires_presence"
            case updatedAt = "updated_at"
        }
    }

    /// One column of an update: a value or null.
    enum Column: Encodable, Equatable, Sendable {
        case text(String)
        case number(Int)
        case flag(Bool)
        case null

        init(_ value: String?) { self = value.map(Column.text) ?? .null }
        init(_ value: Int?) { self = value.map(Column.number) ?? .null }
        init(_ value: Bool?) { self = value.map(Column.flag) ?? .null }

        func encode(to encoder: any Encoder) throws {
            var c = encoder.singleValueContainer()
            switch self {
            case let .text(v): try c.encode(v)
            case let .number(v): try c.encode(v)
            case let .flag(v): try c.encode(v)
            case .null: try c.encodeNil()
            }
        }
    }

    enum EditResult: Equatable, Sendable {
        /// The columns to write: only those the form changes (manualParcelFields).
        case valid([String: Column])
        case invalid(String)
    }

    /// manualParcelSchemaFor(saved.status, saved.total_amount).safeParse + manualParcelFields(parsed, now, saved).
    /// A cancelled parcel may stay cancelled; the stored amount may be saved back unchanged even above
    /// what may be typed. A column the form leaves as it is stored is not written: the category stays
    /// automatic, a date keeps its range, time and wording, a number and carrier keep the tracking URL,
    /// a way of receiving keeps its evidence, an order date left empty keeps the stored one.
    static func checkEdit(_ input: ManualParcelInput, saved: Saved) -> EditResult {
        var statuses = Set(ManualStatus.allCases.map(\.rawValue) + carriedStatuses)
        if saved.status == cancelled { statuses.insert(cancelled) }
        let carriers = Set(ManualCarrier.allCases.map(\.rawValue) + [keepCarrier])
        switch validate(input, storedAmount: saved.totalAmount, statuses: statuses, carriers: carriers) {
        case let .failed(message):
            return .invalid(message)
        case let .ok(v):
            var columns: [String: Column] = [
                "title": .text(v.title),
                "shop": .text(v.shop),
                "shop_key": .text("other"),
                "total_amount": Column(v.amount),
                "status": .text(v.status),
            ]
            let category: String? = v.category.isEmpty ? nil : v.category
            if saved.category != category {
                columns["category"] = Column(category)
                columns["category_source"] = category == nil ? .null : .text("user")
            }
            let expected: String? = v.expected.isEmpty ? nil : v.expected
            if saved.expectedDate != expected {
                columns["expected_date"] = Column(expected)
                for key in ["expected_date_end", "expected_window_start", "expected_window_end", "expected_text"] { columns[key] = .null }
            }
            let number = Carriers.normalizeTracking(v.tracking)
            let trackingNumber: String? = number.isEmpty ? nil : number
            let storedNumber = Carriers.normalizeTracking(saved.trackingNumber ?? "")
            let trackingKept = (storedNumber.isEmpty ? nil : storedNumber) == trackingNumber
                && carrierChoice(saved.carrier, tracking: saved.trackingNumber) == v.carrier
            if !trackingKept {
                let carrier = v.carrier == keepCarrier ? saved.carrier : carrierName(ManualCarrier(rawValue: v.carrier) ?? .auto, tracking: trackingNumber)
                columns["tracking_number"] = Column(trackingNumber)
                columns["carrier"] = Column(carrier)
                columns["tracking_url"] = .null
            }
            let presence = v.presence.requiresPresence
            columns["requires_presence"] = Column(presence)
            if saved.requiresPresence != presence { columns["presence_evidence"] = .null }
            // An order date left empty keeps the stored one; a column that comes out as it is stored is not written.
            let ordered: String? = v.ordered.isEmpty ? saved.orderedAt : v.ordered
            if ordered != saved.orderedAt { columns["ordered_at"] = Column(ordered) }
            return .valid(columns)
        }
    }

    /// Whether writing `columns` (the result of checkEdit) would change nothing that is stored: every column the form
    /// always sends equals what is stored, and no other column is there (those are written only on a difference).
    /// shop_key is not compared (the edit always sends "other").
    static func writesNothing(_ columns: [String: Column], saved: Saved, title: String, shop: String) -> Bool {
        for (key, value) in columns {
            switch key {
            case "title": guard value == .text(title) else { return false }
            case "shop": guard value == .text(shop) else { return false }
            case "shop_key": continue
            case "total_amount": guard value == Column(saved.totalAmount) else { return false }
            case "status": guard value == .text(saved.status) else { return false }
            case "requires_presence": guard value == Column(saved.requiresPresence) else { return false }
            default: return false
            }
        }
        return true
    }

    /// manualCarrierChoice(name, tracking): one of the five when the stored name is theirs, "auto" when the
    /// number gives the stored name (or none is stored), else "keep".
    static func carrierChoice(_ name: String?, tracking: String?) -> String {
        if let named = ManualCarrier.allCases.first(where: { $0 != .auto && $0.carrierName == name }) { return named.rawValue }
        if name == nil || carrierName(.auto, tracking: tracking) == name { return ManualCarrier.auto.rawValue }
        return keepCarrier
    }

    /// carrierName(choice, tracking): the chosen carrier's name; "auto" asks the number's shape (nil when unknown).
    static func carrierName(_ choice: ManualCarrier, tracking: String?) -> String? {
        if let name = choice.carrierName { return name }
        let found = Carriers.identifyCarrier(tracking, hint: nil)
        return found.key == .unknown ? nil : found.name
    }

    /// Date.toISOString(): "2026-11-08T05:00:00.000Z".
    static func isoString(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: date)
    }

    /// isRealDate: YYYY-MM-DD, a year from 1900 to 2100, a day the month has.
    static func isRealDate(_ v: String) -> Bool {
        let u = Array(v.utf16)
        guard u.count == 10, u[4] == 0x2D, u[7] == 0x2D else { return false }
        let digitPositions = [0, 1, 2, 3, 5, 6, 8, 9]
        guard digitPositions.allSatisfy({ (0x30...0x39).contains(u[$0]) }) else { return false }
        func num(_ range: Range<Int>) -> Int { range.reduce(0) { $0 * 10 + Int(u[$1] - 0x30) } }
        let y = num(0..<4), m = num(5..<7), d = num(8..<10)
        guard (1900...2100).contains(y), (1...12).contains(m), d >= 1 else { return false }
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
        let days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return d <= days[m - 1]
    }

    /// The `amount` rule: "1,980", "¥1,980", "¥ 1,980 円" and full-width digits (spaces only at the ends,
    /// after ¥ and before 円); a whole number of yen up to MANUAL_MAX_AMOUNT, or the stored amount saved back
    /// unchanged (a mail may have filled in more). nil: refused.
    enum Amount: Equatable, Sendable {
        case empty
        case yen(Int)
        case invalid
    }

    static func parseAmount(_ raw: String, stored: Int? = nil) -> Amount {
        let v = JSText.trim(raw)
        var cleaned = JSText.trim(v.precomposedStringWithCompatibilityMapping.replacingOccurrences(of: ",", with: ""))
        cleaned = stripYenSign(cleaned)
        cleaned = stripYenSuffix(cleaned)
        // An input that was only commas must not read as empty: that would drop the amount silently.
        if cleaned.isEmpty && !v.isEmpty { cleaned = v }
        if cleaned.isEmpty { return .empty }
        let u = Array(cleaned.utf16)
        guard u.count <= 10, u.allSatisfy({ (0x30...0x39).contains($0) }), let n = Int(cleaned), n <= ManualLimits.maxAmount || n == stored else { return .invalid }
        return .yen(n)
    }

    /// `/^[¥￥]\s*(?=\d)/` removed (￥ has become ¥ under NFKC).
    private static func stripYenSign(_ s: String) -> String {
        var u = Array(s.utf16)
        guard let first = u.first, first == 0xA5 || first == 0xFFE5 else { return s }
        var i = 1
        while i < u.count, isSpace(u[i]) { i += 1 }
        guard i < u.count, (0x30...0x39).contains(u[i]) else { return s }
        u.removeFirst(i)
        return String(decoding: u, as: UTF16.self)
    }

    /// `/(\d)\s*円$/` replaced by the digit.
    private static func stripYenSuffix(_ s: String) -> String {
        var u = Array(s.utf16)
        guard u.last == 0x5186 else { return s }
        var i = u.count - 2
        while i >= 0, isSpace(u[i]) { i -= 1 }
        guard i >= 0, (0x30...0x39).contains(u[i]) else { return s }
        u.removeSubrange((i + 1)...)
        return String(decoding: u, as: UTF16.self)
    }

    private static func isSpace(_ u: UInt16) -> Bool {
        JSText.isTrimmable(u)
    }
}
