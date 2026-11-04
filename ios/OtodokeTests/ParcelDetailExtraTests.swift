import Foundation
import Testing
@testable import Otodoke

/// [Task 8, implementer's own] The detail page's writes when the answer is lost (Codex-P3), the Web's
/// words for 0 rows, the form the in-app web view posts, and the item line.
@Suite("ParcelDetail extra (task 8)")
@MainActor
struct ParcelDetailExtraTests {
    private func model(_ fake: FakeSupabase) async throws -> ParcelDetailModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
    }

    private func seeded(status: String = "delivered") async throws -> (FakeSupabase, ParcelDetailModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": .string(status), "tracking_number": "1234-5678-9012", "category": "food"])])
        let model = try await model(fake)
        await model.load()
        return (fake, model)
    }

    // MARK: 届いていない

    @Test func notDeliveredWithTheAnswerLostReadsTheRowInsteadOfSendingAgain() async throws {
        let (fake, model) = try await seeded()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.notDeliveredError == nil)
        #expect(model.row?.status == "shipped")
        #expect(model.showsNotDelivered == false)
    }

    @Test func notDeliveredWithTheAnswerLostAndTheReadFailingSaysItCouldNotTell() async throws {
        let (fake, model) = try await seeded()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        // GET parcels: 1 = the page's read, 2 = the writer's read before writing, 3 = the read after the lost answer.
        await fake.fail("GET", "parcels", nth: 3, with: .http(500))
        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.notDeliveredError == "確かめられませんでした")
        #expect(model.isMarkingNotDelivered == false)
    }

    @Test func notDeliveredOfflineSaysToReopen() async throws {
        let (fake, model) = try await seeded()
        await fake.fail("PATCH", "parcels", with: .transport(.notConnectedToInternet))
        await model.markNotDelivered()
        #expect(model.notDeliveredError == "更新できませんでした。開き直してください")
        #expect(model.row?.status == "delivered")
    }

    @Test func notDeliveredIsNotSentForAParcelThatIsNotDelivered() async throws {
        let (fake, model) = try await seeded(status: "shipped")
        await model.markNotDelivered()
        #expect(await fake.count("PATCH", "parcels") == 0)
        #expect(await fake.count("GET", "parcels") == 1)
    }

    // MARK: 分類

    @Test func aCategoryWithTheAnswerLostIsReadBack() async throws {
        let (fake, model) = try await seeded()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await model.setCategory(.hobby)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.categoryError == nil)
        #expect(model.shownCategory == .hobby)
        #expect(model.storedCategory == .hobby)
    }

    @Test func aCategoryWithTheAnswerLostAndTheReadFailingIsNotDecided() async throws {
        let (fake, model) = try await seeded()
        await fake.fail("PATCH", "parcels", with: .applyThenDrop(.networkConnectionLost))
        await fake.fail("GET", "parcels", nth: 2, with: .http(500))
        await model.setCategory(.hobby)
        #expect(await fake.count("PATCH", "parcels") == 1)
        #expect(model.categoryError == "確かめられませんでした")
        #expect(model.shownCategory == .food)
        #expect(model.isSavingCategory == false)
    }

    @Test func aCategoryOfAParcelThatIsGoneSaysNotFound() async throws {
        let (fake, model) = try await seeded()
        await fake.before("PATCH", "parcels") { tables in tables["parcels"] = [] }
        await model.setCategory(.beauty)
        #expect(model.categoryError == "見つかりません")
        #expect(model.shownCategory == .food)
    }

    @Test func aCategoryOfflineGoesBack() async throws {
        let (fake, model) = try await seeded()
        await fake.fail("PATCH", "parcels", with: .transport(.notConnectedToInternet))
        await model.setCategory(.daily)
        #expect(model.categoryError == "保存できませんでした")
        #expect(model.shownCategory == .food)
    }

    @Test func aSavedCategoryKeepsTheWrittenVersion() async throws {
        let (fake, model) = try await seeded()
        await model.setCategory(.daily)
        let stored = try #require(await fake.row("parcels", id: Rows.id(1)))
        #expect(model.row?.updatedAt == stored["updated_at"]?.string)
        #expect(model.row?.categorySource == "user")
        #expect(model.storedCategory == .daily)
    }

    // MARK: the form the web view posts

    @Test func theYamatoFormIsPostedAsAnHTMLFormWould() throws {
        let request = try #require(TrackingPage.postRequest(
            url: URL(string: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko")!,
            fields: ["number01": "123456789012", "category": "1"]
        ))
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/x-www-form-urlencoded")
        #expect(request.httpBody.map { String(decoding: $0, as: UTF8.self) } == "category=1&number01=123456789012")
    }

    @Test(arguments: ["http://example.com/x", "javascript:alert(1)", "data:text/html,x"])
    func aFormIsNeverPostedToAPageThatIsNotHttps(url: String) throws {
        let u = try #require(URL(string: url))
        #expect(TrackingPage.postRequest(url: u, fields: ["a": "1"]) == nil)
    }

    @Test func formValuesAreEscaped() {
        #expect(TrackingPage.formBody(["q": "a b&c=d", "k": "伝票"]) == "k=%E4%BC%9D%E7%A5%A8&q=a+b%26c%3Dd")
    }

    // MARK: 内容

    @Test func theItemLine() throws {
        func item(_ q: Int?, _ price: Int?) throws -> ParcelItemRow {
            try JSONCoding.decode(ParcelItemRow.self, .object(Rows.item(1, parcel: 1, ["quantity": q.map { .int($0) } ?? .null, "unit_price": price.map { .int($0) } ?? .null])))
        }
        #expect(ParcelDetailView.itemDetail(try item(2, 1200)) == "×2 ¥1,200")
        #expect(ParcelDetailView.itemDetail(try item(nil, nil)) == "")
        #expect(ParcelDetailView.itemDetail(try item(0, 500)) == "¥500")
        #expect(ParcelDetailView.itemDetail(try item(3, nil)) == "×3")
    }
}
