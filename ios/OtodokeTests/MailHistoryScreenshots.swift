import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// [Batch 2, task 3, implementer's own] Pictures of 「メールの履歴」 with a plain, a sealed, a dropped and an
/// unknown-state mail, light and dark, for checking by eye. Drawn from the fake Supabase (never the real
/// one). Runs only when TEST_RUNNER_OTODOKE_SCREENSHOT_DIR is given to xcodebuild; writes PNGs there.
@Suite("Mail history screenshots (batch 2, task 3, on request)", .enabled(if: MailShotTarget.directory != nil), .serialized)
@MainActor
struct MailHistoryScreenshots {
    private static let closedMail: Row = ["subject": nil, "from_name": nil, "from_address": nil, "text_body": nil, "html_body": nil]

    private func seed(_ fake: FakeSupabase) async {
        await fake.insert("parcels", [Rows.parcel(1, ["shop": "テスト雑貨店", "title": "ステンレス保温ボトル（架空の品）", "requires_presence": true])])
        var sealed = Self.closedMail
        sealed["body_state"] = "sealed"
        sealed["from_domain"] = "shop.example.com"
        sealed["classification"] = "shipped"
        sealed["sent_at"] = "2026-11-02T09:45:00+00:00"
        var dropped = Self.closedMail
        dropped["body_state"] = "dropped"
        dropped["from_domain"] = "mail.example.jp"
        dropped["classification"] = "order"
        dropped["sent_at"] = "2026-10-30T03:12:00+00:00"
        await fake.insert("extractions", [
            Rows.extraction(1, parcel: 1, email: Rows.email(1, dropped), ["confidence": 0.9, "result": ["notes": "金額は注文メールから"]]),
            Rows.extraction(2, parcel: 1, email: Rows.email(2, sealed), ["confidence": 0.875]),
            Rows.extraction(3, parcel: 1, email: Rows.email(3, [
                "body_state": "plain", "subject": "お荷物お届け完了のお知らせ", "classification": "delivered",
                "sent_at": "2026-11-04T02:30:00+00:00", "text_body": "テスト雑貨店です。\nお荷物をお届けしました。",
            ]), ["confidence": 0.95]),
            Rows.extraction(4, parcel: 1, email: Rows.email(4, ["body_state": "future_state", "sent_at": "2026-11-04T05:00:00+00:00"])),
        ])
    }

    @Test func plainSealedDroppedLightAndDark() async throws {
        let fake = FakeSupabase.make()
        await seed(fake)
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-04" })
        await model.load()
        guard case let .loaded(entries)? = model.timeline else {
            Issue.record("the mail history did not load")
            return
        }
        let open = Set(entries.map(\.id))
        try await shoot(ParcelDetailView(model: model, initiallyOpen: open), "mails-1-light", offset: 2000)
        try await shoot(ParcelDetailView(model: model, initiallyOpen: open), "mails-2-dark", style: .dark, offset: 2000)
        try await shoot(ParcelDetailView(model: model), "mails-3-closed-light", offset: 2000)
        try await shoot(ParcelDetailView(model: model), "mails-4-closed-dark", style: .dark, offset: 2000)
    }

    // MARK: drawing (as DetailScreenshots)

    private func shoot(_ view: some View, _ name: String, style: UIUserInterfaceStyle = .light, offset: CGFloat = 0) async throws {
        let dir = try #require(MailShotTarget.directory)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: NavigationStack { view.navigationTitle("") })
        window.rootViewController = host
        window.makeKeyAndVisible()
        try await Task.sleep(for: .milliseconds(1200))
        if offset > 0, let scroll = Self.firstScrollView(in: host.view) {
            let bottom = max(0, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            scroll.setContentOffset(CGPoint(x: 0, y: min(offset, bottom)), animated: false)
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

private enum MailShotTarget {
    static let directory = ProcessInfo.processInfo.environment["OTODOKE_SCREENSHOT_DIR"].map { URL(fileURLWithPath: $0) }
}
