// The delivered and cancelled pages' reads, as src/app/app/delivered/page.tsx and cancelled/page.tsx
// (2541793) read them: user_id = me and status = delivered / cancelled, every row (id keyset, 1,000 per
// request, any failed page fails the read), then put in the Web's database order (ordered_at ↓ nulls last;
// ties by id ↑ so the result never depends on the page order); and every parcel_items(parcel_id, name) of
// user_id = me. A failure is .failed, never an empty list.

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

    /// Every parcel of the signed-in user with this status, in the Web's order.
    func parcels(_ status: ListStatus) async -> LoadResult<[ParcelRow]> {
        guard let me = await provider.currentUserID() else { return .failed }
        let rows: [ParcelRow]? = await Self.readAll(id: \.id) { after in
            var query = provider.database.from("parcels").select("*").eq("user_id", value: me)
            if status == .delivered {
                query = query.not("received_at", operator: .is, value: "null").neq("status", value: "cancelled")
            } else {
                query = query.eq("status", value: status.rawValue)
            }
            if let after { query = query.gt("id", value: after) }
            return query.order("id", ascending: true).limit(Self.pageSize)
        }
        guard let rows else { return .failed }
        return .loaded(Self.webOrder(status == .delivered ? rows.filter { ParcelRules.isReceivedAt($0.receivedAt) } : rows))
    }

    /// Every parcel_items(parcel_id, name) of the signed-in user (the search reads item names).
    func itemNames() async -> LoadResult<[ParcelItemName]> {
        guard let me = await provider.currentUserID() else { return .failed }
        let rows: [ItemRow]? = await Self.readAll(id: \.id) { after in
            var query = provider.database.from("parcel_items").select("id,parcel_id,name").eq("user_id", value: me)
            if let after { query = query.gt("id", value: after) }
            return query.order("id", ascending: true).limit(Self.pageSize)
        }
        guard let rows else { return .failed }
        return .loaded(rows.map { ParcelItemName(parcelId: $0.parcelId, name: $0.name) })
    }

    /// ordered_at descending (code-unit order), nulls last, then id ascending.
    static func webOrder(_ rows: [ParcelRow]) -> [ParcelRow] {
        rows.sorted { a, b in
            switch (a.orderedAt, b.orderedAt) {
            case let (x?, y?) where !JSText.equal(x, y):
                return JSText.less(y, x)
            case (.some, nil):
                return true
            case (nil, .some):
                return false
            default:
                return JSText.less(a.id, b.id)
            }
        }
    }

    // MARK: helpers

    /// parcel_items with the id the keyset needs.
    private struct ItemRow: Decodable {
        let id: String
        let parcelId: String
        let name: String

        enum CodingKeys: String, CodingKey {
            case id
            case parcelId = "parcel_id"
            case name
        }
    }

    /// Pages by `id > last id` until a page comes back shorter than pageSize; nil when any page failed.
    private static func readAll<Row: Decodable>(id: KeyPath<Row, String>, page: (String?) -> PostgrestBuilder) async -> [Row]? {
        var rows: [Row] = []
        var after: String?
        while true {
            guard let next: [Row] = await decoded(page(after)) else { return nil }
            rows.append(contentsOf: next)
            guard next.count >= pageSize, let last = next.last else { return rows }
            after = last[keyPath: id]
        }
    }

    /// The rows of a 2xx answer; nil for any failure (an error answer, no answer, a body that does not decode).
    private static func decoded<T: Decodable>(_ request: PostgrestBuilder) async -> T? {
        do {
            let response = try await request.execute()
            return try JSONDecoder().decode(T.self, from: response.data)
        } catch {
            return nil
        }
    }
}
