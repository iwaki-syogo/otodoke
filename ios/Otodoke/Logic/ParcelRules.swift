// Port of src/lib/match (lastExpectedDay, needsCheck, isLate, faceToFace) and
// src/lib/parcel-sections.ts (sections and byNextArrival, a stable sort).

import Foundation

/// The list's sections. `open` is every parcel neither delivered nor cancelled, in the order given.
struct ParcelSections: Equatable, Sendable {
    var open: [ParcelRow]
    var arrived: [ParcelRow] = []
    var toCheck: [ParcelRow]
    var delivering: [ParcelRow]
    var soon: [ParcelRow]
    var ordered: [ParcelRow]

    static let empty = ParcelSections(open: [], toCheck: [], delivering: [], soon: [], ordered: [])
}

enum ParcelRules {
    /// CHECK_AFTER_DAYS.
    static let checkAfterDays = 14

    /// The last day a parcel may still arrive on time: the end of a window, or the one date.
    static func lastExpectedDay(_ p: ParcelRow) -> String? {
        p.expectedDateEnd ?? p.expectedDate
    }

    /// The sentinel asks the database to store null without the old-client trigger setting now().
    static let receivedAtNone = "-infinity"

    /// Only finite instants are received: neither PostgreSQL infinity nor malformed text counts.
    static func isReceivedAt(_ value: String?) -> Bool {
        value.flatMap(Instant.micros) != nil
    }

    static func isReceived(_ p: ParcelRow) -> Bool {
        p.status == "delivered" && isReceivedAt(p.receivedAt)
    }

    /// Two weeks after the expected day, or (for delivered) the later of that day and its latest mail.
    /// A delivered parcel answered with まだ is not asked again; no parcel moves itself to received.
    static func needsCheck(_ p: ParcelRow, today: String) -> Bool {
        if p.status == "cancelled" || isReceived(p) { return false }
        if p.status == "delivered" {
            guard p.checkDismissedAt == nil else { return false }
            return deliveryNeedsCheck(expectedDate: p.expectedDate, expectedDateEnd: p.expectedDateEnd,
                                      lastEmailAt: p.lastEmailAt, today: today)
        }
        let base = lastExpectedDay(p) ?? mailDay(p.lastEmailAt)
        return base.map { !JSText.less(CivilDate.addDays(today, -checkAfterDays), $0) } ?? false
    }

    /// The same 14-day question without a previous received/まだ answer, for a change back to 配達済み.
    static func deliveryNeedsCheck(expectedDate: String?, expectedDateEnd: String?, lastEmailAt: String?, today: String) -> Bool {
        let last = expectedDateEnd ?? expectedDate
        let mail = mailDay(lastEmailAt)
        let base: String?
        if let last, let mail { base = JSText.less(last, mail) ? mail : last }
        else { base = last ?? mail }
        return base.map { !JSText.less(CivilDate.addDays(today, -checkAfterDays), $0) } ?? false
    }

    private static func mailDay(_ value: String?) -> String? {
        guard let micros = value.flatMap(Instant.micros) else { return nil }
        let seconds = CivilDate.floorDiv(micros, 1_000_000)
        return Format.todayJst(now: Date(timeIntervalSince1970: TimeInterval(seconds)))
    }

    /// Past its date with no delivery mail yet, but not long enough to ask.
    static func isLate(_ p: ParcelRow, today: String) -> Bool {
        if isClosed(p) { return false }
        guard let lastDay = lastExpectedDay(p) else { return false }
        return JSText.less(lastDay, today)
    }

    /// Face-to-face as shown: the stored value, else unknown for Amazon and yes for everyone else.
    static func faceToFace(_ p: ParcelRow) -> Bool? {
        p.requiresPresence ?? (p.shopKey == "amazon" ? nil : true)
    }

    /// faceToFaceAssumed (src/lib/match): face-to-face only by the default, with nothing stored. Worded
    /// apart on screen (念のため対面) so a guess never reads like what a mail said; still face-to-face.
    static func faceToFaceAssumed(_ p: ParcelRow) -> Bool {
        faceToFace(p) == true && p.requiresPresence != true
    }

    /// parcelSections(parcels, today), given parcels in the database's order.
    static func sections(_ parcels: [ParcelRow], today: String) -> ParcelSections {
        let open = parcels.filter { !isClosed($0) }
        let toCheck = parcels.filter { needsCheck($0, today: today) }
        let arrived = parcels.filter { $0.status == "delivered" && !isReceived($0) && !needsCheck($0, today: today) }
        let active = open.filter { !needsCheck($0, today: today) }
        let isDelivering = { (p: ParcelRow) in p.status == "out_for_delivery" && !isLate(p, today: today) }
        let isOrdered = { (p: ParcelRow) in (p.status == "ordered" || p.status == "unknown") && !isLate(p, today: today) }
        let delivering = active.filter(isDelivering)
        let ordered = active.filter(isOrdered)
        let soon = stableSorted(active.filter { !isDelivering($0) && !isOrdered($0) }, by: byNextArrival(today: today))
        return ParcelSections(open: open, arrived: arrived, toCheck: toCheck, delivering: delivering, soon: soon, ordered: ordered)
    }

    /// The database's order of the Web's list: expected_date ascending, nulls last; then last_email_at
    /// descending, nulls last, compared as instants; then id ascending.
    static func baseOrder(_ parcels: [ParcelRow]) -> [ParcelRow] {
        stableSorted(parcels) { a, b in
            switch (a.expectedDate, b.expectedDate) {
            case let (x?, y?) where !JSText.equal(x, y): return JSText.less(x, y) ? -1 : 1
            case (nil, _?): return 1
            case (_?, nil): return -1
            default: break
            }
            switch (a.lastEmailAt.flatMap(Instant.micros), b.lastEmailAt.flatMap(Instant.micros)) {
            case let (x?, y?) where x != y: return x > y ? -1 : 1
            case (nil, _?): return 1
            case (_?, nil): return -1
            default: break
            }
            let ia = a.id.lowercased(), ib = b.id.lowercased()
            if JSText.equal(ia, ib) { return 0 }
            return JSText.less(ia, ib) ? -1 : 1
        }
    }

    // MARK: - Private

    private static func isClosed(_ p: ParcelRow) -> Bool {
        p.status == "delivered" || p.status == "cancelled"
    }

    /// byNextArrival: what arrives next first, then what is running late, then what has no date yet;
    /// within a rank by expected_date. (The Web's localeCompare equals code-unit order on "YYYY-MM-DD".)
    private static func byNextArrival(today: String) -> (ParcelRow, ParcelRow) -> Int {
        func rank(_ p: ParcelRow) -> Int {
            guard let date = p.expectedDate, !date.isEmpty else { return 2 }
            return JSText.less(lastExpectedDay(p) ?? date, today) ? 1 : 0
        }
        return { a, b in
            let r = rank(a) - rank(b)
            if r != 0 { return r }
            let x = a.expectedDate ?? "", y = b.expectedDate ?? ""
            if JSText.equal(x, y) { return 0 }
            return JSText.less(x, y) ? -1 : 1
        }
    }

    /// Array#sort with a comparator: stable (equal elements keep the order given).
    private static func stableSorted(_ items: [ParcelRow], by compare: (ParcelRow, ParcelRow) -> Int) -> [ParcelRow] {
        items.enumerated()
            .sorted { l, r in
                let c = compare(l.element, r.element)
                return c != 0 ? c < 0 : l.offset < r.offset
            }
            .map(\.element)
    }
}
