// TDD-STUB(task 8) — agreed API, placeholder bodies. Remove this marker once written.
// The view model of SpendView (src/app/app/spend/, 2541793). Each move (period, month, category,
// shop) reads again `user_id = me and status != cancelled` (every row, keyset by id) as the Web's
// navigation does, one move at a time; a month is the parcels ordered in it (ordered_at between the
// 1st and the last day, as text). The figures come from Spend (checked against the Web).
// The category chip writes through ParcelWriter.setCategory(_:category:) on the version shown; the
// writer publishes 「古くなった」 (the model never does).

import Foundation
import Observation

enum SpendPeriod: Equatable, Sendable {
    case month(String)
    case all
}

enum SpendMove: Equatable, Sendable {
    case period(SpendPeriod)
    case category(CategoryFilter)
    case shop(String?)
}

struct ShopAmount: Equatable, Sendable {
    let name: String
    let amount: Int
}

@MainActor
@Observable
final class SpendModel {
    static let failedText = ""
    static let categoryFailed = ""

    let reader: ParcelReader
    let writer: ParcelWriter

    private(set) var period: SpendPeriod = .all
    private(set) var category: CategoryFilter = .uncategorized
    private(set) var shop: String? = "stub"
    /// nil until the first read ends.
    private(set) var parcels: LoadResult<[ParcelRow]>?
    /// The move being read; others are refused meanwhile.
    private(set) var pendingMove: SpendMove?
    /// Ids whose category is being saved.
    private(set) var savingCategory: Set<String> = []
    /// Per-order message after a failed save (「保存できませんでした」).
    private(set) var categoryErrors: [String: String] = [:]

    init(reader: ParcelReader, writer: ParcelWriter, changes: DataChanges?, today: @escaping @Sendable () -> String) {
        self.reader = reader
        self.writer = writer
    }

    /// The results are shown faded while a move is on the way.
    var isDimmed: Bool { false }
    var bounds: MonthBounds { MonthBounds(today: "") }

    var slices: Spend.Slices? { nil }
    var total: Spend.Total? { nil }
    var categoryRows: [Spend.CategoryAmount] { [] }
    var shopRows: [ShopAmount] { [] }
    /// The whole period only: withEmptyMonths(byMonth(picked)).
    var bars: [Spend.MonthBar] { [] }
    var orders: [ParcelRow] { [] }
    /// The whole period: groupByOrderMonth(orders); a month: one group with an empty label.
    var orderGroups: [(label: String, parcels: [ParcelRow])] { [] }
    /// 「ネット注文の合計」 or 「食費・テスト店の合計」.
    var totalCaption: String { "" }
    /// 「3 件（ほかに金額を読み取れなかった注文が 1 件）（注文日の無い 2 件は除く）」
    var countCaption: String { "" }
    /// 「この条件の注文はありません」 / 「注文はありません」 / 「この月の注文はありません」
    var ordersEmptyText: String { "" }
    /// The chips beside 注文, category first: 「食費だけ」「テスト店だけ」 (shop through shopLabel).
    var chips: [String] { [] }

    func load() async {}
    func showAll() async {}
    /// A month (also a tap on a bar).
    func showMonth(_ ym: String) async {}
    func shiftMonth(_ delta: Int) async {}
    /// A row of 分類ごと: narrows to it, or takes it off when it is the one selected. nil is 未分類.
    func toggleCategory(_ c: ParcelCategory?) async {}
    func toggleShop(_ name: String) async {}
    /// The chips' 「×」.
    func clearCategory() async {}
    func clearShop() async {}

    /// The chip of an order: written on the version shown. Success: that version is kept and the
    /// figures worked out again. Conflict or unknown: read again (never sent again). Failed: the old
    /// category stays, with categoryFailed.
    func setCategory(parcelID: String, to category: ParcelCategory) async {}

    func onAppear() async {}
    func sceneBecameActive() async {}
}
