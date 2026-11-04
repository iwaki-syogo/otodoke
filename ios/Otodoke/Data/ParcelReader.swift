// TDD-STUB(task 6): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.

import Foundation

/// The three counts under the list. Each fails on its own; a failure is .failed, never 0.
struct ParcelCounts: Equatable, Sendable {
    var delivered: LoadResult<Int>
    var cancelled: LoadResult<Int>
    var unread: LoadResult<Int>
}

struct ParcelReader: Sendable {
    /// Rows per request (PostgREST's cap).
    static let pageSize = 1000

    let provider: SupabaseProvider

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    /// Every parcel of the signed-in user (`user_id = me`), id ascending, 1,000 per request, the next
    /// page by `id > last id` until a page comes back shorter than 1,000. Any failed page fails the
    /// whole read: never a partial list.
    func allParcels() async -> LoadResult<[ParcelRow]> { .failed }

    /// delivered / cancelled: `count=exact` (head) with user_id and status; unread: emails with the
    /// `or` filter StatusRules.unreadFilter(now:).
    func counts(now: Date) async -> ParcelCounts {
        ParcelCounts(delivered: .failed, cancelled: .failed, unread: .failed)
    }

    /// .loaded(nil) when there is no such parcel; .failed when the read failed.
    func parcel(id: String) async -> LoadResult<ParcelRow?> { .failed }

    /// parcel_items of the parcel, created_at ascending.
    func items(parcelID: String) async -> LoadResult<[ParcelItemRow]> { .failed }

    /// extractions of the parcel with `emails(id, subject, from_address, from_name, sent_at,
    /// classification, text_body, html_body)` embedded, as the Web's detail page selects.
    func extractions(parcelID: String) async -> LoadResult<[ExtractionWithEmail]> { .failed }
}
