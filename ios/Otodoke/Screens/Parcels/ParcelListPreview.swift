// DEBUG only: `-otodoke-ui-preview <scenario>` starts the app on the tabs with made-up parcels, for
// checking the screen on the simulator. Nothing is read or written: the provider points at an
// address that does not exist and has no session, so a swipe fails before anything is sent.
// Release builds contain none of this.

#if DEBUG
import Foundation

struct ListPreview {
    enum Scenario: String {
        case list, empty, failed, toast, saving, many, bottom
    }

    let scenario: Scenario

    init?(arguments: [String]) {
        guard let i = arguments.firstIndex(of: "-otodoke-ui-preview"), arguments.indices.contains(i + 1),
              let scenario = Scenario(rawValue: arguments[i + 1])
        else { return nil }
        self.scenario = scenario
    }

    @MainActor
    func makeModel() -> ParcelListModel {
        let config = AppConfig(supabaseURL: URL(string: "https://preview.invalid")!, anonKey: "preview", inboundDomain: "preview.invalid")
        let provider = SupabaseProvider(config: config, storage: MemoryStorage())
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
        case .list:
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
