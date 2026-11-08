// Every write to parcels goes through ONE private function, `write(id:_:)`: the id validated as a
// UUID, `user_id = me` always, select("id,status,updated_at"), and exactly one row back or it is not
// a success. The conditions of each kind of change are built inside that function from the change
// itself, so a caller cannot leave one out:
//  1. user_id = me on every write
//  2. 「届いた」 never from cancelled (status != cancelled), and only on the version the screen showed
//  3. back only to a RESTORABLE status, and only from delivered (status = delivered, updated_at as read)
//  4. a category is one of the seven, recorded as the user's (category_source = "user"), and only on
//     the version the screen showed (updated_at as read): a choice whose answer was lost and that
//     reaches the server late never overwrites a later choice (CF1)
// updated_at is sent exactly as it was read (a String; supabase-swift percent-encodes its "+").
// No automatic retries (PostgREST's retryEnabled is false), and a result that is unknown is never
// sent again: the caller reads the row again instead.

import Foundation
import PostgREST

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
    /// CX1: where a write tells the other tabs 「古くなった」: published on a success or an unknown
    /// result, once per bulk call (none when nothing of it succeeded or is unknown).
    let changes: DataChanges?

    init(provider: SupabaseProvider, changes: DataChanges? = nil) {
        self.provider = provider
        self.changes = changes
    }

    /// 「届いた」 on the version shown: status → delivered where id, user_id = me, status != cancelled,
    /// status = shown.status and updated_at = shown.updatedAt (sent verbatim).
    func markDelivered(_ shown: ParcelVersion) async -> WriteOutcome<UndoToken> {
        await announced(deliver(shown))
    }

    private func deliver(_ shown: ParcelVersion) async -> WriteOutcome<UndoToken> {
        switch await write(id: shown.id, .deliver(shown)) {
        case let .success(after):
            return .success(UndoToken(id: after.id, restoreTo: shown.status, deliveredUpdatedAt: after.updatedAt))
        case let .notUpdated(reason):
            return .notUpdated(reason)
        case .unknown:
            return .unknown
        }
    }

    /// 「すべて受取済にする」: the single-row write for each, in the order given, one result per id.
    /// `progress` hears how many have been answered after each one (for 「保存中… 12/80」).
    func markDelivered(
        all shown: [ParcelVersion],
        progress: (@Sendable (Int) async -> Void)? = nil
    ) async -> [BulkItemResult<UndoToken>] {
        guard shown.count <= Self.maxAtOnce else {
            return shown.map { BulkItemResult(id: $0.id, outcome: .notUpdated(.invalidInput)) }
        }
        var results: [BulkItemResult<UndoToken>] = []
        for version in shown {
            results.append(BulkItemResult(id: version.id, outcome: await deliver(version)))
            await progress?(results.count)
        }
        await announce(results.map(\.outcome))
        return results
    }

    /// 「元に戻す」: status → token.restoreTo (RESTORABLE only) where id, user_id = me, status = delivered
    /// and updated_at = token.deliveredUpdatedAt.
    func undoDelivered(_ token: UndoToken) async -> WriteOutcome<ParcelVersion> {
        await announced(restore(token))
    }

    private func restore(_ token: UndoToken) async -> WriteOutcome<ParcelVersion> {
        await write(id: token.id, .restore(to: token.restoreTo, deliveredUpdatedAt: token.deliveredUpdatedAt))
    }

    func undoDelivered(all tokens: [UndoToken]) async -> [BulkItemResult<ParcelVersion>] {
        guard tokens.count <= Self.maxAtOnce else {
            return tokens.map { BulkItemResult(id: $0.id, outcome: .notUpdated(.invalidInput)) }
        }
        var results: [BulkItemResult<ParcelVersion>] = []
        for token in tokens {
            results.append(BulkItemResult(id: token.id, outcome: await restore(token)))
        }
        await announce(results.map(\.outcome))
        return results
    }

    /// 「届いていない」: reads the row (tracking_number, carrier, status, updated_at), refuses unless
    /// delivered, then status → StatusRules.undeliveredStatus where status = delivered and updated_at = read.
    func markNotDelivered(id: String) async -> WriteOutcome<ParcelVersion> {
        guard Self.isUUID(id) else { return .notUpdated(.invalidInput) }
        guard let me = await provider.currentUserID() else { return .notUpdated(.failed) }
        let rows: [ReadBack]
        do {
            let response = try await provider.database.from("parcels")
                .select("tracking_number,carrier,status,updated_at")
                .eq("id", value: id)
                .eq("user_id", value: me)
                .execute()
            rows = try JSONDecoder().decode([ReadBack].self, from: response.data)
        } catch {
            return .notUpdated(.failed)
        }
        guard rows.count <= 1 else { return .notUpdated(.failed) }
        // Not there (or not ours), or no longer delivered: nothing to put back.
        guard let row = rows.first, row.status == "delivered" else { return .notUpdated(.conflict) }
        let to = StatusRules.undeliveredStatus(trackingNumber: row.trackingNumber, carrier: row.carrier)
        return await announced(write(id: id, .restore(to: to, deliveredUpdatedAt: row.updatedAt)))
    }

    /// category = one of the seven, category_source = "user", where updated_at = shown.updatedAt (sent
    /// verbatim). 0 rows: the parcel changed since it was shown, or is gone (conflict).
    func setCategory(_ shown: ParcelVersion, category: ParcelCategory) async -> WriteOutcome<ParcelVersion> {
        await announced(write(id: shown.id, .category(category, updatedAt: shown.updatedAt)))
    }

    /// The same, on the version read now (updated_at, then the write conditioned on it), for a caller
    /// with no version shown.
    func setCategory(id: String, category: ParcelCategory) async -> WriteOutcome<ParcelVersion> {
        guard Self.isUUID(id) else { return .notUpdated(.invalidInput) }
        guard let me = await provider.currentUserID() else { return .notUpdated(.failed) }
        let rows: [Stamp]
        do {
            let response = try await provider.database.from("parcels")
                .select("updated_at")
                .eq("id", value: id)
                .eq("user_id", value: me)
                .execute()
            rows = try JSONDecoder().decode([Stamp].self, from: response.data)
        } catch {
            return .notUpdated(.failed)
        }
        guard rows.count <= 1 else { return .notUpdated(.failed) }
        guard let row = rows.first else { return .notUpdated(.conflict) }
        return await announced(write(id: id, .category(category, updatedAt: row.updatedAt)))
    }

    // MARK: a new typed-in parcel

    /// The id column asked back from an insert.
    private struct Inserted: Decodable {
        let id: String
    }

    /// 「＋ 登録」: one insert of a typed-in parcel, as the signed-in user (user_id = me, whatever the
    /// row says), `.select("id")` for the answer. Exactly one row back is a success; an answer that is
    /// lost or unreadable is unknown. Nothing is retried here; a caller that sends the same row (the same
    /// id) again after an unknown result gets a success if the first send had made it (23505).
    func createManual(_ row: ManualParcelRow) async -> WriteOutcome<String> {
        guard let me = await provider.currentUserID() else { return .notUpdated(.failed) }
        var mine = row
        mine.userId = me
        do {
            _ = try await provider.auth.session
        } catch {
            return .notUpdated(.failed)
        }
        let response: PostgrestResponse<Void>
        do {
            response = try await provider.database.from("parcels").insert(mine).select("id").execute()
        } catch {
            // The same id sent again after a lost answer: that parcel is already there, made by the first send.
            if let id = mine.id, let failure = error as? PostgrestError, failure.code == "23505" {
                return await announced(.success(id))
            }
            return await announced(Self.outcome(of: error))
        }
        guard let rows = try? JSONDecoder().decode([Inserted].self, from: response.data), rows.count == 1, let created = rows.first else {
            // The server said yes but the body is not one row: whether a parcel was made is not known.
            return await announced(.unknown)
        }
        return await announced(.success(created.id))
    }

    // MARK: an edit and a delete of a typed-in parcel

    enum ManualEditOutcome: Equatable, Sendable {
        case saved
        /// The form's check (manualParcelSchemaFor), made on what is stored.
        case invalid(String)
        /// No such typed-in parcel of mine (見つかりません).
        case notFound
        /// The parcel changed between the read and the write (the updated_at check found 0 rows).
        case changed
        case failed
        case unknown
    }

    /// updateManualParcel: reads the parcel (id, user_id = me, source = manual), checks the form against
    /// what is stored, then writes only the columns the form changes where id, user_id, source and the
    /// updated_at just read all match, `.select("id")`. A lost answer is unknown and not sent again here.
    func updateManual(id: String, input: ManualParcelInput) async -> ManualEditOutcome {
        guard Self.isUUID(id) else { return .notFound }
        guard let me = await provider.currentUserID() else { return .failed }
        do {
            _ = try await provider.auth.session
        } catch {
            return .failed
        }
        let saved: ManualParcel.Saved
        do {
            let response = try await provider.database.from("parcels")
                .select("status,total_amount,category,ordered_at,expected_date,tracking_number,carrier,requires_presence,updated_at")
                .eq("id", value: id)
                .eq("user_id", value: me)
                .eq("source", value: "manual")
                .execute()
            let rows = try JSONDecoder().decode([ManualParcel.Saved].self, from: response.data)
            guard rows.count <= 1 else { return .failed }
            guard let found = rows.first else { return .notFound }
            saved = found
        } catch {
            return .failed
        }
        let columns: [String: ManualParcel.Column]
        switch ManualParcel.checkEdit(input, saved: saved) {
        case let .invalid(message): return .invalid(message)
        case let .valid(values): columns = values
        }
        // The one write (below): on the version just read, as the signed-in user's typed-in parcel.
        switch await write(id: id, .manualEdit(columns, updatedAt: saved.updatedAt)) {
        case .success: return await announcedEdit(.saved)
        case let .notUpdated(reason): return reason == .conflict ? .changed : .failed
        case .unknown: return await announcedEdit(.unknown)
        }
    }

    private func announcedEdit(_ outcome: ManualEditOutcome) async -> ManualEditOutcome {
        if outcome == .saved || outcome == .unknown { await changes?.publish() }
        return outcome
    }

    /// deleteManualParcel: delete where id, user_id = me and source = manual, `.select("id")`. One row back is
    /// a success; 0 rows is conflict (no such typed-in parcel of mine); a lost answer is unknown.
    func deleteManual(id: String) async -> WriteOutcome<String> {
        guard Self.isUUID(id) else { return .notUpdated(.invalidInput) }
        guard let me = await provider.currentUserID() else { return .notUpdated(.failed) }
        do {
            _ = try await provider.auth.session
        } catch {
            return .notUpdated(.failed)
        }
        let response: PostgrestResponse<Void>
        do {
            response = try await provider.database.from("parcels").delete()
                .eq("id", value: id)
                .eq("user_id", value: me)
                .eq("source", value: "manual")
                .select("id")
                .execute()
        } catch {
            return await announced(Self.outcome(of: error))
        }
        guard let rows = try? JSONDecoder().decode([Inserted].self, from: response.data) else { return await announced(.unknown) }
        guard !rows.isEmpty else { return .notUpdated(.conflict) }
        guard rows.count == 1, let row = rows.first, row.id.lowercased() == id.lowercased() else { return await announced(.unknown) }
        return await announced(.success(row.id))
    }

    // MARK: 「古くなった」 (CX1)

    /// A change made outside this writer (the sample load, clearing everything through the Web's endpoints) tells the
    /// other tabs the same way.
    @MainActor
    static func announceOutsideChange(_ changes: DataChanges?) {
        changes?.publish()
    }

    /// Publishes once when any of the outcomes may have changed a row (a success or an unknown result).
    private func announce<T>(_ outcomes: [WriteOutcome<T>]) async {
        guard let changes, outcomes.contains(where: Self.mayHaveWritten) else { return }
        await changes.publish()
    }

    private func announced<T>(_ outcome: WriteOutcome<T>) async -> WriteOutcome<T> {
        await announce([outcome])
        return outcome
    }

    private static func mayHaveWritten<T>(_ outcome: WriteOutcome<T>) -> Bool {
        switch outcome {
        case .success, .unknown: true
        case .notUpdated: false
        }
    }

    // MARK: the one write

    /// One kind of change; the conditions it is written under follow from it.
    private enum Change {
        /// status → delivered, on the version shown (never from cancelled).
        case deliver(ParcelVersion)
        /// status → a RESTORABLE status, only from delivered at the updated_at given.
        case restore(to: String, deliveredUpdatedAt: String)
        /// category → one of the seven, as the user's choice, only at the updated_at given.
        case category(ParcelCategory, updatedAt: String)
        /// The columns a typed-in parcel's edit form changes (source = manual), only at the updated_at given.
        case manualEdit([String: ManualParcel.Column], updatedAt: String)
    }

    /// The columns asked back from a write.
    private struct Written: Decodable {
        let id: String
        let status: String
        let updatedAt: String

        enum CodingKeys: String, CodingKey {
            case id, status
            case updatedAt = "updated_at"
        }
    }

    /// updated_at, read before a category is written without a version shown.
    private struct Stamp: Decodable {
        let updatedAt: String

        enum CodingKeys: String, CodingKey {
            case updatedAt = "updated_at"
        }
    }

    /// The columns 「届いていない」 reads before it writes.
    private struct ReadBack: Decodable {
        let trackingNumber: String?
        let carrier: String?
        let status: String
        let updatedAt: String

        enum CodingKeys: String, CodingKey {
            case status, carrier
            case trackingNumber = "tracking_number"
            case updatedAt = "updated_at"
        }
    }

    private func write(id: String, _ change: Change) async -> WriteOutcome<ParcelVersion> {
        guard Self.isUUID(id) else { return .notUpdated(.invalidInput) }
        let values: any Encodable
        switch change {
        case let .deliver(shown):
            // Only from a status 「元に戻す」 can return to: never cancelled, never delivered again.
            guard StatusRules.restorable.contains(shown.status), !shown.updatedAt.isEmpty else { return .notUpdated(.invalidInput) }
            values = ["status": "delivered"] as [String: String]
        case let .restore(to, deliveredUpdatedAt):
            guard StatusRules.restorable.contains(to), !deliveredUpdatedAt.isEmpty else { return .notUpdated(.invalidInput) }
            values = ["status": to] as [String: String]
        case let .category(category, updatedAt):
            guard ParcelCategory.allCases.contains(category), !updatedAt.isEmpty else { return .notUpdated(.invalidInput) }
            values = ["category": category.rawValue, "category_source": "user"] as [String: String]
        case let .manualEdit(columns, updatedAt):
            guard !columns.isEmpty, !updatedAt.isEmpty else { return .notUpdated(.invalidInput) }
            values = columns
        }

        // Signed out, or the token could not be refreshed: nothing is sent.
        guard let me = await provider.currentUserID() else { return .notUpdated(.failed) }
        do {
            _ = try await provider.auth.session
        } catch {
            return .notUpdated(.failed)
        }

        let response: PostgrestResponse<Void>
        do {
            var query = try provider.database.from("parcels").update(values)
                .eq("id", value: id)
                .eq("user_id", value: me)
            switch change {
            case let .deliver(shown):
                query = query
                    .neq("status", value: "cancelled")
                    .eq("status", value: shown.status)
                    .eq("updated_at", value: shown.updatedAt)
            case let .restore(_, deliveredUpdatedAt):
                query = query
                    .eq("status", value: "delivered")
                    .eq("updated_at", value: deliveredUpdatedAt)
            case let .category(_, updatedAt):
                query = query.eq("updated_at", value: updatedAt)
            case let .manualEdit(_, updatedAt):
                query = query
                    .eq("source", value: "manual")
                    .eq("updated_at", value: updatedAt)
            }
            response = try await query.select("id,status,updated_at").execute()
        } catch {
            return Self.outcome(of: error)
        }

        // A 2xx answer: the rows the update changed, as an array.
        guard let rows = try? JSONDecoder().decode([Written].self, from: response.data) else {
            // The server said yes but the body is unreadable: whether a row changed is not known.
            return .unknown
        }
        guard !rows.isEmpty else { return .notUpdated(.conflict) }
        guard rows.count == 1, let row = rows.first else { return .notUpdated(.failed) }
        guard row.id.lowercased() == id.lowercased() else { return .unknown }
        return .success(ParcelVersion(id: row.id, status: row.status, updatedAt: row.updatedAt))
    }

    // MARK: helpers

    static func isUUID(_ id: String) -> Bool {
        UUID(uuidString: id) != nil
    }

    /// URL errors raised before the request could leave the device: the write surely did not happen.
    private static let neverSent: Set<URLError.Code> = [
        .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
        .internationalRoamingOff, .dataNotAllowed, .callIsActive, .badURL, .unsupportedURL,
        .appTransportSecurityRequiresSecureConnection, .secureConnectionFailed,
        .serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateHasUnknownRoot,
        .serverCertificateNotYetValid, .clientCertificateRejected, .clientCertificateRequired,
    ]

    /// Codex-P3. An answer from PostgREST with an error: the statement was rolled back (not updated).
    /// No answer after the request may have left (a timeout, a lost connection): unknown. A 5xx whose
    /// body is not PostgREST's error (Cloudflare's 520/522/524, a gateway's 502/504, an HTML 503) came
    /// from something in front of PostgREST, which may have run the update: unknown too. A 4xx that is
    /// not PostgREST's is a refusal before the database: not updated.
    private static func outcome<T>(of error: any Error) -> WriteOutcome<T> {
        switch error {
        case let error as URLError:
            return neverSent.contains(error.code) ? .notUpdated(.failed) : .unknown
        case let error as PostgrestError:
            // PostgREST's own errors always carry a code. A JSON body with only a message is the API
            // gateway's (Kong's 502 "An invalid response was received from the upstream server").
            return error.code == nil ? .unknown : .notUpdated(.failed)
        case let error as HTTPError:
            return (500...599).contains(error.response.statusCode) ? .unknown : .notUpdated(.failed)
        case is CancellationError:
            // Thrown by the client's cancellation check, before anything is sent.
            return .notUpdated(.failed)
        default:
            // Encoding the body, or the session in the fetch: nothing was sent.
            return .notUpdated(.failed)
        }
    }
}
