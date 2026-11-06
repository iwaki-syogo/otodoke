import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// [password-login, implementer's own] Pictures for checking by eye, light and dark: the login screen (signing
/// in; making an account with a password that breaks the rule; not confirmed yet with the confirmation mail
/// again; the mail sent after making an account) and the password field that opens the key. Nothing is signed
/// in or sent (the screen check's models), and the Turnstile widget is left out (nothing loads from
/// Cloudflare). Runs only when OTODOKE_SHOTS_DIR is given (xcodebuild: TEST_RUNNER_OTODOKE_SHOTS_DIR=<dir>);
/// writes PNGs there.
enum PasswordShots {
    nonisolated static let dir = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"]
}

@Suite("Password login screenshots (on request)", .enabled(if: PasswordShots.dir != nil), .serialized)
@MainActor
struct PasswordLoginScreenshots {
    enum Scenario: String, CaseIterable, Sendable {
        case signIn = "login"
        case signUp = "login-signup"
        case notConfirmed = "login-error"
        case sent = "login-sent"
    }

    @Test(arguments: Scenario.allCases)
    func login(_ scenario: Scenario) async throws {
        let fake = FakeSupabase.make()
        let model = LoginModel(auth: PW.auth(fake), launch: LaunchOptions(arguments: []))
        switch scenario {
        case .signIn:
            model.debugShow(mode: .signIn, email: "qa@example.com", password: "kumo-no-ue-2026")
        case .signUp:
            model.debugShow(mode: .signUp, email: "qa@example.com", password: "password1234", again: "password1234")
        case .notConfirmed:
            model.debugShow(mode: .signIn, email: "qa@example.com", error: LoginText.notConfirmed, canResend: true)
        case .sent:
            model.debugShow(mode: .signUp, email: "qa@example.com", notice: LoginText.signupExistsOrSent)
        }
        for style in [UIUserInterfaceStyle.light, .dark] {
            try await Self.shoot(LoginView(model: model, withWidget: false), name: "pw-\(scenario.rawValue)-\(style == .dark ? "dark" : "light")", style: style, height: 1100)
        }
    }

    @Test func unlockField() async throws {
        let w = try UnlockWorld()
        _ = await w.model.key()
        _ = await w.model.submit(password: "ちがうパスワードです", email: UnlockWorld.email)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let view = VStack { UnlockView(model: w.model) }.padding(16).frame(maxHeight: .infinity, alignment: .top)
            try await Self.shoot(view, name: "pw-unlock-\(style == .dark ? "dark" : "light")", style: style, height: 400)
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
        let url = URL(fileURLWithPath: try #require(PasswordShots.dir)).appendingPathComponent("\(name).png")
        try #require(image.pngData()).write(to: url)
    }
}
