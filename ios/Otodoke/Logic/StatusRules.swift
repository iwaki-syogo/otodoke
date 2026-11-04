// TDD-STUB(task 4): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Port of src/lib/undelivered.ts, src/lib/unread.ts and RESTORABLE of src/app/app/parcel-actions.ts.

import Foundation

enum StatusRules {
    /// RESTORABLE: the statuses a parcel may be put back to (and so the only ones it may be marked from).
    static let restorable: [String] = []

    /// PENDING_GRACE_MS in seconds.
    static let pendingGrace: TimeInterval = 0

    /// undeliveredStatus(row): "shipped" with a tracking number or a carrier (blank text counts as none), else "ordered".
    static func undeliveredStatus(trackingNumber: String?, carrier: String?) -> String { "" }

    /// UNREAD_FILTER(now): the PostgREST `or` filter text, the time written like JS toISOString().
    static func unreadFilter(now: Date) -> String { "" }
}
