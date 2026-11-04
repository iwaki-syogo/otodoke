// Reads with the signed-in user's JWT. Every read returns a LoadResult: a failed read is .failed,
// never an empty list or a zero. No retries (PostgREST's retryEnabled is false); signed out sends nothing.

import Foundation
import PostgREST

/// The three counts under the list. Each fails on its own; a failure is .failed, never 0.
struct ParcelCounts: Equatable, Sendable {
    var delivered: LoadResult<Int>
    var cancelled: LoadResult<Int>
    var unread: LoadResult<Int>
}

struct ParcelReader: Sendable {
    /// Rows per request (PostgREST's cap).
    static let pageSize = 1000

    /// The extraction columns and the embedded mail, as the Web's detail page selects them.
    static let extractionColumns =
        "id, confidence, result, created_at, emails(id, subject, from_address, from_name, sent_at, classification, text_body, html_body)"

    let provider: SupabaseProvider

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    /// Every parcel of the signed-in user (`user_id = me`), id ascending, 1,000 per request, the next
    /// page by `id > last id` until a page comes back shorter than 1,000. Any failed page fails the
    /// whole read: never a partial list.
    func allParcels() async -> LoadResult<[ParcelRow]> {
        guard let me = await provider.currentUserID() else { return .failed }
        var rows: [ParcelRow] = []
        var after: String?
        while true {
            var query = provider.database.from("parcels").select("*").eq("user_id", value: me)
            if let after { query = query.gt("id", value: after) }
            let request = query.order("id", ascending: true).limit(Self.pageSize)
            guard let page: [ParcelRow] = await Self.decoded(request) else { return .failed }
            rows.append(contentsOf: page)
            // A short page is the last one. The total is not taken from a count: rows added while
            // reading would otherwise be cut off or make the read fail.
            guard page.count >= Self.pageSize, let last = page.last else { return .loaded(rows) }
            after = last.id
        }
    }

    /// delivered / cancelled: `count=exact` (head) with user_id and status; unread: emails with the
    /// `or` filter StatusRules.unreadFilter(now:).
    func counts(now: Date) async -> ParcelCounts {
        guard let me = await provider.currentUserID() else {
            return ParcelCounts(delivered: .failed, cancelled: .failed, unread: .failed)
        }
        async let delivered = statusCount(me: me, status: "delivered")
        async let cancelled = statusCount(me: me, status: "cancelled")
        async let unread = Self.count(
            provider.database.from("emails").select("id", head: true, count: .exact).or(StatusRules.unreadFilter(now: now))
        )
        return await ParcelCounts(delivered: delivered, cancelled: cancelled, unread: unread)
    }

    /// .loaded(nil) when there is no such parcel; .failed when the read failed.
    func parcel(id: String) async -> LoadResult<ParcelRow?> {
        // Postgres answers a malformed id with an error: that is a parcel that is not there.
        guard UUID(uuidString: id) != nil else { return .loaded(nil) }
        let request = provider.database.from("parcels").select("*").eq("id", value: id)
        guard let rows: [ParcelRow] = await Self.decoded(request) else { return .failed }
        return .loaded(rows.first)
    }

    /// parcel_items of the parcel, created_at ascending.
    func items(parcelID: String) async -> LoadResult<[ParcelItemRow]> {
        guard UUID(uuidString: parcelID) != nil else { return .loaded([]) }
        let request = provider.database.from("parcel_items").select("*").eq("parcel_id", value: parcelID)
            .order("created_at", ascending: true)
        guard let rows: [ParcelItemRow] = await Self.decoded(request) else { return .failed }
        return .loaded(rows)
    }

    /// extractions of the parcel with `emails(id, subject, from_address, from_name, sent_at,
    /// classification, text_body, html_body)` embedded, as the Web's detail page selects.
    func extractions(parcelID: String) async -> LoadResult<[ExtractionWithEmail]> {
        guard UUID(uuidString: parcelID) != nil else { return .loaded([]) }
        let request = provider.database.from("extractions").select(Self.extractionColumns).eq("parcel_id", value: parcelID)
        guard let rows: [ExtractionWithEmail] = await Self.decoded(request) else { return .failed }
        return .loaded(rows)
    }

    // MARK: helpers

    private func statusCount(me: String, status: String) async -> LoadResult<Int> {
        await Self.count(
            provider.database.from("parcels").select("id", head: true, count: .exact)
                .eq("user_id", value: me).eq("status", value: status)
        )
    }

    /// The rows of a 2xx answer, decoded with a plain JSONDecoder (Models use explicit CodingKeys).
    /// nil for any failure: an error answer, no answer, a session that is missing, or a body that
    /// does not decode.
    private static func decoded<T: Decodable>(_ request: PostgrestBuilder) async -> T? {
        do {
            let response = try await request.execute()
            return try JSONDecoder().decode(T.self, from: response.data)
        } catch {
            return nil
        }
    }

    /// The exact count from Content-Range. A failed request or a missing count is .failed, never 0.
    private static func count(_ request: PostgrestBuilder) async -> LoadResult<Int> {
        guard let response = try? await request.execute(), let count = response.count else { return .failed }
        return .loaded(count)
    }
}
