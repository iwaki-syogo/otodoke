// Port of src/lib/undelivered.ts, src/lib/unread.ts and RESTORABLE of src/app/app/parcel-actions.ts.

import Foundation

enum StatusRules {
    /// RESTORABLE: the statuses a parcel may be put back to (and so the only ones it may be marked from).
    static let restorable: [String] = ["ordered", "shipped", "out_for_delivery", "attempted", "unknown"]

    /// PENDING_GRACE_MS in seconds.
    static let pendingGrace: TimeInterval = 3 * 60

    /// undeliveredStatus(row): "shipped" with a tracking number or a carrier (blank text counts as none), else "ordered".
    static func undeliveredStatus(trackingNumber: String?, carrier: String?) -> String {
        func known(_ v: String?) -> Bool { !JSText.trim(v ?? "").isEmpty }
        return known(trackingNumber) || known(carrier) ? "shipped" : "ordered"
    }

    /// UNREAD_FILTER(now): the PostgREST `or` filter text, the time written like JS toISOString().
    static func unreadFilter(now: Date) -> String {
        let nowMs = Int64((now.timeIntervalSince1970 * 1000).rounded())
        let stuckBefore = isoString(milliseconds: nowMs - Int64(pendingGrace * 1000))
        return "processing_status.in.(over_limit,failed),and(processing_status.eq.pending,created_at.lt.\(stuckBefore))"
    }

    /// Date#toISOString(): "2026-11-04T02:57:00.000Z", always UTC with milliseconds.
    private static func isoString(milliseconds ms: Int64) -> String {
        let days = Int(CivilDate.floorDiv(ms, 86_400_000))
        let inDay = Int(CivilDate.mod(ms, 86_400_000))
        let p = CivilDate.civilFromDays(days)
        let year = (0...9999).contains(p.y) ? JSText.pad(p.y, 4) : (p.y < 0 ? "-" : "+") + JSText.pad(abs(p.y), 6)
        let h = inDay / 3_600_000, m = inDay / 60000 % 60, s = inDay / 1000 % 60, milli = inDay % 1000
        return "\(year)-\(JSText.pad(p.m, 2))-\(JSText.pad(p.d, 2))T\(JSText.pad(h, 2)):\(JSText.pad(m, 2)):\(JSText.pad(s, 2)).\(JSText.pad(milli, 3))Z"
    }
}
