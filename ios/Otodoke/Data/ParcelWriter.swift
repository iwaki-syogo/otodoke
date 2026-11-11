// Parcels are written in ParcelWriter only, in three places, each with its conditions fixed inside it:
//  - UPDATE: ONE private function, `write(id:_:)`: the id validated as a UUID, `user_id = me` always,
//    select("id,status,received_at,check_dismissed_at,updated_at"), and exactly one row back or it is not a success. The conditions of
//    each kind of change are built inside that function from the change itself, so a caller cannot
//    leave one out:
//     1. user_id = me on every write
//     2. 「受け取った」 never from cancelled (status != cancelled), and only on the version the screen showed
//     3. back only to a RESTORABLE status, and only from delivered (status = delivered, updated_at as read)
//     4. a category is one of the seven, recorded as the user's (category_source = "user"), and only on
//        the version the screen showed (updated_at as read): a choice whose answer was lost and that
//        reaches the server late never overwrites a later choice (CF1)
//     5. a typed-in parcel's edit (manualEdit): source = manual and the updated_at the form was opened with
//  - INSERT (createManual): one typed-in parcel as the signed-in user (user_id = me, source = manual).
//    A duplicate id (23505) is settled by reading the row (see settleDuplicate): the same is a success; one nobody touched
//    (updated_at == created_at) is written over, on that updated_at, through `write` (manualEdit); one a mail joined is not written.
//  - DELETE (deleteManual): id, user_id = me and source = manual, always.
// updated_at is sent exactly as it was read (a String; supabase-swift percent-encodes its "+").
// No automatic retries (PostgREST's retryEnabled is false), and a result that is unknown is never
// sent again: the caller reads the row again instead.
// The helper for changes made outside this writer (below, in the 「古くなった」 part) only publishes; it writes nothing.

import Foundation
import PostgREST

/// A parcel as the screen saw it: the version a write is conditioned on.
struct ParcelVersion: Equatable, Sendable {
    let id: String
    let status: String
    let updatedAt: String
    let receivedAt: String?
    let checkDismissedAt: String?

    init(id: String, status: String, updatedAt: String, receivedAt: String? = nil, checkDismissedAt: String? = nil) {
        self.id = id
        self.status = status
        self.updatedAt = updatedAt
        self.receivedAt = receivedAt
        self.checkDismissedAt = checkDismissedAt
    }

    init(_ row: ParcelRow) {
        self.init(id: row.id, status: row.status, updatedAt: row.updatedAt, receivedAt: row.receivedAt, checkDismissedAt: row.checkDismissedAt)
    }
}

/// What 「元に戻す」 needs: the status before, and updated_at as the 「受け取った」 write left it.
struct UndoToken: Equatable, Sendable {
    let id: String
    let restoreTo: String
    let deliveredUpdatedAt: String
    let previousReceivedAt: String?
    let previousCheckDismissedAt: String?
    let deliveredReceivedAt: String?

    init(id: String, restoreTo: String, deliveredUpdatedAt: String,
         previousReceivedAt: String? = nil, previousCheckDismissedAt: String? = nil, deliveredReceivedAt: String? = nil) {
        self.id = id
        self.restoreTo = restoreTo
        self.deliveredUpdatedAt = deliveredUpdatedAt
        self.previousReceivedAt = previousReceivedAt
        self.previousCheckDismissedAt = previousCheckDismissedAt
        self.deliveredReceivedAt = deliveredReceivedAt
    }
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

    /// 「受け取った」 on the version shown: status → delivered where id, user_id = me, status != cancelled,
    /// status = shown.status and updated_at = shown.updatedAt (sent verbatim).
    func markDelivered(_ shown: ParcelVersion, now: Date = Date()) async -> WriteOutcome<UndoToken> {
        await announced(deliver(shown, now: now))
    }

