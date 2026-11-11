import Foundation
import Testing
@testable import Otodoke

/// [Batch 2, tasks 21 and 22] The delivered and cancelled pages: the reads (as the Web's pages: user_id and the
/// status, every row, the database's order; every item name), the search and the filters through task 20's
/// functions, 「クリア」, the month groups, the Web's empty and failure words, the fence (an older read never
/// replaces a newer one), 「古くなった」 and coming back to the front. CX1's M2 path: undoing 「届いた」 takes the
/// parcel off the delivered page.
@Suite("Delivered and cancelled (batch 2, tasks 21 and 22)")
@MainActor
struct StatusListsTests {
    struct World {
        let fake: FakeSupabase
        let provider: SupabaseProvider
        let reader: StatusListReader
        let changes: DataChanges
    }

    func world(parcels: [Row], items: [Row] = [], faults: (FakeSupabase) async -> Void = { _ in }) async throws -> World {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", parcels)
        await fake.insert("parcel_items", items)
        await faults(fake)
        let (provider, _) = try await TestSession.signedIn(fake)
        return World(fake: fake, provider: provider, reader: StatusListReader(provider: provider), changes: DataChanges())
    }

    static func delivered(_ n: Int, _ over: Row = [:]) -> Row {
        var row = over
        row["status"] = row["status"] ?? "delivered"
        if row["status"] == "delivered" { row["received_at"] = row["received_at"] ?? "2026-11-01T12:00:00Z" }
        return Rows.parcel(n, row)
    }

    /// A mixed set: delivered in three months (one tie), undated, another status, another user.
    static let mixed: [Row] = [
        delivered(1, ["ordered_at": "2026-10-03", "title": "ＵＳＢケーブル", "shop": "Amazon.co.jp", "shop_key": "amazon", "category": "electronics"]),
        delivered(2, ["ordered_at": "2026-11-02", "title": "コーヒー豆", "shop": "テスト珈琲", "category": "food"]),
        delivered(3, ["ordered_at": "2026-11-02", "title": "紅茶", "shop": "テスト珈琲", "category": "food"]),
        delivered(4, ["ordered_at": nil, "title": "ノート", "shop": "文具店"]),
        delivered(5, ["ordered_at": "2025-12-30", "title": "カレンダー", "shop": "文具店", "category": "daily"]),
        delivered(6, ["ordered_at": "2026-11-05", "status": "shipped", "title": "出荷中"]),
        delivered(7, ["ordered_at": "2026-11-05", "status": "cancelled", "title": "キャンセル1"]),
        delivered(8, ["ordered_at": "2026-11-01", "user_id": .string(FakeSupabase.other), "title": "他人の荷物"]),
    ]

    static let mixedItems: [Row] = [
        Rows.item(1, parcel: 4, ["name": "方眼ノート"]),
        Rows.item(2, parcel: 2, ["name": "ドリッパー"]),
    ]

    // MARK: the reader

    @Test func readsEveryDeliveredParcelOfMineInTheWebsOrder() async throws {
        let rows = (1...1_101).map { n in Self.delivered(n, ["ordered_at": n % 7 == 0 ? nil : .string(String(format: "2026-%02d-%02d", n % 12 + 1, n % 28 + 1))]) }
        let excluded = [
            Self.delivered(2_000, ["status": "shipped"]),
            Self.delivered(2_001, ["user_id": .string(FakeSupabase.other)]),
            Self.delivered(2_002, ["received_at": nil]),
            Self.delivered(2_003, ["status": "cancelled", "received_at": "2026-11-01T12:00:00Z"]),
        ]
        let w = try await world(parcels: rows + excluded)
        let read = await w.reader.parcels(.delivered)
        let got = try #require(read.value)
        #expect(got.count == 1_101)
        #expect(got == StatusListReader.webOrder(got))
        #expect(Set(got.map(\.id)) == Set(rows.compactMap { $0["id"]?.text }))
        let requests = await w.fake.requests("GET", "parcels")
        #expect(requests.count >= 2)
        for q in requests {
            #expect(q.query("user_id") == ["eq.\(FakeSupabase.me)"])
            #expect(q.query("received_at") == ["not.is.null"])
            #expect(q.query("status") == ["neq.cancelled"])
        }
    }

