import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, tasks 8 and 9] The spend screen's model (src/app/app/spend/, 2541793): the month and the
/// whole period, the totals and their notes, by category and by shop (tap to narrow, again to take it
/// off), the orders, one move at a time, and the category chip written on the version shown.
@Suite("SpendModel (batch 2, tasks 8 and 9)")
@MainActor
struct SpendModelTests {
    nonisolated static let today = "2026-11-04"

    static let rows: [Row] = [
        Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1000, "category": "food", "shop": "テスト店"]),
        Rows.parcel(2, ["ordered_at": "2026-11-03", "total_amount": 3000, "category": nil, "shop": "Amazon.co.jp", "shop_key": "amazon"]),
        Rows.parcel(3, ["ordered_at": "2026-11-03", "total_amount": nil, "category": "hobby", "shop": "別の店"]),
        Rows.parcel(4, ["ordered_at": "2026-10-15", "total_amount": 500, "category": "food", "shop": "テスト店"]),
        Rows.parcel(5, ["ordered_at": nil, "total_amount": 700, "category": "daily", "shop": "テスト店"]),
        Rows.parcel(6, ["ordered_at": "2026-11-10", "total_amount": 2000, "status": "cancelled"]),
        Rows.parcel(7, ["ordered_at": "2026-11-05", "total_amount": 9999, "user_id": .string(FakeSupabase.other)]),
        Rows.parcel(8, ["ordered_at": "2026-11-20", "total_amount": 1500, "category": "weird", "shop": "アマゾン", "shop_key": "amazon"]),
    ]

    private struct Setup: Sendable {
        let fake: FakeSupabase
        let model: SpendModel
        let changes: DataChanges
    }

    private func setUp(_ rows: [Row] = Self.rows, load: Bool = true) async throws -> Setup {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", rows)
        let (provider, _) = try await TestSession.signedIn(fake)
        let changes = DataChanges()
        let model = SpendModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider, changes: changes),
            changes: changes,
            today: { Self.today }
        )
        if load { await model.load() }
        return Setup(fake: fake, model: model, changes: changes)
    }

    private func ids(_ rows: [ParcelRow]) -> [String] { rows.map(\.id) }

    private func loadedRows(_ m: SpendModel) -> [ParcelRow] {
        if case let .loaded(rows)? = m.parcels { return rows }
        return []
    }

    @Test func theWords() {
        #expect(SpendModel.failedText == "読み込めませんでした")
        #expect(SpendModel.categoryFailed == "保存できませんでした")
    }

    @Test func startsAtThisMonthWithNoFilter() async throws {
        let s = try await setUp(load: false)
        #expect(s.model.period == .month("2026-11"))
        #expect(s.model.category == .any)
        #expect(s.model.shop == nil)
        #expect(s.model.pendingMove == nil)
        #expect(s.model.isDimmed == false)
    }

    // MARK: the read

    @Test func readsTheUsersParcelsThatAreNotCancelled() async throws {
        let s = try await setUp()
        let reads = await s.fake.requests("GET", "parcels")
        #expect(!reads.isEmpty)
        for r in reads {
            #expect(r.query("user_id") == ["eq.\(FakeSupabase.me)"])
            #expect(r.query("status") == ["neq.cancelled"])
        }
        let shown = Set(loadedRows(s.model).map(\.id))
        #expect(!shown.contains(Rows.id(6)))
        #expect(!shown.contains(Rows.id(7)))
    }

    @Test func aFailedReadShowsTheFailureNotZero() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.rows)
        await fake.fail("GET", "parcels", with: .http(500))
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = SpendModel(reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), changes: nil, today: { Self.today })
        await model.load()
        #expect(model.parcels == .failed)
        #expect(model.total == nil)
        #expect(model.orders.isEmpty)
    }

    @Test func readsPastAThousandRows() async throws {
        let many = (100..<1_250).map { Rows.parcel($0, ["ordered_at": "2026-11-01", "total_amount": 1]) }
        let s = try await setUp(many)
        #expect(s.model.total == Spend.Total(total: 1_150, priced: 1_150, unpriced: 0))
    }

    // MARK: a month

    @Test func aMonthIsTheParcelsOrderedInIt() async throws {
        let s = try await setUp()
        #expect(s.model.total == Spend.Total(total: 5500, priced: 3, unpriced: 1))
        #expect(s.model.slices?.undated == 0)
        #expect(s.model.totalCaption == "ネット注文の合計")
        #expect(s.model.countCaption == "3 件（ほかに金額を読み取れなかった注文が 1 件）")
        #expect(s.model.bars.isEmpty)
    }

    @Test func aMonthsBreakdowns() async throws {
        let s = try await setUp()
        #expect(s.model.categoryRows.map(\.category) == [nil, .food])
        #expect(s.model.categoryRows.map(\.amount) == [4500, 1000])
        #expect(s.model.categoryRows.first?.share == 4500.0 / 5500.0)
        // Amazon's names read as one shop; a shop with no amount read is not listed.
        #expect(s.model.shopRows == [ShopAmount(name: "Amazon", amount: 4500), ShopAmount(name: "テスト店", amount: 1000)])
    }

    @Test func aMonthsOrdersInTheWebsOrder() async throws {
        let s = try await setUp()
        // ordered_at ↓ nulls last, then id ↑.
        #expect(ids(s.model.orders) == [Rows.id(8), Rows.id(2), Rows.id(3), Rows.id(1)])
        #expect(s.model.orderGroups.count == 1)
        #expect(s.model.orderGroups.first.map { ids($0.parcels) } == ids(s.model.orders))
    }

    @Test func theFiguresAreTheSpendFunctions() async throws {
        let s = try await setUp()
        let month = loadedRows(s.model).filter { ($0.orderedAt ?? "") >= "2026-11-01" && ($0.orderedAt ?? "") <= "2026-11-30" }
        let slices = Spend.slices(month, all: false, category: .any, shop: nil)
        #expect(s.model.slices == slices)
        #expect(s.model.total == Spend.total(slices.picked))
        #expect(s.model.categoryRows == Spend.byCategory(slices.byCategory))
    }

    // MARK: the whole period

    @Test func theWholePeriod() async throws {
        let s = try await setUp()
        await s.model.showAll()
        #expect(s.model.period == .all)
        #expect(s.model.total == Spend.Total(total: 6000, priced: 4, unpriced: 1))
        #expect(s.model.slices?.undated == 1)
        #expect(s.model.countCaption == "4 件（ほかに金額を読み取れなかった注文が 1 件）（注文日の無い 1 件は除く）")
        #expect(s.model.bars == [
            Spend.MonthBar(month: "2026-10", total: 500, segments: [Spend.Segment(category: .food, amount: 500)]),
            Spend.MonthBar(month: "2026-11", total: 5500, segments: [Spend.Segment(category: .food, amount: 1000), Spend.Segment(category: nil, amount: 4500)]),
        ])
    }

    @Test func theWholePeriodsOrdersByOrderMonth() async throws {
        let s = try await setUp()
        await s.model.showAll()
        let groups = s.model.orderGroups
        #expect(groups.map(\.label) == ["2026年11月に注文", "2026年10月に注文", "注文日不明"])
        #expect(groups.map { ids($0.parcels) } == [[Rows.id(8), Rows.id(2), Rows.id(3), Rows.id(1)], [Rows.id(4)], [Rows.id(5)]])
    }

    @Test func aBarOpensItsMonth() async throws {
        let s = try await setUp()
        await s.model.showAll()
        await s.model.showMonth("2026-10")
        #expect(s.model.period == .month("2026-10"))
        #expect(s.model.total == Spend.Total(total: 500, priced: 1, unpriced: 0))
    }

    @Test func emptyWords() async throws {
        let s = try await setUp()
        await s.model.shiftMonth(-2)
        #expect(s.model.period == .month("2026-09"))
        #expect(s.model.orders.isEmpty)
        #expect(s.model.ordersEmptyText == "この月の注文はありません")
        let none = try await setUp([])
        await none.model.showAll()
        #expect(none.model.ordersEmptyText == "注文はありません")
    }

    @Test func theMonthStaysInTheRange() async throws {
        let s = try await setUp()
        await s.model.showMonth("2027-12")
        await s.model.shiftMonth(1)
        #expect(s.model.period == .month("2027-12"))
        await s.model.showMonth("2019-12")
        #expect(s.model.period == .month("2027-12"))
    }

    // MARK: narrowing

    @Test func aCategoryRowNarrowsAndTakesItOff() async throws {
        let s = try await setUp()
        await s.model.toggleCategory(.food)
        #expect(s.model.category == .only(.food))
        #expect(s.model.total == Spend.Total(total: 1000, priced: 1, unpriced: 0))
        #expect(s.model.totalCaption == "食費の合計")
        #expect(s.model.chips == ["食費だけ"])
        // 分類ごと is narrowed by the shop only; 店ごと by the category.
        #expect(s.model.categoryRows.map(\.category) == [nil, .food])
        #expect(s.model.shopRows == [ShopAmount(name: "テスト店", amount: 1000)])
        await s.model.toggleCategory(.food)
        #expect(s.model.category == .any)
        #expect(s.model.chips.isEmpty)
    }

    @Test func uncategorizedIsAFilterOfItsOwn() async throws {
        let s = try await setUp()
        await s.model.toggleCategory(nil)
        #expect(s.model.category == .uncategorized)
        #expect(ids(s.model.slices?.picked ?? []).sorted() == [Rows.id(2), Rows.id(8)])
        #expect(s.model.chips == ["未分類だけ"])
    }

    @Test func aShopRowNarrowsAndTakesItOff() async throws {
        let s = try await setUp()
        await s.model.toggleShop("Amazon")
        #expect(s.model.shop == "Amazon")
        #expect(s.model.total == Spend.Total(total: 4500, priced: 2, unpriced: 0))
        #expect(s.model.totalCaption == "Amazonの合計")
        await s.model.toggleShop("Amazon")
        #expect(s.model.shop == nil)
    }

    @Test func bothFiltersAndTheirChips() async throws {
        let s = try await setUp()
        await s.model.toggleCategory(.food)
        await s.model.toggleShop("Amazon")
        #expect(s.model.chips == ["食費だけ", "Amazonだけ"])
        #expect(s.model.totalCaption == "食費・Amazonの合計")
        #expect(s.model.orders.isEmpty)
        #expect(s.model.ordersEmptyText == "この条件の注文はありません")
        // A chip's 「×」 takes its own condition off and keeps the other.
        await s.model.clearCategory()
        #expect(s.model.category == .any)
        #expect(s.model.shop == "Amazon")
        await s.model.clearShop()
        #expect(s.model.shop == nil)
    }

    @Test func theFiltersStayAcrossTheMonth() async throws {
        let s = try await setUp()
        await s.model.toggleCategory(.food)
        await s.model.shiftMonth(-1)
        #expect(s.model.period == .month("2026-10"))
        #expect(s.model.category == .only(.food))
        #expect(s.model.total == Spend.Total(total: 500, priced: 1, unpriced: 0))
    }

    @Test func aLongShopNameIsCutOnlyForShowing() async throws {
        let long = String(repeating: "店", count: 41)
        let s = try await setUp([Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 100, "shop": .string(long)])])
        await s.model.toggleShop(long)
        #expect(s.model.shop == long)
        #expect(s.model.total?.total == 100)
        #expect(s.model.chips == [String(repeating: "店", count: 40) + "…だけ"])
    }

    // MARK: one move at a time

    @Test func eachMoveReadsAgain() async throws {
        let s = try await setUp()
        var reads = await s.fake.count("GET", "parcels")
        await s.model.showAll()
        #expect(await s.fake.count("GET", "parcels") > reads)
        reads = await s.fake.count("GET", "parcels")
        await s.model.toggleCategory(.food)
        #expect(await s.fake.count("GET", "parcels") > reads)
    }

    @Test func aSecondMoveWaitsItsTurn() async throws {
        let s = try await setUp()
        let gate = Gate()
        let reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let first = Task { await s.model.showAll() }
        #expect(await waitFor { await s.fake.count("GET", "parcels") == reads + 1 })
        #expect(s.model.pendingMove == .period(.all))
        #expect(s.model.isDimmed)
        await s.model.toggleCategory(.food)
        await s.model.shiftMonth(-1)
        gate.open()
        await first.value
        #expect(s.model.period == .all)
        #expect(s.model.category == .any)
        #expect(s.model.pendingMove == nil)
        #expect(s.model.isDimmed == false)
    }

    @Test func aFailedMoveSaysSo() async throws {
        let s = try await setUp()
        let reads = await s.fake.count("GET", "parcels")
        await s.fake.fail("GET", "parcels", nth: reads + 1, with: .http(500))
        await s.model.showAll()
        #expect(s.model.parcels == .failed)
        #expect(s.model.pendingMove == nil)
    }

    // MARK: the category chip

    @Test func aChosenCategoryIsSavedOnTheVersionShownAndCounted() async throws {
        let s = try await setUp()
        await s.model.setCategory(parcelID: Rows.id(2), to: .daily)
        let patches = await s.fake.requests("PATCH", "parcels")
        #expect(patches.count == 1)
        #expect(patches.first?.query("updated_at") == ["eq.2026-11-01T09:30:15.123456+00:00"])
        #expect(patches.first?.jsonDictionary?["category_source"] as? String == "user")
        #expect(loadedRows(s.model).first { $0.id == Rows.id(2) }?.category == "daily")
        #expect(s.model.categoryRows.contains(Spend.CategoryAmount(category: .daily, amount: 3000, share: 3000.0 / 5500.0)))
        #expect(s.model.categoryErrors.isEmpty)
    }

    @Test func theNewVersionIsKeptForTheNextChoice() async throws {
        let s = try await setUp()
        await s.model.setCategory(parcelID: Rows.id(2), to: .daily)
        await s.model.setCategory(parcelID: Rows.id(2), to: .food)
        let patches = await s.fake.requests("PATCH", "parcels")
        #expect(patches.count == 2)
        #expect(await s.fake.row("parcels", id: Rows.id(2))?["category"] == "food")
        #expect(s.model.categoryErrors.isEmpty)
    }

    @Test func aSaveTellsTheOtherTabsOnce() async throws {
        let s = try await setUp()
        await s.model.setCategory(parcelID: Rows.id(2), to: .daily)
        #expect(s.changes.version == 1)
    }

    @Test func aConflictReadsAgainAndNeverSendsAgain() async throws {
        let s = try await setUp()
        await s.fake.touch("parcels", id: Rows.id(2), ["category": "beauty", "category_source": "user"])
        let reads = await s.fake.count("GET", "parcels")
        await s.model.setCategory(parcelID: Rows.id(2), to: .daily)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        #expect(await s.fake.count("GET", "parcels") > reads)
        // What is there now is shown.
        #expect(loadedRows(s.model).first { $0.id == Rows.id(2) }?.category == "beauty")
    }

    @Test func anUnknownResultReadsAgainAndNeverSendsAgain() async throws {
        let s = try await setUp()
        await s.fake.fail("PATCH", "parcels", with: .applyThenDrop(.timedOut))
        let reads = await s.fake.count("GET", "parcels")
        await s.model.setCategory(parcelID: Rows.id(2), to: .daily)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        #expect(await s.fake.count("GET", "parcels") > reads)
        #expect(loadedRows(s.model).first { $0.id == Rows.id(2) }?.category == "daily")
        #expect(s.changes.version == 1)
    }

    @Test func aSureFailureKeepsTheOldCategory() async throws {
        let s = try await setUp()
        await s.fake.fail("PATCH", "parcels", with: .http(500))
        await s.model.setCategory(parcelID: Rows.id(2), to: .daily)
        #expect(await s.fake.count("PATCH", "parcels") == 1)
        #expect(loadedRows(s.model).first { $0.id == Rows.id(2) }?.category == nil)
        #expect(s.model.categoryErrors[Rows.id(2)] == "保存できませんでした")
        #expect(s.changes.version == 0)
    }

    @Test func showsTheSpinnerWhileSaving() async throws {
        let s = try await setUp()
        let gate = Gate()
        await s.fake.fail("PATCH", "parcels", with: .hold(gate))
        let save = Task { await s.model.setCategory(parcelID: Rows.id(2), to: .daily) }
        #expect(await waitFor { await s.fake.count("PATCH", "parcels") == 1 })
        #expect(s.model.savingCategory.contains(Rows.id(2)))
        gate.open()
        await save.value
        #expect(s.model.savingCategory.isEmpty)
    }

    // MARK: 「古くなった」 and the front

    @Test func readsWhenShownFirstThenOnlyWhenStale() async throws {
        let s = try await setUp(load: false)
        await s.model.onAppear()
        let first = await s.fake.count("GET", "parcels")
        #expect(first >= 1)
        await s.model.onAppear()
        #expect(await s.fake.count("GET", "parcels") == first)
        s.changes.publish()
        await s.model.onAppear()
        #expect(await s.fake.count("GET", "parcels") > first)
    }

    @Test func comingBackToTheFrontReadsOnce() async throws {
        let s = try await setUp()
        let before = await s.fake.count("GET", "parcels")
        await s.model.sceneBecameActive()
        #expect(await s.fake.count("GET", "parcels") == before + 1)
    }
}
