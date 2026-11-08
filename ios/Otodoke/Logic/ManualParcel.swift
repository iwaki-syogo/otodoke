// Port of src/lib/manual-parcel.ts (the new-parcel half): a parcel typed in by hand. The form's checks
// (ManualParcelSchema) and the parcels columns it becomes (manualParcelRow). The words of the errors
// are in ManualParcelText, the same ones as the Web.

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
        case userId = "user_id", title, shop, shopKey = "shop_key", orderedAt = "ordered_at"
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

    /// ManualParcelSchema.safeParse + manualParcelRow(parsed, now) + user_id. The first error found, in
    /// the schema's field order (title, shop, ordered_at, expected_date, total_amount, category,
    /// tracking_number, carrier, presence, status).
    static func check(_ input: ManualParcelInput, userId: String, now: Date) -> Result {
        let title = JSText.trim(input.title)
        if title.isEmpty { return .invalid(ManualParcelText.titleEmpty) }
        if title.utf16.count > ManualLimits.title { return .invalid(ManualParcelText.titleTooLong) }
        let shop = JSText.trim(input.shop)
        if shop.isEmpty { return .invalid(ManualParcelText.shopEmpty) }
        if shop.utf16.count > ManualLimits.shop { return .invalid(ManualParcelText.shopTooLong) }
        let ordered = JSText.trim(input.orderedAt)
        if !ordered.isEmpty && !isRealDate(ordered) { return .invalid(ManualParcelText.orderedAtInvalid) }
        let expected = JSText.trim(input.expectedDate)
        if !expected.isEmpty && !isRealDate(expected) { return .invalid(ManualParcelText.expectedDateInvalid) }
        let amount: Int?
        switch parseAmount(input.totalAmount) {
        case .empty: amount = nil
        case let .yen(n): amount = n
        case .invalid: return .invalid(ManualParcelText.amountInvalid)
        }
        let category = JSText.trim(input.category)
        if !category.isEmpty && !ParcelCategory.isCategory(category) { return .invalid(ManualParcelText.categoryInvalid) }
        let tracking = JSText.trim(input.trackingNumber)
        if tracking.utf16.count > ManualLimits.tracking { return .invalid(ManualParcelText.trackingTooLong) }
        guard let carrier = ManualCarrier(rawValue: input.carrier) else { return .invalid(ManualParcelText.checkInput) }
        guard let presence = ManualPresence(rawValue: input.presence) else { return .invalid(ManualParcelText.checkInput) }
        guard ManualStatus(rawValue: input.status) != nil else { return .invalid(ManualParcelText.checkInput) }

        let number = Carriers.normalizeTracking(tracking)
        let trackingNumber: String? = number.isEmpty ? nil : number
        let row = ManualParcelRow(
            userId: userId,
            title: title,
            shop: shop,
            orderedAt: ordered.isEmpty ? Format.todayJst(now: now) : ordered,
            expectedDate: expected.isEmpty ? nil : expected,
            totalAmount: amount,
            category: category.isEmpty ? nil : category,
            categorySource: category.isEmpty ? nil : "user",
            trackingNumber: trackingNumber,
            carrier: carrierName(carrier, tracking: trackingNumber),
            requiresPresence: presence.requiresPresence,
            status: input.status,
            lastEmailAt: isoString(now)
        )
        return .valid(row)
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
    /// after ¥ and before 円); a whole number of yen up to MANUAL_MAX_AMOUNT. nil: refused.
    enum Amount: Equatable, Sendable {
        case empty
        case yen(Int)
        case invalid
    }

    static func parseAmount(_ raw: String) -> Amount {
        let v = JSText.trim(raw)
        var cleaned = JSText.trim(v.precomposedStringWithCompatibilityMapping.replacingOccurrences(of: ",", with: ""))
        cleaned = stripYenSign(cleaned)
        cleaned = stripYenSuffix(cleaned)
        // An input that was only commas must not read as empty: that would drop the amount silently.
        if cleaned.isEmpty && !v.isEmpty { cleaned = v }
        if cleaned.isEmpty { return .empty }
        let u = Array(cleaned.utf16)
        guard u.count <= 10, u.allSatisfy({ (0x30...0x39).contains($0) }), let n = Int(cleaned), n <= ManualLimits.maxAmount else { return .invalid }
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
