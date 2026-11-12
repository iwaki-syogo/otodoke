import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// [Batch 2, M1, review fix 1, implementer's own] Pictures for checking by eye: the spend screen's whole
/// period (N1: no column cut in half at the left), and the settings screen with the old-key count and
/// the forwarding confirmation failing (S2). Light and dark, from the fake Supabase (never the real
/// one). Runs only when TEST_RUNNER_OTODOKE_FIX1_SHOTS is given to xcodebuild; writes PNGs there.
@Suite("Review fix 1 screenshots (on request)", .enabled(if: ReviewFix1ShotTarget.directory != nil), .serialized)
@MainActor
struct ReviewFix1Screenshots {
    @Test func spendTheWholePeriod() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", CalendarSpendScreenshots.spendRows)
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = SpendModel(reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), changes: nil, today: { CalendarSpendScreenshots.today })
        await model.load()
        await model.showAll()
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "n1-spend-all-light")
        try await shoot(SpendView(model: model) { _ in EmptyView() }, "n1-spend-all-dark", style: .dark)
    }

    @Test func settingsWithTheTwoReadsFailing() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", [
            SettingsRows.mail(1),
            SettingsRows.mail(2, ["body_state": "sealed", "body_envelope": ["kid": "k0"]]),
            SettingsRows.mail(3, ["classification": "forwarding_confirmation", "sent_at": "2026-11-03T00:00:00+00:00",
                                  "forwarding_confirm_url": .string(SettingsRows.google)]),
        ])
        await fake.fail(where: { !$0.query("body_envelope->>kid").isEmpty }, with: .http(500))
        await fake.fail(where: { $0.url.lastPathComponent == "emails" && $0.query("classification") == ["eq.forwarding_confirmation"] }, with: .http(500))
        try await settings(fake, "s2-settings-failed")
    }

    @Test func settingsWithTheTwoReadsDone() async throws {
        // For comparison: the old-key line and the approval card as they are when read.
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", [
            SettingsRows.mail(1),
            SettingsRows.mail(2, ["body_state": "sealed", "body_envelope": ["kid": "k0"]]),
            SettingsRows.mail(3, ["classification": "forwarding_confirmation", "sent_at": "2026-11-03T00:00:00+00:00",
                                  "forwarding_confirm_url": .string(SettingsRows.google)]),
        ])
        try await settings(fake, "s2-settings-read")
    }

    private func settings(_ fake: FakeSupabase, _ name: String) async throws {
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            consent: .allowedForTests(),
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 7, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { Date() }
        )
        await model.load()
        try await shoot(SettingsView(model: model), "\(name)-light")
        try await shoot(SettingsView(model: model), "\(name)-dark", style: .dark)
    }

    // MARK: drawing (as CalendarSpendScreenshots)

    private func shoot(_ view: some View, _ name: String, style: UIUserInterfaceStyle = .light) async throws {
        let dir = try #require(ReviewFix1ShotTarget.directory)
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        for _ in 0..<100 where scene.activationState != .foregroundActive {
            try await Task.sleep(for: .milliseconds(100))
        }
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        try await Task.sleep(for: .milliseconds(1500))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try #require(image.pngData()).write(to: dir.appending(path: "\(name).png"))
        window.isHidden = true
        window.rootViewController = nil
    }
}

private enum ReviewFix1ShotTarget {
    static let directory = ProcessInfo.processInfo.environment["OTODOKE_FIX1_SHOTS"].map { URL(fileURLWithPath: $0) }
}