    @Test func aFailedPageFailsTheWholeRead() async throws {
        let rows = (1...1_001).map { Self.delivered($0) }
        let w = try await world(parcels: rows, faults: { await $0.fail("GET", "parcels", nth: 2, with: .http(500)) })
        #expect(await w.reader.parcels(.delivered) == .failed)
    }

    @Test func readsEveryItemNameOfMine() async throws {
        let items = (1...1_050).map { Rows.item($0, parcel: $0 % 3 + 1) } + [Rows.item(5_000, parcel: 1, ["user_id": .string(FakeSupabase.other)])]
        let w = try await world(parcels: [], items: items)
        let names = try #require(await w.reader.itemNames().value)
        #expect(names.count == 1_050)
        for q in await w.fake.requests("GET", "parcel_items") {
            #expect(q.query("user_id") == ["eq.\(FakeSupabase.me)"])
            let select = q.query("select").first ?? ""
            #expect(select.contains("parcel_id") && select.contains("name"))
        }
    }

    @Test func theWebsOrderIsOrderedAtDescendingNullsLastThenID() throws {
        let rows = try [
            Rows.parcel(3, ["ordered_at": nil]),
            Rows.parcel(1, ["ordered_at": "2026-11-01"]),
            Rows.parcel(4, ["ordered_at": "2026-11-02"]),
            Rows.parcel(2, ["ordered_at": "2026-11-01"]),
            Rows.parcel(5, ["ordered_at": nil]),
        ].map(Rows.parcelRow)
        #expect(StatusListReader.webOrder(rows).map(\.id) == [Rows.id(4), Rows.id(1), Rows.id(2), Rows.id(3), Rows.id(5)])
    }

    // MARK: the delivered page

    @Test func theWords() {
        #expect(DeliveredModel.title == "受け取り済み")
        #expect(DeliveredModel.failedText == "読み込めませんでした")
        #expect(DeliveredModel.emptyText == "受け取り済みの荷物はありません")
        #expect(DeliveredModel.noMatchText == "見つかりません")
        #expect(DeliveredModel.searchPlaceholder == "品名・店名")
        #expect(DeliveredModel.clearText == "クリア")
        #expect(DeliveredModel.allShops == "すべての店")
        #expect(DeliveredModel.allCategories == "すべての分類")
        #expect(DeliveredModel.allMonths == "すべての月")
        #expect(CancelledModel.title == "キャンセルした荷物")
        #expect(CancelledModel.emptyText == "キャンセルした荷物はありません")
        #expect(CancelledModel.failedText == "読み込めませんでした")
    }