    private func deliver(_ shown: ParcelVersion, now: Date) async -> WriteOutcome<UndoToken> {
        let receivedAt = ManualParcel.isoString(now)
        switch await write(id: shown.id, .deliver(shown, receivedAt: receivedAt)) {
        case let .success(after):
            return .success(UndoToken(id: after.id, restoreTo: shown.status, deliveredUpdatedAt: after.updatedAt,
                                      previousReceivedAt: shown.receivedAt, previousCheckDismissedAt: shown.checkDismissedAt,
                                      deliveredReceivedAt: receivedAt))
        case let .notUpdated(reason):
            return .notUpdated(reason)
        case .unknown:
            return .unknown
        }
    }

    /// 「すべて受け取り済みにする」: the single-row write for each, in the order given, one result per id.
    /// `progress` hears how many have been answered after each one (for 「保存中… 12/80」).
    func markDelivered(
        all shown: [ParcelVersion],
        now: Date = Date(),
        progress: (@Sendable (Int) async -> Void)? = nil
    ) async -> [BulkItemResult<UndoToken>] {
        guard shown.count <= Self.maxAtOnce else {
            return shown.map { BulkItemResult(id: $0.id, outcome: .notUpdated(.invalidInput)) }
        }
        var results: [BulkItemResult<UndoToken>] = []
        for version in shown {
            results.append(BulkItemResult(id: version.id, outcome: await deliver(version, now: now)))
            await progress?(results.count)
        }
        await announce(results.map(\.outcome))
        return results
    }

    /// 「元に戻す」: restore the prior status and receipt (RESTORABLE only), where id, user_id = me, status = delivered
    /// and updated_at = token.deliveredUpdatedAt.
    func undoDelivered(_ token: UndoToken) async -> WriteOutcome<ParcelVersion> {
        await announced(restore(token))
    }

    private func restore(_ token: UndoToken) async -> WriteOutcome<ParcelVersion> {
        await write(id: token.id, .restore(to: token.restoreTo, receivedAt: token.previousReceivedAt, checkDismissedAt: token.previousCheckDismissedAt, deliveredUpdatedAt: token.deliveredUpdatedAt))
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
        return await announced(write(id: id, .notDelivered(to: to, updatedAt: row.updatedAt)))
    }

    /// 受け取っていない: reads now, then clears received_at on that exact version. An answer after
    /// day 14 also records まだ; an earlier answer is still asked once on day 14.
    func markNotReceived(id: String, now: Date = Date()) async -> WriteOutcome<ParcelVersion> {
        guard Self.isUUID(id) else { return .notUpdated(.invalidInput) }
        let row: ParcelRow
        switch await ParcelReader(provider: provider).parcel(id: id) {
        case let .loaded(found?): row = found
        case .loaded(nil): return .notUpdated(.conflict)
        case .failed: return .notUpdated(.failed)
        }
        guard ParcelRules.isReceived(row) else { return .notUpdated(.conflict) }
        let asked = ParcelRules.deliveryNeedsCheck(expectedDate: row.expectedDate, expectedDateEnd: row.expectedDateEnd,
                                                   lastEmailAt: row.lastEmailAt, today: Format.todayJst(now: now))
        return await announced(write(id: id, .notReceived(checkDismissedAt: asked ? ManualParcel.isoString(now) : nil,
                                                        updatedAt: row.updatedAt)))
    }

