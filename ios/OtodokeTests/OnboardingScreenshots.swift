import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// [onboarding] Pictures for checking by eye, light and dark: the waiting screen after making an account (plain,
/// not confirmed yet, mail sent again) and the first guide (key made, with the Gmail approval, no key). Nothing is
/// sent (FakeSupabase and the screen check's models); the Turnstile widget is left out. Runs only when
/// OTODOKE_SHOTS_DIR is given (xcodebuild: TEST_RUNNER_OTODOKE_SHOTS_DIR=<dir>).
@Suite("Onboarding screenshots (on request)", .enabled(if: OnboardingShots.dir != nil), .serialized)
@MainActor
struct OnboardingScreenshots {
    enum Waiting: String, CaseIterable, Sendable {
        case plain, notYet = "not-yet", resent, error
    }

    @Test(arguments: Waiting.allCases)
    func waiting(_ scenario: Waiting) async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            // A model for each picture: leaving the screen (the first picture's window closing) lets the wait go.
            let model = LoginModel(auth: PW.auth(FakeSupabase.make()), launch: LaunchOptions(arguments: []))
            switch scenario {
            case .plain: model.debugShowWaiting(email: "qa@example.com")
            case .notYet: model.debugShowWaiting(email: "qa@example.com", notice: OnboardingText.notConfirmedYet)
            case .resent: model.debugShowWaiting(email: "qa@example.com", notice: OnboardingText.resent)
            case .error: model.debugShowWaiting(email: "qa@example.com", error: LoginText.network)
            }
            try await Self.shoot(LoginView(model: model, withWidget: false), name: "waiting-\(scenario.rawValue)-\(style == .dark ? "dark" : "light")", style: style, height: 900)
        }
    }

    enum KeyBoxShot: String, CaseIterable, Sendable {
        case notOpened = "not-opened", failed
    }

    /// The amber box after the waiting screen's sign-in whose key did not open (or could not be made).
    @Test(arguments: KeyBoxShot.allCases)
    func keyBox(_ scenario: KeyBoxShot) async throws {
        let text = KeyBox.text(for: scenario == .notOpened ? .needsWebLogin : .failed(message: LoginText.keyFailed)) ?? ""
        for style in [UIUserInterfaceStyle.light, .dark] {
            let name = "key-box-" + scenario.rawValue + "-" + (style == .dark ? "dark" : "light")
            try await Self.shoot(KeyBoxView(text: text, proceed: {}, openKeyPage: {}), name: name, style: style, height: 600)
        }
    }

    enum Guide: String, CaseIterable, Sendable {
        case address, approval, noKey = "no-key"
    }

    @Test(arguments: Guide.allCases)
    func guide(_ scenario: Guide) async throws {
        let fake = FakeSupabase.make()
        switch scenario {
        case .address:
            await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        case .approval:
            await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
            await fake.insert("emails", [SettingsRows.mail(4, ["classification": "forwarding_confirmation", "sent_at": "2026-11-03T00:00:00+00:00",
                                                                "forwarding_confirm_url": .string(SettingsRows.google)])])
        case .noKey:
            break
        }
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 7, count: $0) }),
            auth: auth, inboundDomain: fake.config.inboundDomain, changes: DataChanges(), now: { Date() }
        )
        await model.load()
        for style in [UIUserInterfaceStyle.light, .dark] {
            try await Self.shoot(OnboardingView(model: model, finish: {}), name: "guide-\(scenario.rawValue)-\(style == .dark ? "dark" : "light")", style: style, height: 1400)
        }
    }

    private static func shoot(_ view: some View, name: String, style: UIUserInterfaceStyle, height: CGFloat) async throws {
        let scene = try #require(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        for _ in 0..<100 where scene.activationState != .foregroundActive {
            try await Task.sleep(for: .milliseconds(100))
        }
        try await Task.sleep(for: .milliseconds(500))
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: height)
        window.overrideUserInterfaceStyle = style
        window.rootViewController = UIHostingController(rootView: view)
        window.isHidden = false
        defer { window.isHidden = true }
        try await Task.sleep(for: .milliseconds(800))
        window.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        let url = URL(fileURLWithPath: try #require(OnboardingShots.dir)).appendingPathComponent("\(name).png")
        try #require(image.pngData()).write(to: url)
    }
}

enum OnboardingShots {
    nonisolated static let dir = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"]
}
