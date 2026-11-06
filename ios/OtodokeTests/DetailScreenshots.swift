import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// [Task 8, implementer's own] Pictures of the detail page for checking by eye, drawn from the fake
/// Supabase (never the real one). Runs only when TEST_RUNNER_OTODOKE_SCREENSHOT_DIR is given to
/// xcodebuild; writes PNGs there.
@Suite("Detail screenshots (task 8, on request)", .enabled(if: ScreenshotTarget.directory != nil), .serialized)
@MainActor
struct DetailScreenshots {

    private static let rich: Row = [
        "shop": "テスト雑貨店", "title": "ステンレス保温ボトル 500ml ネイビー（架空の品）", "status": "delivered", "needs_review": true,
        "carrier": "ヤマト運輸", "tracking_number": "1234-5678-9012",
        "expected_date": "2026-11-05", "expected_date_end": "2026-11-07", "expected_text": "11月5日〜7日 午前中",
        "expected_window_start": "08:00:00", "expected_window_end": "12:00:00",
        "requires_presence": true, "presence_evidence": "お受け取りの際にサインが必要です",
        "ordered_at": "2026-10-30", "order_number": "A-0001-TEST", "total_amount": 12_345, "category": "food",
    ]

    private func seedRich(_ fake: FakeSupabase, _ over: Row = [:]) async {
        var row = Self.rich
        for (k, v) in over { row[k] = v }
        await fake.insert("parcels", [Rows.parcel(1, row)])
        await fake.insert("parcel_items", [
            Rows.item(1, parcel: 1, ["name": "ステンレス保温ボトル 500ml", "quantity": 2, "unit_price": 3_980]),
            Rows.item(2, parcel: 1, ["name": "替えパッキン", "quantity": 1, "unit_price": nil]),
        ])
        await fake.insert("extractions", [
            Rows.extraction(1, parcel: 1, email: Rows.email(1, ["subject": "ご注文ありがとうございます", "classification": "order", "sent_at": "2026-10-30T03:12:00+00:00"]), ["confidence": 0.93]),
            Rows.extraction(2, parcel: 1, email: Rows.email(2, [
                "subject": "商品を発送しました", "classification": "shipped", "sent_at": "2026-11-02T09:45:00+00:00", "text_body": nil,
                "html_body": "<p>テスト雑貨店です。</p><p>ご注文の商品を発送しました。</p><table><tr><td>伝票番号</td><td>1234-5678-9012</td></tr></table>",
            ]), ["confidence": 0.875, "result": ["notes": "金額は注文メールから"]]),
            Rows.extraction(3, parcel: 1, email: Rows.email(3, ["subject": "お荷物お届け完了のお知らせ", "classification": "delivered", "sent_at": "2026-11-04T02:30:00+00:00", "from_name": nil]), ["confidence": nil]),
        ])
    }

