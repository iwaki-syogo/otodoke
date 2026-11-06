import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// The settings list and the first screen at an accessibility text size, saved as PNGs for checking by eye.
/// Runs only when OTODOKE_SHOTS_DIR is set (xcodebuild: TEST_RUNNER_OTODOKE_SHOTS_DIR=<dir>).
@Suite("Accessibility-size screenshots (only with OTODOKE_SHOTS_DIR)", .serialized)
@MainActor
struct AccessibilitySizeScreenshots {
    nonisolated static let dir = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"]

    private static func make(failedCounts: Bool) async throws -> (SettingsModel, AuthService) {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", [SettingsRows.mail(1), SettingsRows.mail(2)])
        if failedCounts {
            await fake.fail(where: { !$0.query("provider_email_id").isEmpty }, with: .http(500))
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
        return (model, auth)
    }

    @Test(.enabled(if: dir != nil))
    func theListAndTheFirstScreenAtAccessibility3() async throws {
        let (model, auth) = try await Self.make(failedCounts: false)
        let (failedModel, _) = try await Self.make(failedCounts: true)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let tag = style == .dark ? "dark" : "light"
            try await shoot(SettingsView(model: model).environment(\.dynamicTypeSize, .accessibility3), "ax3-list-amber-\(tag)", style: style, height: 2200)
            try await shoot(SettingsView(model: failedModel).environment(\.dynamicTypeSize, .accessibility3), "ax3-list-red-\(tag)", style: style, height: 2200)
            try await shoot(SettingsView(model: model).environment(\.dynamicTypeSize, .large), "large-list-\(tag)", style: style, height: 1000)
            try await shoot(WelcomeView(auth: auth).environment(\.dynamicTypeSize, .accessibility3), "ax3-welcome-\(tag)", style: style, height: 874)
            try await shoot(WelcomeView(auth: auth).environment(\.dynamicTypeSize, .large), "large-welcome-\(tag)", style: style, height: 874)
        }
    }

    private func shoot(_ view: some View, _ name: String, style: UIUserInterfaceStyle, height: CGFloat) async throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
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
        format.scale = min(2, 7_800 / height)
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        let url = URL(fileURLWithPath: try #require(Self.dir)).appendingPathComponent("refresh-\(name).png")
        try #require(image.pngData()).write(to: url)
    }
}
