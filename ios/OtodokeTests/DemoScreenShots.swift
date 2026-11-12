import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// 「サンプルで試す」 drawn from a fake endpoint (nothing leaves the test), saved as PNGs in light and dark for checking
/// by eye. Runs only when OTODOKE_SHOTS_DIR is set (xcodebuild: TEST_RUNNER_OTODOKE_SHOTS_DIR=<dir>).
@Suite("Demo screenshots (only with OTODOKE_SHOTS_DIR)", .serialized)
@MainActor
struct DemoScreenShots {
    nonisolated static let dir = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"]

    private struct Canned: DemoAPI {
        let load: Result<DemoLoaded, DemoFailure>
        let clear: Result<Void, DemoFailure>
        func load(accessToken: String) async -> Result<DemoLoaded, DemoFailure> { load }
        func clear(accessToken: String) async -> Result<Void, DemoFailure> { clear }
    }

    enum Scenario: String, CaseIterable, Sendable {
        case plain, clearOpen = "clear-open", loadFailed = "load-failed", partial, cleared, clearConfirm = "clear-confirm", busyNote = "busy-note"
    }

    @Test(.enabled(if: dir != nil), arguments: Scenario.allCases)
    func shoot(_ scenario: Scenario) async throws {
        var load: Result<DemoLoaded, DemoFailure> = .success(DemoLoaded(processed: 97, busy: false))
        if scenario == .loadFailed { load = .failure(.answered(.demoFailed, processed: nil)) }
        if scenario == .partial { load = .failure(.answered(.demoFailed, processed: 31)) }
        let (settings, demo) = try await Self.make(load: load)
        var clearOpen = false
        switch scenario {
        case .plain: break
        case .clearOpen: clearOpen = true
        case .loadFailed, .partial: await demo.load()
        case .cleared: _ = await demo.clear(confirmed: true)
        case .clearConfirm:
            clearOpen = true
            _ = await demo.clear(confirmed: false)
        case .busyNote: break
        }
        let view: AnyView = scenario == .busyNote
            ? AnyView(DemoBusyNote(open: {}).frame(maxHeight: .infinity, alignment: .top))
            : AnyView(NavigationStack { SettingsSamplePage(model: settings, clearOpen: clearOpen) })
        for style in [UIUserInterfaceStyle.light, .dark] {
            let image = try await Self.render(view, style: style, height: scenario == .busyNote ? 260 : 820)
            let url = URL(fileURLWithPath: try #require(Self.dir)).appendingPathComponent("demo-\(scenario.rawValue)-\(style == .dark ? "dark" : "light").png")
            try #require(image.pngData()).write(to: url)
        }
    }

    private static func make(load: Result<DemoLoaded, DemoFailure>) async throws -> (SettingsModel, DemoModel) {
        let fake = FakeSupabase.make()
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            consent: .allowedForTests(),
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { Date() }
        )
        let demo = DemoModel(api: Canned(load: load, clear: .success(())), accessToken: { "tok" }, changed: {})
        model.demo = demo
        return (model, demo)
    }

    private static func render(_ view: some View, style: UIUserInterfaceStyle, height: CGFloat) async throws -> UIImage {
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
        format.scale = 2
        return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { _ in
            window.layer.render(in: UIGraphicsGetCurrentContext()!)
        }
    }
}
