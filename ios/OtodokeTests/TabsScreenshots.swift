import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// [Batch 2, task 12, implementer's own] The four tabs as MainTabView shows them (荷物・カレンダー・
/// 支出・設定), light and dark, for checking by eye. Drawn from the fake Supabase (never the real one)
/// with made-up shops and goods. Runs only when TEST_RUNNER_OTODOKE_TABS_SHOTS_DIR is given to
/// xcodebuild; writes PNGs there.
@Suite("Tabs screenshots (batch 2, task 12, on request)", .enabled(if: TabsShotTarget.directory != nil), .serialized)
@MainActor
struct TabsScreenshots {
    nonisolated static let today = "2026-11-04"

    @Test func everyTabLightAndDark() async throws {
        for tab in MainTab.allCases {
            for style in [UIUserInterfaceStyle.light, .dark] {
                let screens = try await Self.screens()
                let name = "tab-\(Self.name(tab))-\(style == .dark ? "dark" : "light")"
                try await shoot(MainTabView(screens: screens, selection: tab), name, style: style)
            }
        }
    }

    private static func name(_ tab: MainTab) -> String {
        switch tab {
        case .parcels: "1-parcels"
        case .calendar: "2-calendar"
        case .spend: "3-spend"
        case .settings: "4-settings"
        }
    }

    /// Each tab reads its own fake (made-up rows in the shapes the tabs' own screenshots use).
    private static func screens() async throws -> MainScreens {
        let changes = DataChanges()

        let parcelsFake = FakeSupabase.make()
        await parcelsFake.insert("parcels", CalendarSpendScreenshots.calendarRows)
        let (parcelsProvider, _) = try await TestSession.signedIn(parcelsFake)
        let reader = ParcelReader(provider: parcelsProvider)
        let writer = ParcelWriter(provider: parcelsProvider, changes: changes)
        let list = ParcelListModel(reader: reader, writer: writer, today: { Self.today }, now: { ISO.date("2026-11-04T03:00:00Z")! }, sleep: ControlledSleeper().sleep)
        let calendar = CalendarModel(reader: reader, changes: changes, today: { Self.today })

        let spendFake = FakeSupabase.make()
        await spendFake.insert("parcels", CalendarSpendScreenshots.spendRows)
        let (spendProvider, _) = try await TestSession.signedIn(spendFake)
        let spend = SpendModel(reader: ParcelReader(provider: spendProvider), writer: ParcelWriter(provider: spendProvider, changes: changes), changes: changes, today: { Self.today })

        let settingsFake = FakeSupabase.make()
        await settingsFake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await settingsFake.insert("emails", [
            SettingsRows.mail(1),
            SettingsRows.mail(2, ["classification": "forwarding_confirmation", "sent_at": "2026-11-03T00:00:00+00:00",
                                  "forwarding_confirm_url": .string(SettingsRows.google)]),
        ])
        await settingsFake.insert("screen_events", [
            SettingsRows.dropped(1, ["subject": "【秋のセール】最大 50% オフ", "from_domain": "news.example.com"]),
        ])
        await settingsFake.setUnreadEmails(2)
        let (settingsProvider, auth) = try await TestSession.signedIn(settingsFake)
        let settings = SettingsModel(
            consent: .allowedForTests(),
            reader: SettingsReader(provider: settingsProvider),
            inbox: InboxAddressService(provider: settingsProvider, randomBytes: { Array(repeating: 7, count: $0) }),
            auth: auth,
            inboundDomain: settingsFake.config.inboundDomain,
            changes: changes,
            now: { Date() }
        )

        return MainScreens(
            changes: changes, list: list, calendar: calendar, spend: spend, settings: settings,
            detail: { id in ParcelDetailModel(id: id, reader: reader, writer: writer, today: { Self.today }) }
        )
    }

    // MARK: drawing (drawHierarchy, so the tab bar's glass is drawn; it comes out blank while the
    // Mac's screen sleeps)

    private func shoot(_ view: some View, _ name: String, style: UIUserInterfaceStyle) async throws {
        let dir = try #require(TabsShotTarget.directory)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        for _ in 0..<100 where scene.activationState != .foregroundActive {
            try await Task.sleep(for: .milliseconds(100))
        }
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = style
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        // The tab's .task reads the fake; give it time to come back and draw.
        try await Task.sleep(for: .milliseconds(2000))
        window.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try #require(image.pngData()).write(to: dir.appending(path: "\(name).png"))
    }
}

private enum TabsShotTarget {
    static let directory = ProcessInfo.processInfo.environment["OTODOKE_TABS_SHOTS_DIR"].map { URL(fileURLWithPath: $0) }
}
