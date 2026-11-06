// TDD-STUB(task 21, task 22): the delivered and cancelled pages' reads, as src/app/app/delivered/page.tsx and
// cancelled/page.tsx (2541793) read them: user_id = me and status = delivered / cancelled, every row (id
// keyset, 1,000 per request, any failed page fails the read), then put in the Web's database order
// (ordered_at ↓ nulls last; ties by id ↑ so the result never depends on the page order); and every
// parcel_items(parcel_id, name) of user_id = me. A failure is .failed, never an empty list.
// Names and signatures are the contract with StatusListsTests.

import Foundation
import PostgREST

enum ListStatus: String, Sendable {
    case delivered
    case cancelled
}

struct StatusListReader: Sendable {
    static let pageSize = 1000

    let provider: SupabaseProvider

    init(provider: SupabaseProvider) {
        self.provider = provider
    }

    func parcels(_ status: ListStatus) async -> LoadResult<[ParcelRow]> {
        .failed // TDD-STUB(task 21)
    }

    func itemNames() async -> LoadResult<[ParcelItemName]> {
        .failed // TDD-STUB(task 21)
    }

    /// ordered_at descending (code-unit order), nulls last, then id ascending.
    static func webOrder(_ rows: [ParcelRow]) -> [ParcelRow] {
        rows // TDD-STUB(task 21)
    }
}