    private func loadedModel(_ fake: FakeSupabase) async throws -> ParcelDetailModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
        await model.load()
        return model
    }

    @Test func richLightDarkAndLargeText() async throws {
        let fake = FakeSupabase.make()
        await seedRich(fake)
        let model = try await loadedModel(fake)
        let open: Set<String> = [Rows.id(20_002)]
        try await shoot(ParcelDetailView(model: model, initiallyOpen: open), "detail-1-light")
        try await shoot(ParcelDetailView(model: model, initiallyOpen: open), "detail-2-dark", style: .dark)
        try await shoot(ParcelDetailView(model: model), "detail-3-large-text", size: .accessibility2)
        try await shoot(ParcelDetailView(model: model, initiallyOpen: open), "detail-4-scrolled", offset: 700)
    }

    @Test func notDeliveredSpinnerAndError() async throws {
        let fake = FakeSupabase.make()
        await seedRich(fake)
        let model = try await loadedModel(fake)
        let gate = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(gate))
        let task = Task { await model.markNotDelivered() }
        _ = await waitFor { await fake.count("PATCH", "parcels") == 1 }
        try await shoot(ParcelDetailView(model: model), "detail-5-not-delivered-spinner")
        gate.open()
        await task.value
        // Then someone else moves it on: the write finds nothing to change.
        _ = await fake.touch("parcels", id: Rows.id(1), ["status": "delivered"])
        let again = try await loadedModel(fake)
        _ = await fake.touch("parcels", id: Rows.id(1), ["status": "shipped"])
        await again.markNotDelivered()
        try await shoot(ParcelDetailView(model: again), "detail-6-not-delivered-error")
    }

    @Test func manualSagawaWithItemsAndMailsFailing() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, [
            "shop": "手入力の店", "title": nil, "status": "shipped", "source": "manual", "carrier": "佐川急便",
            "tracking_number": "1234-5678-9012", "requires_presence": false, "category": nil,
        ])])
        await fake.fail("GET", "parcel_items", with: .http(500))
        await fake.fail("GET", "extractions", with: .transport(.notConnectedToInternet))
        let model = try await loadedModel(fake)
        try await shoot(ParcelDetailView(model: model), "detail-7-manual-sagawa-failures")
        try await shoot(
            CopyThenOpenSheet(url: URL(string: "https://e-customer.sagawa-exp.co.jp/k2k")!, number: "123456789012", shown: "1234-5678-9012", pageName: "佐川のお荷物お問い合わせサービス", carrierName: "佐川急便"),
            "detail-8-sagawa-sheet", navigation: false
        )
    }

    @Test func amazonLittleKnownAndNoMail() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, [
            "shop": "Amazon.co.jp", "shop_key": "amazon", "title": "USB-C ケーブル 1m（架空の品）", "status": "ordered",
            "order_number": "250-1234567-1234567", "category": "bogus",
        ])])
        let model = try await loadedModel(fake)
        try await shoot(ParcelDetailView(model: model), "detail-9-amazon")
    }

    @Test func theParcelReadFailing() async throws {
        let fake = FakeSupabase.make()
        await fake.fail("GET", "parcels", with: .http(500))
        let model = try await loadedModel(fake)
        try await shoot(ParcelDetailView(model: model), "detail-10-read-failed")
    }

    @Test func theCategorySheet() async throws {
        try await shoot(
            CategorySheet(current: .food, picked: .hobby, isSaving: true, error: nil, choose: { _ in }, close: {}),
            "detail-11-category-saving", navigation: false
        )
        try await shoot(
            CategorySheet(current: .food, picked: .hobby, isSaving: false, error: "保存できませんでした", choose: { _ in }, close: {}),
            "detail-12-category-error", navigation: false, style: .dark
        )
    }

    // MARK: drawing

    private func shoot(
        _ view: some View, _ name: String, navigation: Bool = true, style: UIUserInterfaceStyle = .light,
        size: DynamicTypeSize = .large, offset: CGFloat = 0
    ) async throws {
        let dir = try #require(ScreenshotTarget.directory)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = style
        let root = Group {
            if navigation {
                NavigationStack { view.navigationTitle("") }
            } else {
                view.background(Color(.systemBackground))
            }
        }
        .environment(\.dynamicTypeSize, size)
        let host = UIHostingController(rootView: root)
        window.rootViewController = host
        window.makeKeyAndVisible()
        try await Task.sleep(for: .milliseconds(1200))
        if offset > 0, let scroll = Self.firstScrollView(in: host.view) {
            scroll.setContentOffset(CGPoint(x: 0, y: min(offset, max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom))), animated: false)
            try await Task.sleep(for: .milliseconds(500))
        }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try #require(image.pngData()).write(to: dir.appending(path: "\(name).png"))
        window.isHidden = true
        window.rootViewController = nil
    }

    private static func firstScrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView, scroll.contentSize.height > scroll.bounds.height { return scroll }
        for sub in view.subviews {
            if let found = firstScrollView(in: sub) { return found }
        }
        return nil
    }
}

private enum ScreenshotTarget {
    static let directory = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"].map { URL(fileURLWithPath: $0) }
}
