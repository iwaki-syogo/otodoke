// TDD-STUB(task 7): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Every write goes through ONE private function: id validated as a UUID, `user_id = me` always,
// select("id,status,updated_at"), exactly one row back or it is not a success.

import Foundation

/// A parcel as the screen saw it: the version a write is conditioned on.
struct ParcelVersion: Equatable, Sendable {
    let id: String
    let status: String
    let updatedAt: String

    init(id: String, status: String, updatedAt: String) {
        self.id = id
        self.status = status
        self.updatedAt = updatedAt
    }

    init(_ row: ParcelRow) {
        self.init(id: row.id, status: row.status, updatedAt: row.updatedAt)
    }
}

/// What 「元に戻す」 needs: the status before, and updated_at as the 「届いた」 write left it.
struct UndoToken: Equatable, Sendable {
    let id: String
    let restoreTo: String
    let deliveredUpdatedAt: String
}

enum NotUpdatedReason: Equatable, Sendable {
    /// Refused before sending (not a UUID, a status that may not be written, too many at once).
    case invalidInput
    /// Sent, and 0 rows matched: someone else changed the row (or it is not ours).
    case conflict
    /// The server answered with an error, the device was offline, or not exactly one row came back.
    case failed
}

/// Codex-P3: a write either succeeded, surely did not happen, or its result is unknown
/// (sent, but the answer was lost). Unknown is never retried automatically.
enum WriteOutcome<Success: Equatable & Sendable>: Equatable, Sendable {
    case success(Success)
    case notUpdated(NotUpdatedReason)
    case unknown
}

struct BulkItemResult<Success: Equatable & Sendable>: Equatable, Sendable {
    let id: String
    let outcome: WriteOutcome<Success>
}

struct ParcelWriter: Sendable {
    /// MAX_AT_ONCE: more than this is refused whole.
    static let maxAtOnce = 500

    let provider: SupabaseProvider

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    /// 「届いた」 on the version shown: status → delivered where id, user_id = me, status != cancelled,
    /// status = shown.status and updated_at = shown.updatedAt (sent verbatim).
    func markDelivered(_ shown: ParcelVersion) async -> WriteOutcome<UndoToken> { .notUpdated(.failed) }

    /// 「すべて受取済にする」: the single-row write for each, in the order given, one result per id.
    func markDelivered(all shown: [ParcelVersion]) async -> [BulkItemResult<UndoToken>] { [] }

    /// 「元に戻す」: status → token.restoreTo (RESTORABLE only) where id, user_id = me, status = delivered
    /// and updated_at = token.deliveredUpdatedAt.
    func undoDelivered(_ token: UndoToken) async -> WriteOutcome<ParcelVersion> { .notUpdated(.failed) }

    func undoDelivered(all tokens: [UndoToken]) async -> [BulkItemResult<ParcelVersion>] { [] }

    /// 「届いていない」: reads the row (tracking_number, carrier, status, updated_at), refuses unless
    /// delivered, then status → StatusRules.undeliveredStatus where status = delivered and updated_at = read.
    func markNotDelivered(id: String) async -> WriteOutcome<ParcelVersion> { .notUpdated(.failed) }

    /// category = one of the seven, category_source = "user".
    func setCategory(id: String, category: ParcelCategory) async -> WriteOutcome<ParcelVersion> { .notUpdated(.failed) }
}
