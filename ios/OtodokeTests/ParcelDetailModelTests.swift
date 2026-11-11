import Foundation
import Testing
@testable import Otodoke

/// [Task 8] The detail screen's model (src/app/app/parcels/[id]/page.tsx and its buttons).
@Suite("ParcelDetailModel (task 8)")
@MainActor
struct ParcelDetailModelTests {
    nonisolated private static let today = "2026-11-04" // Wednesday

    private func row(_ over: Row) throws -> ParcelRow { try Rows.parcelRow(Rows.parcel(1, over)) }

    private func shownParcel(_ model: ParcelDetailModel) -> ParcelRow? {
        if case let .loaded(p)? = model.parcel { return p }
        return nil
    }

    private func model(_ fake: FakeSupabase, id: Int = 1) async throws -> ParcelDetailModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelDetailModel(id: Rows.id(id), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { Self.today })
    }

    // MARK: tracking link: https only

    @Test func yamatoOpensByPostingTheForm() throws {
        let p = try row(["tracking_number": "1234-5678-9012", "carrier": "ヤマト運輸"])
        #expect(ParcelDetailModel.trackingAction(for: p) == .post(URL(string: "https://toi.kuronekoyamato.co.jp/cgi-bin/tneko")!, fields: ["category": "1", "number01": "123456789012"]))
    }

    @Test func sagawaCopiesThenOpens() throws {
        let p = try row(["tracking_number": "1234-5678-9012", "carrier": "佐川急便"])
        #expect(ParcelDetailModel.trackingAction(for: p) == .copyThenOpen(
            URL(string: "https://e-customer.sagawa-exp.co.jp/k2k")!,
            number: "123456789012", shown: "1234-5678-9012", pageName: "佐川のお荷物お問い合わせサービス", carrierName: "佐川急便"
        ))
    }

    @Test func japanPostOpensALink() throws {
        let p = try row(["tracking_number": "1234-5678-901"])
        #expect(ParcelDetailModel.trackingAction(for: p) == .open(URL(string: "https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=12345678901&searchKind=S002&locale=ja")!))
    }

    @Test func anUnknownCarrierFallsBackToTheStoredHttpsURL() throws {
        let p = try row(["tracking_number": "123456789012", "tracking_url": "https://example.com/track/1"])
        #expect(ParcelDetailModel.trackingAction(for: p) == .open(URL(string: "https://example.com/track/1")!))
    }

    @Test(arguments: ["http://example.com/track/1", "javascript:alert(1)", "data:text/html,<b>x</b>", "https://", "ftp://example.com/x", ""])
    func aStoredLinkThatIsNotHttpsIsNotShown(url: String) throws {
        let p = try row(["tracking_number": "123456789012", "tracking_url": .string(url)])
        #expect(ParcelDetailModel.trackingAction(for: p) == nil)
    }

    @Test func noTrackingNumberNoLink() throws {
        let p = try row(["tracking_number": nil, "tracking_url": "https://example.com/track/1", "carrier": "ヤマト運輸"])
        #expect(ParcelDetailModel.trackingAction(for: p) == nil)
    }

    @Test func everyLinkShownIsHttps() throws {
        let cases: [Row] = [
            ["tracking_number": "123456789012", "carrier": "ヤマト運輸"],
            ["tracking_number": "123456789012", "carrier": "佐川急便"],
            ["tracking_number": "12345678901"],
            ["tracking_number": "1234567890", "carrier": "西濃運輸"],
            ["tracking_number": "1234567890", "carrier": "福山通運"],
            ["tracking_number": "AB123456789JP"],
            ["tracking_number": "123456789012", "tracking_url": "https://example.com/x"],
        ]
        for over in cases {
            let action = try #require(ParcelDetailModel.trackingAction(for: try row(over)), "\(over)")
            let url: URL
            switch action {
            case let .open(u): url = u
            case let .post(u, _): url = u
            case let .copyThenOpen(u, _, _, _, _): url = u
            }
            #expect(url.scheme == "https", "\(over)")
        }
    }

    @Test func amazonsOwnPageForAnAmazonOrder() throws {
        let amazon = try row(["shop_key": "amazon", "order_number": "250-1234567-1234567"])
        #expect(ParcelDetailModel.amazonURL(for: amazon) == URL(string: "https://www.amazon.co.jp/gp/your-account/order-details?orderID=250-1234567-1234567"))
        #expect(ParcelDetailModel.amazonURL(for: try row(["shop_key": "amazon", "order_number": "D01-1234567-1234567"])) == nil)
        #expect(ParcelDetailModel.amazonURL(for: try row(["shop_key": nil, "order_number": "250-1234567-1234567"])) == nil)
    }

    @Test func theWebLinks() {
        #expect(WebLink.base.absoluteString == "https://otodoke.app")
    }

    // MARK: fields and badges

    @Test func theFieldsAsTheWebWordsThem() throws {
        let f = ParcelDetailFields.make(try row([
            "shop": "テスト店", "title": nil, "status": "out_for_delivery", "needs_review": true,
            "expected_date": "2026-11-05", "expected_date_end": "2026-11-07", "expected_text": "11月5日〜7日",
            "expected_window_start": "08:00:00", "expected_window_end": "12:00:00",
            "requires_presence": true, "presence_evidence": "対面でお渡し",
            "ordered_at": "2026-10-30", "order_number": "A-0001", "total_amount": 12_345,
        ]), today: Self.today)
        #expect(f.shop == "テスト店")
        #expect(f.title == "品名の記載なし")
        #expect(f.statusLabel == "配達中")
        #expect(f.presenceBadge == "🤝 対面受け取りが必要")
        #expect(f.needsReview == true)
        #expect(f.expected == "11/5(木)〜11/7(土) 午前中")
        #expect(f.expectedOriginal == "11月5日〜7日")
        #expect(f.presence == "対面受け取りが必要")
        #expect(f.presenceEvidence == "対面でお渡し")
        #expect(f.ordered == "2026/10/30(金)")
        #expect(f.orderNumber == "A-0001")
        #expect(f.amount == "¥12,345")
    }

    @Test func theFieldsWhenLittleIsKnown() throws {
        let f = ParcelDetailFields.make(try row(["shop_key": "amazon", "requires_presence": nil, "total_amount": nil]), today: Self.today)
        #expect(f.expected == nil)
        #expect(f.presence == "メールに記載なし")
        #expect(f.presenceBadge == nil)
        #expect(f.ordered == nil)
        #expect(f.amount == "—")
        let leaveAtDoor = ParcelDetailFields.make(try row(["requires_presence": false, "expected_date": "2026-11-05"]), today: Self.today)
        #expect(leaveAtDoor.presence == "置き配・投函でOK")
        #expect(leaveAtDoor.expected == "11/5(木)")
    }

    @Test func badges() {
        #expect(BadgeText.status("delivered") == "配達済み")
        #expect(BadgeText.status("attempted") == "不在・再配達")
        #expect(BadgeText.status("zzz") == "zzz")
        #expect(BadgeText.presence(true, compact: true) == "🤝 対面受け取り")
        #expect(BadgeText.presence(true, compact: false) == "🤝 対面受け取りが必要")
        #expect(BadgeText.presence(false, compact: true) == "置き配・投函OK")
        #expect(BadgeText.presence(false, compact: false) == "置き配・投函OK")
        #expect(BadgeText.presence(nil, compact: true) == nil)
    }

    // MARK: mail history

    @Test func theMailHistoryInSentOrder() throws {
        let xs: [ExtractionWithEmail] = try [
            Rows.extraction(1, parcel: 1, email: Rows.email(1, ["sent_at": "2026-11-03T01:00:00+00:00", "classification": "delivered", "text_body": "  ", "html_body": "<p>配達&amp;完了</p>"]), ["confidence": 0.875]),
            Rows.extraction(2, parcel: 1, email: Rows.email(2, ["sent_at": "2026-11-01T15:30:00+00:00", "classification": "weird", "from_name": nil]), ["confidence": nil, "result": ["notes": "金額は発送メールから"]]),
            Rows.extraction(3, parcel: 1, email: nil),
            Rows.extraction(4, parcel: 1, email: Rows.email(4, ["sent_at": nil, "classification": nil, "text_body": nil, "html_body": nil])),
        ].map { try JSONCoding.decode(ExtractionWithEmail.self, .object($0)) }
        let timeline = ParcelDetailModel.timeline(xs, today: Self.today)
        #expect(timeline.map(\.id) == [Rows.id(20_004), Rows.id(20_002), Rows.id(20_001)])
        try #require(timeline.count == 3)
        let unsent = timeline[0]
        #expect(unsent.label == "メール")
        #expect(unsent.dateText == "")
        #expect(unsent.body == "")
        let second = timeline[1]
        #expect(second.label == "weird")
        #expect(second.dateText == "11/2(月) 00:30")
        #expect(second.fromText == "shop@example.com")
        #expect(second.confidenceText == nil)
        #expect(second.body == "本文")
        #expect(second.notes == "金額は発送メールから")
        let delivered = timeline[2]
        #expect(delivered.label == "配達完了")
        #expect(delivered.dateText == "11/3(火) 10:00")
        #expect(delivered.subject == "件名1")
        #expect(delivered.fromText == "テスト店 <shop@example.com>")
        #expect(delivered.confidenceText == "確信度 88%")
        #expect(delivered.body == "配達&完了")
    }

    // MARK: loading: three reads, three failures

    private func seed(_ fake: FakeSupabase, status: String = "delivered") async {
        await fake.insert("parcels", [Rows.parcel(1, ["status": .string(status), "tracking_number": "1234-5678-9012", "category": "food"])])
        await fake.insert("parcel_items", [Rows.item(1, parcel: 1)])
        await fake.insert("extractions", [Rows.extraction(1, parcel: 1, email: Rows.email(1))])
    }

    @Test func loadsTheThreeReads() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await model(fake)
        await model.load()
        #expect(shownParcel(model)?.id == Rows.id(1))
        #expect(model.items?.value?.count == 1)
        #expect(model.timeline?.value?.count == 1)
        #expect(model.fields?.statusLabel == "配達済み")
        #expect(model.showsNotDelivered == true)
        #expect(model.canEdit == false)
        #expect(model.makeEditForm() == nil)
        #expect(model.shownCategory == .food)
    }

    @Test func itemsFailOnTheirOwn() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await model(fake)
        await fake.fail("GET", "parcel_items", with: .http(500))
        await model.load()
        #expect(model.items == .failed)
        #expect(shownParcel(model)?.id == Rows.id(1))
        #expect(model.timeline?.value?.count == 1)
    }

    @Test func theMailHistoryFailsOnItsOwn() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await model(fake)
        await fake.fail("GET", "extractions", with: .transport(.notConnectedToInternet))
        await model.load()
        #expect(model.timeline == .failed)
        #expect(shownParcel(model)?.id == Rows.id(1))
        #expect(model.items?.value?.count == 1)
    }

    @Test func theParcelFailsOnItsOwn() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await model(fake)
        await fake.fail("GET", "parcels", with: .http(500))
        await model.load()
        #expect(model.parcel == .failed)
        #expect(model.items?.value?.count == 1)
        #expect(model.timeline?.value?.count == 1)
    }

    @Test func aParcelThatIsNotThereIsNotAFailure() async throws {
        let fake = FakeSupabase.make()
        let model = try await model(fake, id: 2)
        await model.load()
        #expect(model.parcel == .loaded(nil))
    }

    @Test func aParcelTypedInByHandIsEditedInTheApp() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["source": "manual"])])
        let model = try await model(fake)
        await model.load()
        #expect(model.canEdit == true)
        #expect(model.makeEditForm()?.editing?.id == Rows.id(1))
        #expect(model.showsNotDelivered == false)
    }

    // MARK: 届いていない

    @Test func notDeliveredShowsTheSpinnerThenReloads() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await model(fake)
        await model.load()
        let gate = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(gate))
        let task = Task { await model.markNotDelivered() }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })
        #expect(model.isMarkingNotDelivered == true)
        gate.open()
        await task.value
        #expect(model.isMarkingNotDelivered == false)
        #expect(model.notDeliveredError == nil)
        #expect(shownParcel(model)?.status == "shipped")
        #expect(model.showsNotDelivered == false)
    }

    @Test func notDeliveredThatCannotBeWrittenSaysToReopen() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await model(fake)
        await model.load()
        await fake.touch("parcels", id: Rows.id(1), ["status": "shipped"])
        await model.markNotDelivered()
        #expect(model.notDeliveredError == "更新できませんでした。開き直してください")
        #expect(model.isMarkingNotDelivered == false)
    }

    // MARK: 分類

    @Test func choosingACategorySavesItAsTheUsers() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await model(fake)
        await model.load()
        let gate = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(gate))
        let task = Task { await model.setCategory(.hobby) }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })
        #expect(model.isSavingCategory == true)
        #expect(model.shownCategory == .hobby)
        gate.open()
        await task.value
        #expect(model.isSavingCategory == false)
        #expect(model.categoryError == nil)
        #expect(model.shownCategory == .hobby)
        #expect(await fake.row("parcels", id: Rows.id(1))?["category_source"] == "user")
    }

    @Test func aCategoryThatCannotBeSavedGoesBack() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let model = try await model(fake)
        await model.load()
        await fake.fail("PATCH", "parcels", with: .http(500))
        await model.setCategory(.beauty)
        #expect(model.categoryError == "保存できませんでした")
        #expect(model.shownCategory == .food)
        #expect(await fake.row("parcels", id: Rows.id(1))?["category"] == "food")
    }

    @Test func anUnknownStoredCategoryShowsAsUncategorized() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["category": "bogus"])])
        let model = try await model(fake)
        await model.load()
        #expect(model.shownCategory == nil)
    }
}
