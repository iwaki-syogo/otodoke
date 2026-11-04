// TDD-STUB(task 4): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Rows decode with a plain JSONDecoder() from the database's snake_case JSON (add CodingKeys).
// Every date and time column stays a String exactly as PostgREST sent it (updated_at above all:
// it is sent back verbatim as the optimistic-check value).

import Foundation

/// A read that can fail, told apart from an empty or missing value by its type.
enum LoadResult<Value> {
    case loaded(Value)
    case failed
}

extension LoadResult: Equatable where Value: Equatable {}
extension LoadResult: Sendable where Value: Sendable {}

extension LoadResult {
    var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }
}

/// public.parcels, every column.
struct ParcelRow: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var userId: String
    var shop: String
    var shopKey: String?
    var title: String?
    var status: String
    var source: String
    var category: String?
    var categorySource: String?
    var carrier: String?
    var trackingNumber: String?
    var trackingUrl: String?
    var orderNumber: String?
    var orderedAt: String?
    var expectedDate: String?
    var expectedDateEnd: String?
    var expectedText: String?
    var expectedWindowStart: String?
    var expectedWindowEnd: String?
    var lastEmailAt: String?
    var needsReview: Bool
    var requiresPresence: Bool?
    var presenceEvidence: String?
    var totalAmount: Int?
    var createdAt: String
    var updatedAt: String
}

/// public.parcel_items.
struct ParcelItemRow: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var parcelId: String
    var name: String
    var quantity: Int?
    var unitPrice: Int?
    var createdAt: String
}

/// The embedded public.emails columns the detail page reads.
struct EmailSummary: Decodable, Equatable, Sendable {
    var id: String
    var subject: String?
    var fromAddress: String?
    var fromName: String?
    var sentAt: String?
    var classification: String?
    var textBody: String?
    var htmlBody: String?
}

/// public.extractions with its mail embedded (`emails(...)` may come back as an object, an array or null).
/// `notes` is `result.notes` when it is a string.
struct ExtractionWithEmail: Decodable, Equatable, Sendable {
    var id: String
    var confidence: Double?
    var createdAt: String
    var notes: String?
    var email: EmailSummary?

    init(from decoder: Decoder) throws {
        id = ""
        confidence = nil
        createdAt = ""
        notes = nil
        email = nil
    }
}

/// public.inbox_addresses.
struct InboxAddressRow: Codable, Equatable, Sendable {
    var userId: String
    var localPart: String
}
