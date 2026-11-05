// DEBUG only: `-otodoke-ui-preview <scenario>` starts the app on the tabs with made-up parcels, for
// checking the screen on the simulator. Nothing is read or written: the provider points at an
// address that does not exist and has no session, so a swipe fails before anything is sent.
// Release builds contain none of this.

#if DEBUG
import Foundation

struct ListPreview {
    enum Scenario: String {
        case list, empty, failed, toast, saving, many, bottom
        /// 「確認中…」 on a card, and a toast whose 「元に戻す」 cannot put back every row.
        case checking
        /// As list; a card opens a detail filled with made-up data.
        case detail
        /// The login screen: the address, the code with the resend wait, an error.
        case login
        case loginCode = "login-code"
        case loginError = "login-error"
    }

    let scenario: Scenario

    init?(arguments: [String]) {
        guard let i = arguments.firstIndex(of: "-otodoke-ui-preview"), arguments.indices.contains(i + 1),
              let scenario = Scenario(rawValue: arguments[i + 1])
        else { return nil }
        self.scenario = scenario
    }

    private static func provider() -> SupabaseProvider {
        let config = AppConfig(supabaseURL: URL(string: "https://preview.invalid")!, anonKey: "preview", inboundDomain: "preview.invalid")
        return SupabaseProvider(config: config, storage: MemoryStorage())
    }

    /// The login screen's model for the login scenarios, nil for the others.
    @MainActor
    func makeLoginModel() -> LoginModel? {
        let model = LoginModel(auth: AuthService(provider: Self.provider()), launch: LaunchOptions(arguments: []))
        switch scenario {
        case .login:
            model.debugShow(step: .email, email: "qa@example.com")
        case .loginCode:
            model.debugShow(step: .code(email: "qa@example.com"), email: "qa@example.com", code: "1234", sentSecondsAgo: 18)
        case .loginError:
            model.debugShow(step: .code(email: "qa@example.com"), email: "qa@example.com", code: "12345678", sentSecondsAgo: 75,
                            error: "コードが違うか、有効期限が切れています")
        default:
            return nil
        }
        return model
    }

    /// For the detail scenario: a detail model filled with made-up data (nothing is read).
    @MainActor
    func detailModelMaker() -> ((String) -> ParcelDetailModel)? {
        guard scenario == .detail else { return nil }
        let provider = Self.provider()
        let today = Format.todayJst(now: Date())
        return { id in
            let model = ParcelDetailModel(id: id, reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { today })
            var row = Self.rows(today: today).first { $0.id == id } ?? Self.rows(today: today)[0]
            row.carrier = "ヤマト運輸"
            row.trackingNumber = "1234-5678-9012"
            row.orderNumber = "A-0001-TEST"
            row.orderedAt = CivilDate.addDays(today, -5)
            row.totalAmount = 4_980
            row.category = "hobby"
            row.expectedText = "お届け予定日: 当日 14時〜16時"
            row.presenceEvidence = "対面でお渡しします"
            let items = [
                ParcelItemRow(id: Self.id(101), parcelId: id, name: "架空の本 上巻", quantity: 1, unitPrice: 2_490, createdAt: "2026-11-01T00:00:00+00:00"),
                ParcelItemRow(id: Self.id(102), parcelId: id, name: "架空の本 下巻", quantity: 1, unitPrice: 2_490, createdAt: "2026-11-01T00:00:01+00:00"),
            ]
            let timeline = [
                TimelineEntry(id: Self.id(201), label: "注文", dateText: "11/1(日) 12:00", subject: "ご注文ありがとうございます",
                              fromText: "サンプル書店 <shop@example.com>", confidenceText: "確信度 93%", body: "ご注文内容\n架空の本 上下巻セット", notes: nil),
                TimelineEntry(id: Self.id(202), label: "発送", dateText: "11/3(火) 09:45", subject: "商品を発送しました",
                              fromText: "shop@example.com", confidenceText: "確信度 88%", body: "伝票番号 1234-5678-9012", notes: "お届け日は発送メールから"),
            ]
            model.debugShow(parcel: row, items: items, timeline: timeline)
            return model
        }
    }

