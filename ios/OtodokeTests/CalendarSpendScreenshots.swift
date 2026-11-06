import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// [Batch 2, tasks 7 and 9, implementer's own] Pictures of the calendar and the spend screen (a month,
/// the whole period, narrowed), light and dark, for checking by eye. Drawn from the fake Supabase (never
/// the real one) with made-up shops and goods. Runs only when TEST_RUNNER_OTODOKE_SCREENSHOT_DIR is
/// given to xcodebuild; writes PNGs there.
@Suite("Calendar and spend screenshots (batch 2, tasks 7 and 9, on request)", .enabled(if: CalendarSpendShotTarget.directory != nil), .serialized)
@MainActor
struct CalendarSpendScreenshots {
    nonisolated static let today = "2026-11-04"

    static let calendarRows: [Row] = [
        Rows.parcel(1, ["expected_date": "2026-11-04", "shop": "テスト雑貨店", "title": "ステンレス保温ボトル（架空の品）", "status": "out_for_delivery", "requires_presence": true, "expected_window_start": "14:00:00", "expected_window_end": "16:00:00"]),
        Rows.parcel(2, ["expected_date": "2026-11-05", "shop": "サンプル書店", "title": "文庫本 3 冊（架空）", "status": "shipped", "requires_presence": false]),
        Rows.parcel(3, ["expected_date": "2026-11-05", "shop": "例のアウトドア店", "title": "折りたたみチェア（架空の品）", "status": "shipped", "requires_presence": nil, "expected_window_start": "08:00:00", "expected_window_end": "12:00:00"]),
        Rows.parcel(4, ["expected_date": "2026-11-07", "expected_date_end": "2026-11-09", "shop": "Amazon.co.jp", "shop_key": "amazon", "title": "USB-C ケーブル 2 本（架空）", "status": "ordered"]),
        Rows.parcel(5, ["expected_date": "2026-11-12", "shop": "テスト食品", "title": "冷凍の詰め合わせ（架空）", "status": "ordered", "requires_presence": true]),
        Rows.parcel(6, ["expected_date": "2026-11-20", "shop": "サンプル家電", "title": "電気ケトル（架空の品）", "status": "ordered", "requires_presence": nil]),
        Rows.parcel(7, ["expected_date": "2026-11-02", "shop": "テスト雑貨店", "title": "届いたもの", "status": "delivered"]),
    ]

    static var spendRows: [Row] {
        let plan: [(String, Int?, String?, String, String?)] = [
            ("2026-11-02", 3280, "food", "テスト食品", nil),
            ("2026-11-03", 12800, "electronics", "サンプル家電", nil),
            ("2026-11-03", 1980, nil, "Amazon.co.jp", "amazon"),
            ("2026-11-01", nil, "hobby", "例のアウトドア店", nil),
            ("2026-10-20", 4500, "fashion", "テスト衣料", nil),
            ("2026-10-05", 2600, "daily", "Amazon.co.jp", "amazon"),
            ("2026-09-14", 8800, "hobby", "例のアウトドア店", nil),
            ("2026-08-30", 1500, "beauty", "サンプル薬局", nil),
            ("2026-06-11", 5400, "food", "テスト食品", nil),
            ("2026-02-08", 23000, "electronics", "サンプル家電", nil),
            ("2025-12-24", 6200, "other", "テスト雑貨店", nil),
            ("2025-11-15", 3900, "daily", "Amazon.co.jp", "amazon"),
        ]
        var rows: [Row] = plan.enumerated().map { i, p in
            let r: Row = [
                "ordered_at": .string(p.0),
                "category": p.2.map(JSONValue.string) ?? .null,
                "shop": .string(p.3),
                "title": .string("注文 \(i + 1)（架空の品）"),
                "status": "delivered",
                "total_amount": p.1.map(JSONValue.int) ?? .null,
                "shop_key": p.4.map(JSONValue.string) ?? .null,
            ]
            return Rows.parcel(i + 1, r)
        }
        rows.append(Rows.parcel(50, ["ordered_at": nil, "total_amount": 900, "category": "food", "shop": "テスト食品", "title": "注文日の無い注文（架空）"]))
        return rows
    }

    @Test func calendarLightAndDark() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.calendarRows)
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = CalendarModel(reader: ParcelReader(provider: provider), changes: nil, today: { Self.today })
        await model.load()
        try await shoot(CalendarView(model: model) { _ in EmptyView() }, "calendar-1-light")
        try await shoot(CalendarView(model: model) { _ in EmptyView() }, "calendar-2-dark", style: .dark)
        try await shoot(CalendarView(model: model) { _ in EmptyView() }, "calendar-3-days-light", offset: 480)
        try await shoot(CalendarView(model: model) { _ in EmptyView() }, "calendar-4-days-dark", style: .dark, offset: 480)
    }

    @Test func spendMonthAllAndNarrowed() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.spendRows)
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = SpendModel(reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), changes: nil, today: { Self.today })
        await model.load()
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "spend-1-month-light")
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "spend-2-month-dark", style: .dark)
        await model.showAll()
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "spend-3-all-light")
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "spend-4-all-dark", style: .dark)
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "spend-5-all-orders-light", offset: 900)
        await model.toggleCategory(.electronics)
        await model.toggleShop("サンプル家電")
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "spend-6-narrowed-light")
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "spend-7-narrowed-dark", style: .dark)
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "spend-8-narrowed-orders-dark", style: .dark, offset: 900)
    }

    // MARK: drawing (as MailHistoryScreenshots)

    private func shoot(_ view: some View, _ name: String, style: UIUserInterfaceStyle = .light, offset: CGFloat = 0) async throws {
        let dir = try #require(CalendarSpendShotTarget.directory)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        try await Task.sleep(for: .milliseconds(1500))
        if offset > 0, let scroll = Self.firstScrollView(in: host.view) {
            let bottom = max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            scroll.setContentOffset(CGPoint(x: 0, y: min(offset, bottom) - scroll.adjustedContentInset.top), animated: false)
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

    /// The first vertical scroll view taller than its bounds.
    private static func firstScrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView, scroll.contentSize.height > scroll.bounds.height, scroll.contentSize.width <= scroll.bounds.width + 1 { return scroll }
        for sub in view.subviews {
            if let found = firstScrollView(in: sub) { return found }
        }
        return nil
    }
}

private enum CalendarSpendShotTarget {
    static let directory = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"].map { URL(fileURLWithPath: $0) }
}
