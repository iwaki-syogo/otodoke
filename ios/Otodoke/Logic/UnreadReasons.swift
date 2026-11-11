// Why mail is waiting: readUnreadReasons of src/app/app/settings/settings-reads.ts, counted by hand from one read of
// the unread rows (the same rule; the table of cases both sides run is Fixtures/unread-reasons.json).
//
// A row marked claude_unavailable counts as stopped only while nothing was read after it: the newest such row must be
// newer than the newest sign that Claude answered. The sign is the newest processed mail (not a sample, not Gmail's
// forwarding confirmation: those are processed without Claude) and the newest row Claude refused ("model refused").
// Times are compared as the Web compares them, `Date.parse` (whole milliseconds), on created_at on both sides.

import Foundation

struct UnreadReasons: Equatable, Sendable {
    var stopped: Int
    var overLimit: Int
    var failed: Int
}

/// The columns of an unread mail that the reasons need.
struct UnreadReasonRow: Decodable, Equatable, Sendable {
    let id: String
    let processingStatus: String
    let error: String?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, error
        case processingStatus = "processing_status"
        case createdAt = "created_at"
    }
}

enum UnreadReasonsRule {
    static let unavailable = "claude_unavailable"
    static let refused = "model refused"
    static let overLimit = "over_limit"

    /// `lastProcessedAt`: created_at of the newest processed mail that is not a sample nor a forwarding confirmation.
    static func count(rows: [UnreadReasonRow], lastProcessedAt: String?) -> UnreadReasons {
        let unavailableRows = rows.filter { $0.error == unavailable }
        // Like Math.max: one time that cannot be read (NaN) makes the maximum NaN, and a comparison with NaN is false.
        let newestStop = jsMax(unavailableRows.map { ms($0.createdAt) })
        let answered = jsMax([lastProcessedAt.map(ms) ?? -.infinity] + rows.filter { $0.error == refused }.map { ms($0.createdAt) })
        let stopped = !unavailableRows.isEmpty && newestStop > answered ? unavailableRows.count : 0
        let over = rows.filter { $0.processingStatus == overLimit }.count
        return UnreadReasons(stopped: stopped, overLimit: over, failed: rows.count - stopped - over)
    }

    /// Date.parse: whole milliseconds since the epoch, NaN when the text is not a time.
    private static func ms(_ text: String) -> Double {
        guard let micros = Instant.micros(text) else { return .nan }
        return Double(CivilDate.floorDiv(micros, 1000))
    }

    private static func jsMax(_ values: [Double]) -> Double {
        var best = -Double.infinity
        for v in values {
            if v.isNaN { return .nan }
            best = max(best, v)
        }
        return best
    }
}