    /// まだ: a delivered, unreceived parcel only, on the version just read. The null condition is
    /// repeated on the update so another answer cannot be overwritten.
    func dismissCheck(id: String, now: Date = Date()) async -> WriteOutcome<ParcelVersion> {
        guard Self.isUUID(id) else { return .notUpdated(.invalidInput) }
        let row: ParcelRow
        switch await ParcelReader(provider: provider).parcel(id: id) {
        case let .loaded(found?): row = found
        case .loaded(nil): return .notUpdated(.conflict)
        case .failed: return .notUpdated(.failed)
        }
        guard row.status == "delivered", row.receivedAt == nil else { return .notUpdated(.conflict) }
        return await announced(write(id: id, .dismissCheck(ManualParcel.isoString(now), updatedAt: row.updatedAt)))
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
            // The stored row is read: the same is made; one nobody touched is written over with what is typed now; one a mail joined is not.
            if let id = mine.id, let failure = error as? PostgrestError, failure.code == "23505" {
                return await announced(await settleDuplicate(of: mine, id: id, me: me))
            }
            return await announced(Self.outcome(of: error))
        }
        guard let rows = try? JSONDecoder().decode([Inserted].self, from: response.data), rows.count == 1, let created = rows.first else {
            // The server said yes but the body is not one row: whether a parcel was made is not known.
            return await announced(.unknown)
        }
        return await announced(.success(created.id))
    }

    /// The columns of a new typed-in parcel that its form sets, and the two times (read back to compare).
    private struct StoredNew: Decodable {
        let title: String?
        let shop: String?
        let orderedAt: String?
        let expectedDate: String?
        let totalAmount: Int?
        let category: String?
        let categorySource: String?
        let trackingNumber: String?
        let carrier: String?
        let requiresPresence: Bool?
        let status: String
        let createdAt: String
        let updatedAt: String
        let receivedAt: String?

        enum CodingKeys: String, CodingKey {
            case title, shop, category, carrier, status
            case receivedAt = "received_at"
            case orderedAt = "ordered_at"
            case expectedDate = "expected_date"
            case totalAmount = "total_amount"
            case categorySource = "category_source"
            case trackingNumber = "tracking_number"
            case requiresPresence = "requires_presence"
            case createdAt = "created_at"
            case updatedAt = "updated_at"
        }
    }

    /// 23505 on an insert that carried an id: the row with that id (mine, typed in) is read as the signed-in user. An
    /// earlier send of this form made it (its answer was lost). Then:
    ///  - the row is what this form says: a success, nothing is written;
    ///  - it differs and updated_at == created_at: nobody touched it since it was made (the insert sends neither, so both are the
    ///    one now() of the insert, init.sql:61-62; every later update moves updated_at on, init.sql:95-102), so what is typed
    ///    now is written over it, on that updated_at (0 rows: someone just did, `.notUpdated(.conflict)`);
    ///  - it differs and updated_at != created_at: a mail (or the Web) joined it. Nothing is written, `.notUpdated(.conflict)`:
    ///    the parcel exists, and opening it again shows it.
    /// Not readable: unknown, so the form says it could not be confirmed and the list is read again.
    private func settleDuplicate(of row: ManualParcelRow, id: String, me: String) async -> WriteOutcome<String> {
        guard Self.isUUID(id) else { return .notUpdated(.invalidInput) }
        let stored: StoredNew
        do {
            let response = try await provider.database.from("parcels")
                .select("title,shop,ordered_at,expected_date,total_amount,category,category_source,tracking_number,carrier,requires_presence,status,received_at,created_at,updated_at")
                .eq("id", value: id)
                .eq("user_id", value: me)
                .eq("source", value: "manual")
                .execute()
            let rows = try JSONDecoder().decode([StoredNew].self, from: response.data)
            // Not there for me although the id is taken: it is not mine, so this is not a success.
            guard rows.count <= 1 else { return .unknown }
            guard let found = rows.first else { return .notUpdated(.failed) }
            stored = found
        } catch {
            return .unknown
        }
        let same = stored.title == row.title && stored.shop == row.shop && stored.orderedAt == row.orderedAt
            && stored.expectedDate == row.expectedDate && stored.totalAmount == row.totalAmount
            && stored.category == row.category && stored.categorySource == row.categorySource
            && stored.trackingNumber == row.trackingNumber && stored.carrier == row.carrier
            && stored.requiresPresence == row.requiresPresence && stored.status == row.status
            && (stored.receivedAt == row.receivedAt
                || (row.receivedAt == ParcelRules.receivedAtNone && stored.receivedAt == nil)
                || (ParcelRules.isReceivedAt(row.receivedAt) && ParcelRules.isReceivedAt(stored.receivedAt)))
        if same { return .success(id) }
        // A mail joined it: not the form's to write over.
        guard stored.updatedAt == stored.createdAt else { return .notUpdated(.conflict) }
        var columns: [String: ManualParcel.Column] = [
            "title": .text(row.title),
            "shop": .text(row.shop),
            "shop_key": .text(row.shopKey),
            "ordered_at": .text(row.orderedAt),
            "expected_date": ManualParcel.Column(row.expectedDate),
            "total_amount": ManualParcel.Column(row.totalAmount),
            "category": ManualParcel.Column(row.category),
            "category_source": ManualParcel.Column(row.categorySource),
            "tracking_number": ManualParcel.Column(row.trackingNumber),
            "carrier": ManualParcel.Column(row.carrier),
            "requires_presence": ManualParcel.Column(row.requiresPresence),
            "status": .text(row.status),
        ]
        if let receivedAt = row.receivedAt { columns["received_at"] = .text(receivedAt) }
        switch await write(id: id, .manualEdit(columns, updatedAt: stored.updatedAt)) {
        case .success: return .success(id)
        case let .notUpdated(reason): return .notUpdated(reason)
        case .unknown: return .unknown
        }
    }

    // MARK: an edit and a delete of a typed-in parcel

    /// The two text columns the edit compares with the form (ManualParcel.Saved does not carry them).
    private struct StoredNames: Decodable {
        let title: String?
        let shop: String?
    }

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
    /// what is stored, then writes only the columns the form changes where id, user_id, source and
    /// `openedUpdatedAt` all match, `.select("id")`. `openedUpdatedAt` is the updated_at the form was opened
    /// with (as the Web's hidden field carries it): a parcel updated since then is not overwritten (nothing is
    /// written, `.changed`) ... unless the form already says exactly what is stored (an earlier press of this form
    /// went through and its answer was lost): that is `.saved` and nothing is written. A lost answer is unknown and
    /// not sent again here.
    func updateManual(id: String, input: ManualParcelInput, openedUpdatedAt: String, now: Date = Date()) async -> ManualEditOutcome {
        guard Self.isUUID(id) else { return .notFound }
        guard let me = await provider.currentUserID() else { return .failed }
        do {
            _ = try await provider.auth.session
        } catch {
            return .failed
        }
        let saved: ManualParcel.Saved
        let storedNames: StoredNames
        do {
            let response = try await provider.database.from("parcels")
                .select("title,shop,status,total_amount,category,ordered_at,expected_date,tracking_number,carrier,requires_presence,received_at,expected_date_end,last_email_at,updated_at")
                .eq("id", value: id)
                .eq("user_id", value: me)
                .eq("source", value: "manual")
                .execute()
            let rows = try JSONDecoder().decode([ManualParcel.Saved].self, from: response.data)
            let names = try JSONDecoder().decode([StoredNames].self, from: response.data)
            guard rows.count <= 1, names.count == rows.count else { return .failed }
            guard let found = rows.first, let foundNames = names.first else { return .notFound }
            saved = found
            storedNames = foundNames
        } catch {
            return .failed
        }
        // No version to compare: nothing is written.
        guard !openedUpdatedAt.isEmpty else { return .changed }
        let stale = openedUpdatedAt != saved.updatedAt
        let columns: [String: ManualParcel.Column]
        switch ManualParcel.checkEdit(input, saved: saved, now: now) {
        case let .invalid(message):
            // Stale first, as the Web checks the version before the form.
            return stale ? .changed : .invalid(message)
        case let .valid(values):
            if stale {
                // Changed since the form was opened. When the form says exactly what is stored, an earlier press went
                // through (its answer was lost): nothing is left to write, so it is saved. Otherwise a mail or the Web
                // changed something the form would set back: nothing is written.
                return ManualParcel.writesNothing(values, saved: saved, title: storedNames.title, shop: storedNames.shop) ? .saved : .changed
            }
            columns = values
        }
        // The one write (below): on the version the form was opened with, as the signed-in user's typed-in parcel.
        switch await write(id: id, .manualEdit(columns, updatedAt: openedUpdatedAt)) {
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
        case deliver(ParcelVersion, receivedAt: String)
        /// status → a RESTORABLE status, only from delivered at the updated_at given.
        case restore(to: String, receivedAt: String?, checkDismissedAt: String?, deliveredUpdatedAt: String)
        case notDelivered(to: String, updatedAt: String)
        case notReceived(checkDismissedAt: String?, updatedAt: String)
        case dismissCheck(String, updatedAt: String)
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
        let receivedAt: String?
        let checkDismissedAt: String?

        enum CodingKeys: String, CodingKey {
            case id, status
            case receivedAt = "received_at"
            case checkDismissedAt = "check_dismissed_at"
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
        case let .deliver(shown, receivedAt):
            guard StatusRules.restorable.contains(shown.status), !shown.updatedAt.isEmpty else { return .notUpdated(.invalidInput) }
            values = ["status": "delivered", "received_at": receivedAt] as [String: String]
        case let .restore(to, receivedAt, checkDismissedAt, deliveredUpdatedAt):
            guard StatusRules.restorable.contains(to), !deliveredUpdatedAt.isEmpty,
                  receivedAt == nil || (to == "delivered" && ParcelRules.isReceivedAt(receivedAt)) else { return .notUpdated(.invalidInput) }
            values = ["status": .text(to), "received_at": ManualParcel.Column(receivedAt),
                      "check_dismissed_at": ManualParcel.Column(to == "delivered" ? checkDismissedAt : nil)] as [String: ManualParcel.Column]
        case let .notDelivered(to, updatedAt):
            guard StatusRules.restorable.contains(to), to != "delivered", !updatedAt.isEmpty else { return .notUpdated(.invalidInput) }
            values = ["status": .text(to), "received_at": .null] as [String: ManualParcel.Column]
        case let .notReceived(checkDismissedAt, updatedAt):
            guard !updatedAt.isEmpty else { return .notUpdated(.invalidInput) }
            var columns: [String: ManualParcel.Column] = ["received_at": .null]
            if let checkDismissedAt { columns["check_dismissed_at"] = .text(checkDismissedAt) }
            values = columns
        case let .dismissCheck(at, updatedAt):
            guard !updatedAt.isEmpty else { return .notUpdated(.invalidInput) }
            values = ["check_dismissed_at": at] as [String: String]
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
            case let .deliver(shown, _):
                query = query
                    .neq("status", value: "cancelled")
                    .eq("status", value: shown.status)
                    .eq("updated_at", value: shown.updatedAt)
            case let .restore(_, _, _, deliveredUpdatedAt):
                query = query
                    .eq("status", value: "delivered")
                    .not("received_at", operator: .is, value: "null")
                    .eq("updated_at", value: deliveredUpdatedAt)
            case let .notDelivered(_, updatedAt), let .notReceived(_, updatedAt):
                query = query.eq("status", value: "delivered").eq("updated_at", value: updatedAt)
            case let .dismissCheck(_, updatedAt):
                query = query.eq("status", value: "delivered").filter("received_at", operator: "is", value: "null")
                    .eq("updated_at", value: updatedAt)
            case let .category(_, updatedAt):
                query = query.eq("updated_at", value: updatedAt)
            case let .manualEdit(_, updatedAt):
                query = query
                    .eq("source", value: "manual")
                    .eq("updated_at", value: updatedAt)
            }
            response = try await query.select("id,status,received_at,check_dismissed_at,updated_at").execute()
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
        return .success(ParcelVersion(id: row.id, status: row.status, updatedAt: row.updatedAt, receivedAt: row.receivedAt, checkDismissedAt: row.checkDismissedAt))
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
