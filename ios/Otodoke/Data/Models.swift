// Rows decode with a plain JSONDecoder() from the database's snake_case JSON (explicit CodingKeys).
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
    var receivedAt: String? = nil
    var checkDismissedAt: String? = nil

    enum CodingKeys: String, CodingKey {
        case id
        case userId = "user_id"
        case shop
        case shopKey = "shop_key"
        case title
        case status
        case source
        case category
        case categorySource = "category_source"
        case carrier
        case trackingNumber = "tracking_number"
        case trackingUrl = "tracking_url"
        case orderNumber = "order_number"
        case orderedAt = "ordered_at"
        case expectedDate = "expected_date"
        case expectedDateEnd = "expected_date_end"
        case expectedText = "expected_text"
        case expectedWindowStart = "expected_window_start"
        case expectedWindowEnd = "expected_window_end"
        case lastEmailAt = "last_email_at"
        case needsReview = "needs_review"
        case requiresPresence = "requires_presence"
        case presenceEvidence = "presence_evidence"
        case totalAmount = "total_amount"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case receivedAt = "received_at"
        case checkDismissedAt = "check_dismissed_at"
    }
}

/// public.parcel_items.
struct ParcelItemRow: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var parcelId: String
    var name: String
    var quantity: Int?
    var unitPrice: Int?
    var createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case parcelId = "parcel_id"
        case name
        case quantity
        case unitPrice = "unit_price"
        case createdAt = "created_at"
    }
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
    /// emails.body_state ("plain" / "sealed" / "dropped", any other value kept as it came; null is plain)
    /// and emails.from_domain. A sealed or dropped mail has subject, from_*, text_body and html_body null.
    var bodyState: String? = nil
    var fromDomain: String? = nil

    enum CodingKeys: String, CodingKey {
        case id
        case subject
        case fromAddress = "from_address"
        case fromName = "from_name"
        case fromDomain = "from_domain"
        case sentAt = "sent_at"
        case classification
        case bodyState = "body_state"
        case textBody = "text_body"
        case htmlBody = "html_body"
    }
}

/// public.extractions with its mail embedded (`emails(...)` may come back as an object, an array or null;
/// an array gives its first mail, as the Web's detail page does).
/// `notes` is `result.notes` when it is a string.
struct ExtractionWithEmail: Decodable, Equatable, Sendable {
    var id: String
    var confidence: Double?
    var createdAt: String
    var notes: String?
    var relevance: String? = nil
    var relevanceEvidence: String? = nil
    var email: EmailSummary?

    private enum CodingKeys: String, CodingKey {
        case id
        case confidence
        case createdAt = "created_at"
        case result
        case emails
    }

    private enum ResultKeys: String, CodingKey {
        case notes, relevance
        case relevanceEvidence = "relevance_evidence"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        confidence = try c.decodeIfPresent(Double.self, forKey: .confidence)
        createdAt = try c.decode(String.self, forKey: .createdAt)

        // result is free-form JSON: only a string `notes` inside an object counts.
        if let result = try? c.nestedContainer(keyedBy: ResultKeys.self, forKey: .result) {
            notes = try? result.decodeIfPresent(String.self, forKey: .notes)
            relevance = try? result.decodeIfPresent(String.self, forKey: .relevance)
            relevanceEvidence = try? result.decodeIfPresent(String.self, forKey: .relevanceEvidence)
        } else {
            notes = nil
        }

        let noMail = try !c.contains(.emails) || c.decodeNil(forKey: .emails)
        if noMail {
            email = nil
        } else if let one = try? c.decode(EmailSummary.self, forKey: .emails) {
            email = one
        } else {
            email = try c.decode([EmailSummary].self, forKey: .emails).first
        }
    }
}

/// public.inbox_addresses.
struct InboxAddressRow: Codable, Equatable, Sendable {
    var userId: String
    var localPart: String

    enum CodingKeys: String, CodingKey {
        case userId = "user_id"
        case localPart = "local_part"
    }
}