    @MainActor
    func makeModel() -> ParcelListModel {
        let provider = Self.provider()
        let today = Format.todayJst(now: Date())
        let model = ParcelListModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider),
            today: { today },
            now: { Date() },
            sleep: { try await Task.sleep(for: $0) }
        )
        let counts = ParcelCounts(delivered: .loaded(1234), cancelled: .loaded(2), unread: .loaded(scenario == .list ? 3 : 0))
        switch scenario {
        case .list, .detail, .login, .loginCode, .loginError:
            model.debugShow(rows: Self.rows(today: today), counts: counts, loadState: .loaded)
        case .empty:
            model.debugShow(rows: [], counts: ParcelCounts(delivered: .loaded(0), cancelled: .loaded(0), unread: .loaded(0)), loadState: .loaded)
        case .failed:
            model.debugShow(rows: [], counts: ParcelCounts(delivered: .failed, cancelled: .loaded(2), unread: .loaded(0)), loadState: .failed)
        case .toast:
            let rows = Self.rows(today: today).filter { $0.id != Self.id(7) }
            model.debugShow(
                rows: rows, counts: counts, loadState: .loaded,
                rowMessages: [Self.id(3): ParcelListModel.saveFailedText, Self.id(4): ParcelListModel.unconfirmedText],
                toast: ListToast(text: ParcelListModel.savedText, canUndo: true)
            )
        case .checking:
            model.debugShow(
                rows: Self.rows(today: today).filter { $0.id != Self.id(7) }, counts: counts, loadState: .loaded,
                saving: [Self.id(2)], checking: [Self.id(2)],
                toast: ListToast(text: "3 件を受取済にしました", canUndo: true), toastNote: ParcelListModel.cannotUndoNote(1)
            )
        case .saving:
            model.debugShow(rows: Self.rows(today: today).filter { $0.id != Self.id(7) }, counts: counts, loadState: .loaded, saving: [Self.id(2)])
        case .bottom:
            let rows = Self.rows(today: today).filter { [5, 6, 8].map(Self.id).contains($0.id) }
            model.debugShow(rows: rows, counts: ParcelCounts(delivered: .loaded(1234), cancelled: .failed, unread: .loaded(0)), loadState: .loaded,
                            rowMessages: [Self.id(5): ParcelListModel.saveFailedText])
        case .many:
            let check = (20..<28).map { n in
                Self.row(n, shop: "テスト商店 \(n)", title: "架空の品物 \(n)", status: "shipped", date: CivilDate.addDays(today, -30 - n))
            }
            model.debugShow(rows: check + Self.rows(today: today), counts: counts, loadState: .loaded)
        }
        return model
    }

    static func id(_ n: Int) -> String {
        String(format: "00000000-0000-4000-8000-%012d", n)
    }

    /// Made-up parcels, one or more in every section.
    static func rows(today: String) -> [ParcelRow] {
        [
            row(1, shop: "サンプル書店", title: "架空の本 上下巻セット", status: "out_for_delivery", date: today,
                window: ("14:00:00", "16:00:00"), presence: true),
            row(2, shop: "Amazon.co.jp", title: "USB-C ケーブル 2 本入り（1m・急速充電対応・とても長い品名の例）", status: "shipped",
                date: CivilDate.addDays(today, 1), shopKey: "amazon"),
            row(3, shop: "テスト雑貨店", title: nil, status: "shipped", date: CivilDate.addDays(today, 2),
                end: CivilDate.addDays(today, 4), window: ("08:00:00", "12:00:00"), presence: false),
            row(4, shop: "見本食品", title: "架空のお米 5kg", status: "attempted", date: CivilDate.addDays(today, -3),
                presence: true, review: true),
            row(5, shop: "サンプル電機", title: "架空のイヤホン", status: "ordered", date: nil),
            row(6, shop: "テスト衣料", title: "架空のシャツ", status: "ordered", date: CivilDate.addDays(today, 9)),
            row(7, shop: "見本ストア", title: "架空のマグカップ", status: "shipped", date: CivilDate.addDays(today, -20)),
            row(8, shop: "テスト書房", title: "架空の雑誌", status: "delivered", date: CivilDate.addDays(today, -2)),
        ]
    }

    static func row(
        _ n: Int, shop: String, title: String?, status: String, date: String?, end: String? = nil,
        window: (String, String)? = nil, presence: Bool? = nil, review: Bool = false, shopKey: String? = nil
    ) -> ParcelRow {
        ParcelRow(
            id: id(n), userId: id(999), shop: shop, shopKey: shopKey, title: title, status: status, source: "email",
            category: nil, categorySource: nil, carrier: nil, trackingNumber: nil, trackingUrl: nil, orderNumber: nil,
            orderedAt: nil, expectedDate: date, expectedDateEnd: end, expectedText: nil,
            expectedWindowStart: window?.0, expectedWindowEnd: window?.1, lastEmailAt: "2026-11-01T00:00:00+00:00",
            needsReview: review, requiresPresence: presence, presenceEvidence: nil, totalAmount: nil,
            createdAt: "2026-11-01T00:00:00+00:00", updatedAt: "2026-11-01T00:00:00.000000+00:00"
        )
    }

    /// A session store that keeps nothing past the process (never the Keychain).
    private final class MemoryStorage: SessionStorage, @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: Data] = [:]

        func store(key: String, value: Data) throws { lock.withLock { values[key] = value } }
        func retrieve(key: String) throws -> Data? { lock.withLock { values[key] } }
        func remove(key: String) throws { lock.withLock { _ = values.removeValue(forKey: key) } }
    }
}
#endif
