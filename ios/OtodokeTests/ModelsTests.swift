import Foundation
import Testing
@testable import Otodoke

/// [Task 4] The rows decode from PostgREST's JSON with a plain JSONDecoder(), and every time column
/// stays the exact text the server sent (updated_at is sent back verbatim by the writer).
@Suite("Models (task 4)")
struct ModelsTests {
    @Test func aParcelRowDecodesEveryColumn() throws {
        let row = try Rows.parcelRow(Rows.parcel(7, [
            "shop_key": "amazon",
            "title": "テスト品",
            "status": "out_for_delivery",
            "source": "manual",
            "category": "food",
            "category_source": "user",
            "carrier": "ヤマト運輸",
            "tracking_number": "1234-5678-9012",
            "tracking_url": "https://example.com/t/1",
            "order_number": "250-0000000-0000000",
            "ordered_at": "2026-10-30",
            "expected_date": "2026-11-05",
            "expected_date_end": "2026-11-07",
            "expected_text": "11月5日〜7日",
            "expected_window_start": "08:00:00",
            "expected_window_end": "12:00:00",
            "last_email_at": "2026-11-03T22:10:00.5+00:00",
            "needs_review": true,
            "requires_presence": false,
            "presence_evidence": "置き配",
            "total_amount": 12_345,
            "created_at": "2026-11-01T00:00:00+00:00",
            "updated_at": "2026-11-04T03:21:09.123456+00:00",
        ]))
        #expect(row.id == Rows.id(7))
        #expect(row.userId == FakeSupabase.me)
        #expect(row.shopKey == "amazon")
        #expect(row.title == "テスト品")
        #expect(row.status == "out_for_delivery")
        #expect(row.source == "manual")
        #expect(row.category == "food")
        #expect(row.categorySource == "user")
        #expect(row.carrier == "ヤマト運輸")
        #expect(row.trackingNumber == "1234-5678-9012")
        #expect(row.trackingUrl == "https://example.com/t/1")
        #expect(row.orderNumber == "250-0000000-0000000")
        #expect(row.orderedAt == "2026-10-30")
        #expect(row.expectedDate == "2026-11-05")
        #expect(row.expectedDateEnd == "2026-11-07")
        #expect(row.expectedText == "11月5日〜7日")
        #expect(row.expectedWindowStart == "08:00:00")
        #expect(row.expectedWindowEnd == "12:00:00")
        #expect(row.lastEmailAt == "2026-11-03T22:10:00.5+00:00")
        #expect(row.needsReview == true)
        #expect(row.requiresPresence == false)
        #expect(row.presenceEvidence == "置き配")
        #expect(row.totalAmount == 12_345)
        #expect(row.createdAt == "2026-11-01T00:00:00+00:00")
        #expect(row.updatedAt == "2026-11-04T03:21:09.123456+00:00")
    }

    @Test func updatedAtIsTextNotADate() throws {
        let row = try Rows.parcelRow(Rows.parcel(1, ["updated_at": "2026-11-04T03:21:09.123456+00:00"]))
        let text: String = row.updatedAt
        #expect(text == "2026-11-04T03:21:09.123456+00:00")
    }

    @Test func nullColumnsDecodeAsNil() throws {
        let row = try Rows.parcelRow(Rows.parcel(1))
        #expect(row.title == "品名1")
        #expect(row.expectedDate == nil)
        #expect(row.requiresPresence == nil)
        #expect(row.totalAmount == nil)
    }

    @Test func anItemDecodes() throws {
        let item = try JSONCoding.decode(ParcelItemRow.self, .object(Rows.item(1, parcel: 3, ["quantity": nil, "unit_price": 980])))
        #expect(item.parcelId == Rows.id(3))
        #expect(item.name == "品目1")
        #expect(item.quantity == nil)
        #expect(item.unitPrice == 980)
        #expect(item.createdAt == "2026-11-01T00:00:00+00:00")
    }

    @Test func anExtractionDecodesItsMailAsAnObject() throws {
        let x = try JSONCoding.decode(ExtractionWithEmail.self, .object(Rows.extraction(1, parcel: 3, email: Rows.email(1, ["from_name": nil]), [
            "confidence": 0.87,
            "result": ["notes": "金額は発送メールから", "other": 1],
        ])))
        #expect(x.id == Rows.id(20_001))
        #expect(x.confidence == 0.87)
        #expect(x.notes == "金額は発送メールから")
        let email = try #require(x.email)
        #expect(email.id == Rows.id(30_001))
        #expect(email.subject == "件名1")
        #expect(email.fromAddress == "shop@example.com")
        #expect(email.fromName == nil)
        #expect(email.sentAt == "2026-11-01T00:00:00+00:00")
        #expect(email.classification == "shipped")
        #expect(email.textBody == "本文")
        #expect(email.htmlBody == nil)
    }

    @Test func anExtractionDecodesItsMailAsAnArray() throws {
        let x = try JSONCoding.decode(ExtractionWithEmail.self, .object(Rows.extraction(2, parcel: 3, email: [Rows.email(2)])))
        #expect(x.email?.id == Rows.id(30_002))
    }

    @Test func anExtractionWithoutMailOrNotes() throws {
        let x = try JSONCoding.decode(ExtractionWithEmail.self, .object(Rows.extraction(3, parcel: 3, email: nil, ["confidence": nil, "result": nil])))
        #expect(x.email == nil)
        #expect(x.confidence == nil)
        #expect(x.notes == nil)
        let y = try JSONCoding.decode(ExtractionWithEmail.self, .object(Rows.extraction(4, parcel: 3, email: [], ["result": ["notes": 3]])))
        #expect(y.email == nil)
        #expect(y.notes == nil)
    }

    @Test func anInboxAddressDecodes() throws {
        let row = try JSONCoding.decode(InboxAddressRow.self, ["id": "x", "user_id": .string(FakeSupabase.me), "local_part": "abcdefghjk", "created_at": "2026-11-01T00:00:00+00:00"])
        #expect(row.userId == FakeSupabase.me)
        #expect(row.localPart == "abcdefghjk")
    }

    @Test func loadResultTellsFailureFromEmpty() {
        let empty: LoadResult<[Int]> = .loaded([])
        let failed: LoadResult<[Int]> = .failed
        #expect(empty != failed)
        #expect(empty.value == [])
        #expect(failed.value == nil)
    }
}