    @Test func theSearchAndTheFiltersAreTask20s() async throws {
        let w = try await world(parcels: Self.mixed, items: Self.mixedItems)
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        await model.load()
        let parcels = try #require(model.parcels?.value)
        #expect(parcels.map(\.id).sorted() == [1, 2, 3, 4, 5].map(Rows.id))
        let names = Delivered.itemNamesByParcel(try #require(model.items?.value))
        let settings: [(String, String, String, String)] = [
            ("", "", "", ""), ("ｕｓｂ", "", "", ""), ("ノート", "", "", ""), ("ドリッパー", "", "", ""),
            ("", "Amazon", "", ""), ("", "テスト珈琲", "food", ""), ("", "", "none", ""), ("", "", "", "2026-11"),
            ("", "", "", "2026-13"), ("  ", "存在しない店", "", ""), ("見つからない言葉", "", "", ""),
        ]
        for (q, s, c, m) in settings {
            model.query = q
            model.shop = s
            model.category = c
            model.month = m
            let values = DeliveredFilterValues(q: q, s: s, c: c, m: m)
            #expect(model.values == values)
            let expected = Delivered.filterDelivered(parcels, itemNames: names, values: values)
            #expect(model.shown?.map(\.id) == expected.map(\.id), "q=\(q) s=\(s) c=\(c) m=\(m)")
            #expect(model.count == expected.count)
            let groups = Delivered.groupByOrderMonth(expected)
            #expect(model.groups.map(\.label) == groups.map(\.label))
            #expect(model.groups.map { $0.parcels.map(\.id) } == groups.map { $0.parcels.map(\.id) })
            #expect(model.message == (expected.isEmpty ? DeliveredModel.noMatchText : nil))
            #expect(model.isNarrowed == !(q.isEmpty && s.isEmpty && c.isEmpty && m.isEmpty))
        }
    }

    @Test func theOptionsAndTheMonthAddedWhenNotInTheData() async throws {
        let w = try await world(parcels: Self.mixed, items: Self.mixedItems)
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        await model.load()
        let parcels = try #require(model.parcels?.value)
        let options = Delivered.deliveredFilterOptions(parcels)
        #expect(model.options == options)
        #expect(model.monthOptions == options.months)
        model.month = "2024-01"
        #expect(model.monthOptions == Delivered.monthChoices(options.months, m: "2024-01"))
        #expect(model.monthOptions.contains("2024-01"))
    }

    @Test func clearPutsEveryValueBack() async throws {
        let w = try await world(parcels: Self.mixed, items: Self.mixedItems)
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        await model.load()
        model.query = "ノート"
        model.shop = "文具店"
        model.category = "daily"
        model.month = "2025-12"
        #expect(model.isNarrowed)
        model.clear()
        #expect(model.query == "" && model.shop == "" && model.category == "" && model.month == "")
        #expect(!model.isNarrowed)
        #expect(model.count == 5)
    }

    @Test func noDeliveredParcelSaysSo() async throws {
        let w = try await world(parcels: [Self.delivered(1, ["status": "shipped"])])
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        await model.load()
        #expect(model.parcels == .loaded([]))
        #expect(model.message == DeliveredModel.emptyText)
        #expect(model.count == 0)
    }

    @Test(arguments: ["parcels", "parcel_items"])
    func eitherReadFailingIsReadFailed(_ resource: String) async throws {
        let w = try await world(parcels: Self.mixed, items: Self.mixedItems, faults: { await $0.fail("GET", resource, with: .http(500)) })
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        await model.load()
        #expect(model.message == DeliveredModel.failedText)
        #expect(model.shown == nil)
        #expect(model.count == nil)
        #expect(model.groups.isEmpty)
    }

    @Test func anOlderReadNeverReplacesANewerOne() async throws {
        let gate = Gate()
        let w = try await world(parcels: [Self.delivered(1, ["title": "前の品名"])], faults: { await $0.fail("GET", "parcels", with: .delay(gate)) })
        defer { gate.open() }
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        let first = Task { await model.load() }
        let fake = w.fake
        #expect(await waitFor { await fake.count("GET", "parcels") == 1 })
        await fake.touch("parcels", id: Rows.id(1), ["title": "新しい品名"])
        await model.load()
        #expect(model.shown?.first?.title == "新しい品名")
        gate.open()
        await first.value
        #expect(model.shown?.first?.title == "新しい品名")
    }

    @Test func readsAgainWhenStaleAndWhenBackInFront() async throws {
        let w = try await world(parcels: Self.mixed, items: Self.mixedItems)
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        await model.onAppear()
        let reads = await w.fake.count("GET", "parcels")
        #expect(reads >= 1)
        await model.onAppear()
        #expect(await w.fake.count("GET", "parcels") == reads)
        w.changes.publish()
        await model.onAppear()
        #expect(await w.fake.count("GET", "parcels") > reads)
        let again = await w.fake.count("GET", "parcels")
        await model.sceneBecameActive()
        #expect(await w.fake.count("GET", "parcels") > again)
    }

    @Test func undoingDeliveredTakesItOffTheDeliveredPage() async throws {
        let w = try await world(parcels: [Self.delivered(1, ["status": "shipped", "ordered_at": "2026-11-01"])])
        let writer = ParcelWriter(provider: w.provider, changes: w.changes)
        let parcels = ParcelReader(provider: w.provider)
        let row = try #require(await parcels.parcel(id: Rows.id(1)).value ?? nil)
        guard case let .success(token) = await writer.markDelivered(ParcelVersion(row)) else {
            Issue.record("markDelivered did not succeed")
            return
        }
        let model = DeliveredModel(reader: w.reader, changes: w.changes)
        await model.onAppear()
        #expect(model.shown?.map(\.id) == [Rows.id(1)])
        guard case .success = await writer.undoDelivered(token) else {
            Issue.record("undoDelivered did not succeed")
            return
        }
        await model.onAppear()
        #expect(model.shown?.isEmpty == true)
    }

    // MARK: the cancelled page

    @Test func theCancelledPageGroupsByOrderMonthAsTheWeb() async throws {
        let rows: [Row] = [
            Self.delivered(1, ["status": "cancelled", "ordered_at": "2026-10-01"]),
            Self.delivered(2, ["status": "cancelled", "ordered_at": "2026-11-03"]),
            Self.delivered(3, ["status": "cancelled", "ordered_at": nil]),
            Self.delivered(4, ["status": "cancelled", "ordered_at": "2026-11-03"]),
            Self.delivered(5, ["status": "delivered", "ordered_at": "2026-11-03"]),
            Self.delivered(6, ["status": "cancelled", "user_id": .string(FakeSupabase.other)]),
        ]
        let w = try await world(parcels: rows)
        let model = CancelledModel(reader: w.reader, changes: w.changes)
        await model.load()
        let got = try #require(model.parcels?.value)
        #expect(got.map(\.id) == StatusListReader.webOrder(got).map(\.id))
        #expect(Set(got.map(\.id)) == Set([1, 2, 3, 4].map(Rows.id)))
        let expected = Delivered.groupByOrderMonth(StatusListReader.webOrder(got))
        #expect(model.groups.map(\.label) == expected.map(\.label))
        #expect(model.groups.map { $0.parcels.map(\.id) } == expected.map { $0.parcels.map(\.id) })
        #expect(model.groups.last?.label == Delivered.noOrderDateLabel)
        #expect(model.count == 4)
        #expect(model.message == nil)
        for q in await w.fake.requests("GET", "parcels") {
            #expect(q.query("status") == ["eq.cancelled"])
            #expect(q.query("user_id") == ["eq.\(FakeSupabase.me)"])
        }
    }

    @Test func theCancelledPagesEmptyAndFailedWords() async throws {
        let empty = try await world(parcels: [Self.delivered(1)])
        let none = CancelledModel(reader: empty.reader, changes: empty.changes)
        await none.load()
        #expect(none.message == CancelledModel.emptyText)
        #expect(none.count == 0)

        let down = try await world(parcels: [Self.delivered(1, ["status": "cancelled"])], faults: { await $0.fail("GET", "parcels", with: .http(500)) })
        let failed = CancelledModel(reader: down.reader, changes: down.changes)
        await failed.load()
        #expect(failed.message == CancelledModel.failedText)
        #expect(failed.count == nil)
        #expect(failed.groups.isEmpty)
    }

    @Test func theCancelledPageReadsAgainBackInFrontAndWhenStale() async throws {
        let w = try await world(parcels: [Self.delivered(1, ["status": "cancelled"])])
        let model = CancelledModel(reader: w.reader, changes: w.changes)
        await model.onAppear()
        let reads = await w.fake.count("GET", "parcels")
        #expect(reads >= 1)
        await model.onAppear()
        #expect(await w.fake.count("GET", "parcels") == reads)
        w.changes.publish()
        await model.onAppear()
        let again = await w.fake.count("GET", "parcels")
        #expect(again > reads)
        await model.sceneBecameActive()
        #expect(await w.fake.count("GET", "parcels") > again)
    }

    // MARK: wired from the tabs

    @Test func theTabsMakeTheModelsWithTheSharedChanges() async throws {
        let fake = FakeSupabase.make()
        let (_, auth) = try await TestSession.signedIn(fake)
        let screens = MainScreens.live(auth: auth)
        #expect(screens.delivered().changes === screens.changes)
        #expect(screens.cancelled().changes === screens.changes)
        // The opened key's store and the one UnlockModel (tasks 16 to 19).
        let keys = try #require(screens.keys)
        #expect(auth.cleanup === keys)
        let unlock = try #require(screens.unlock)
        #expect(screens.detail(Rows.id(1)).unlock === unlock)
        #expect(screens.detail(Rows.id(1)).mailKeys != nil)
        #expect(screens.faceID != nil)
        #expect(screens.settings.faceID === screens.faceID)
    }
}
