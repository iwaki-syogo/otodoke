import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// The settings screen drawn from made-up rows (FakeSupabase: nothing leaves the test), saved as PNGs
/// in light and dark for checking by eye. Runs only when OTODOKE_SHOTS_DIR is set (xcodebuild:
/// TEST_RUNNER_OTODOKE_SHOTS_DIR=<dir>); otherwise every case is skipped.
@Suite("Settings screenshots (only with OTODOKE_SHOTS_DIR)", .serialized)
@MainActor
struct SettingsScreenShots {
    nonisolated static let dir = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"]

    enum Scenario: String, CaseIterable, Sendable {
        /// The key row could not be read.
        case keyFailed = "key-failed"
        /// No key in use.
        case keyNone = "key-none"
        /// A key in use: the address, the approval, unread mail, mail that was not read.
        case keyPresent = "key-present"
        /// As keyPresent, with the guide's cards and the not-read list open.
        case guideOpen = "guide-open"
        /// Unencrypted mail (5) with the old-key count failed: the amber warning stays.
        case amberOldKeyFailed = "amber-oldkey-failed"
        /// The unencrypted count failed: 確認できません.
        case plainFailed = "plain-failed"
    }

    @Test(.enabled(if: dir != nil), arguments: Scenario.allCases)
    func shoot(_ scenario: Scenario) async throws {
        let model = try await Self.model(scenario)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let name = "settings-\(scenario.rawValue)-\(style == .dark ? "dark" : "light").png"
            let height: CGFloat = 1100
            let image = try await Self.render(SettingsView(model: model, expanded: scenario == .guideOpen), style: style, height: height)
            let url = URL(fileURLWithPath: try #require(Self.dir)).appendingPathComponent(name)
            try #require(image.pngData()).write(to: url)
        }
    }

    /// Each page of the list, drawn with the key in use (the guide and the not-read list open), and the key page
    /// in its other two states.
    @Test(.enabled(if: dir != nil), arguments: SettingsPage.allCases)
    func shootPage(_ page: SettingsPage) async throws {
        let model = try await Self.model(.keyPresent)
        try await shootBoth(SettingsView(model: model, expanded: true, page: page), "page-\(page)", height: page == .handling ? 2400 : page == .forward ? 3900 : 1500)
    }

    /// The video credit is under the cards once and always: nothing open and only Gmail open, in both forms.
    @Test(.enabled(if: dir != nil), arguments: [("closed", Set<String>()), ("gmail", Set(["gmail"]))])
    func shootVideoCredit(_ state: (String, Set<String>)) async throws {
        for servicesOnly in [false, true] {
            let view = ScrollView { ForwardingGuideView(servicesOnly: servicesOnly, openIDs: state.1).padding(16) }
            try await shootBoth(view, "video-credit-\(state.0)-\(servicesOnly ? "onboarding" : "page")", height: state.0 == "gmail" ? 1700 : 900)
        }
    }

    @Test(.enabled(if: dir != nil), arguments: [Scenario.keyFailed, .keyNone])
    func shootKeyPage(_ scenario: Scenario) async throws {
        let model = try await Self.model(scenario)
        try await shootBoth(SettingsView(model: model, page: .key), "page-key-\(scenario.rawValue)", height: 900)
    }

    private func shootBoth(_ view: some View, _ name: String, height: CGFloat) async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let image = try await Self.render(view, style: style, height: height)
            let url = URL(fileURLWithPath: try #require(Self.dir)).appendingPathComponent("settings-\(name)-\(style == .dark ? "dark" : "light").png")
            try #require(image.pngData()).write(to: url)
        }
    }

    private static func model(_ scenario: Scenario) async throws -> SettingsModel {
        let fake = FakeSupabase.make()
        switch scenario {
        case .keyFailed:
            await fake.insert("emails", [SettingsRows.mail(1)])
            await fake.fail("GET", "user_keys", with: .http(500))
        case .keyNone:
            await fake.insert("emails", [SettingsRows.mail(1), SettingsRows.mail(2), SettingsRows.mail(3)])
        case .amberOldKeyFailed:
            await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
            await fake.insert("emails", (1...5).map { SettingsRows.mail($0) })
            await fake.fail(where: { $0.query("body_state") == ["eq.sealed"] }, with: .http(503))
        case .plainFailed:
            await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
            await fake.fail(where: { !$0.query("provider_email_id").isEmpty }, with: .http(500))
        case .keyPresent, .guideOpen:
            await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
            await fake.insert("emails", [
                SettingsRows.mail(1),
                SettingsRows.mail(2),
                SettingsRows.mail(3, ["body_state": "sealed", "body_envelope": ["kid": "k0"]]),
                SettingsRows.mail(4, ["classification": "forwarding_confirmation", "sent_at": "2026-11-03T00:00:00+00:00",
                                      "forwarding_confirm_url": .string(SettingsRows.google)]),
            ])
            await fake.insert("screen_events", [
                SettingsRows.dropped(1, ["subject": "【秋のセール】最大 50% オフ", "from_domain": "news.example.com"]),
                SettingsRows.dropped(2, ["subject": "ポイントが失効します", "from_domain": "point.example.jp", "flagged_at": "2026-11-02T00:00:00+00:00"]),
                SettingsRows.dropped(3, ["subject": nil, "from_domain": "ads.example.com"]),
            ])
            await fake.setUnreadEmails(2)
        }
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 7, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { Date() }
        )
        await model.load()
        return model
    }

    private static func render(_ view: some View, style: UIUserInterfaceStyle, height: CGFloat) async throws -> UIImage {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        // Drawn before the host app is in front, the image comes out blank.
        for _ in 0..<100 where scene.activationState != .foregroundActive {
            try await Task.sleep(for: .milliseconds(100))
        }
        try await Task.sleep(for: .seconds(1))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: height)
        window.overrideUserInterfaceStyle = style
        window.rootViewController = UIHostingController(rootView: view)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(800))
        window.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        // Taller than about 8,000 pixels draws nothing: the scale comes down for the long page.
        format.scale = min(2, 7_800 / height)
        // layer.render draws in this process: drawHierarchy goes through the render server and comes
        // out blank while the Mac's screen is asleep.
        return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
    }
}
