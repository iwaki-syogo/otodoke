import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// The screens of this batch, drawn from made-up rows (FakeSupabase and a stub of the Web's mail endpoints: nothing leaves
/// the test), saved as PNGs for checking by eye: the typed-in parcel's edit that says "changed", the three reasons under
/// 「未読のメールが N 通あります」, and the sentence under 「読み取る」 after a stopped / over-the-limit answer. Runs only when
/// OTODOKE_SHOTS_DIR is set (xcodebuild: TEST_RUNNER_OTODOKE_SHOTS_DIR=<dir>); otherwise every case is skipped.
@Suite("Claude stopped screenshots (only with OTODOKE_SHOTS_DIR)", .serialized)
@MainActor
struct ClaudeStoppedScreenshots {
    nonisolated static let dir = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"]

    enum Scenario: String, CaseIterable, Sendable {
        case manualChanged = "manual-edit-changed"
        case reasonsAll = "reasons-all-three"
        case reasonsStopped = "reasons-stopped-only"
        case reasonsOverLimit = "reasons-over-limit-only"
        case reasonsFailed = "reasons-failed-only"
        case reasonsUnknown = "reasons-not-read"
        case readStopped = "read-notice-stopped"
        case readOverLimit = "read-notice-over-limit"
    }

    private static let stopped = SettingsRows.mail(1, ["processing_status": "failed", "error": "claude_unavailable", "created_at": "2026-11-02T10:00:00+00:00"])
    private static let over = SettingsRows.mail(2, ["processing_status": "over_limit", "error": "user", "created_at": "2026-11-02T10:00:00+00:00"])
    private static let failed = SettingsRows.mail(3, ["processing_status": "failed", "error": "claude_error", "created_at": "2026-11-02T10:00:00+00:00"])

    @Test(.enabled(if: dir != nil), arguments: Scenario.allCases)
    func shoot(_ scenario: Scenario) async throws {
        if scenario == .manualChanged {
            try await shootManualChanged()
            return
        }
        // A new database, model and window for every picture: the page reads again when it appears and clears the
        // "read" sentence when it goes, so one model drawn twice (light, then dark) shows neither the same state nor the sentence.
        for style in [UIUserInterfaceStyle.light, .dark] {
            let model = try await Self.makeModel(scenario)
            let image = try await Self.render(SettingsView(model: model, page: .delivery, register: {}), style: style, height: 760)
            try Self.write(image, "\(scenario.rawValue)-\(style == .dark ? "dark" : "light").png")
        }
    }

    private static func makeModel(_ scenario: Scenario) async throws -> SettingsModel {
        let rows: [Row]
        switch scenario {
        case .reasonsAll: rows = [stopped, over, failed]
        case .reasonsStopped, .readStopped: rows = [stopped]
        case .reasonsOverLimit, .readOverLimit: rows = [over]
        case .reasonsFailed: rows = [failed]
        case .reasonsUnknown: rows = [stopped]
        case .manualChanged: rows = []
        }
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", rows)
        await fake.setUnreadEmails(rows.count)
        let (provider, auth) = try await TestSession.signedIn(fake)
        if scenario == .reasonsUnknown {
            // Every read of the unread rows fails (the load, and the reads the page makes when it appears).
            for nth in 1...6 {
                await fake.fail(where: { $0.method == "GET" && ($0.query("select").first ?? "").contains("processing_status") }, nth: nth, with: .http(500))
            }
        }
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 7, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
        await model.load()
        let server = FakeMailServer.make(supabase: fake)
        let actions = MailActionsModel(
            api: MailActionsClient(baseURL: server.baseURL, session: server.urlSession),
            accessToken: { try? await provider.auth.session.accessToken },
            reload: { [unowned model] in await model.load() }
        )
        model.mailActions = actions
        switch scenario {
        case .readStopped:
            await server.force("read-waiting", .answer(status: 200, ok: true, code: nil, extra: ["over_limit": false, "busy": false, "stopped": true]))
            await actions.readWaiting()
        case .readOverLimit:
            await server.force("read-waiting", .answer(status: 200, ok: true, code: nil, extra: ["over_limit": true, "busy": false, "stopped": false]))
            await actions.readWaiting()
        default:
            break
        }
        // The fake servers live as long as the model's provider and mail client hold them.
        keepAlive.append((fake, server))
        return model
    }

    nonisolated(unsafe) private static var keepAlive: [(FakeSupabase, FakeMailServer)] = []

    /// The edit sheet after 保存 found the parcel changed since the form was opened.
    private func shootManualChanged() async throws {
        let row = try Rows.parcelRow(Rows.parcel(1, ["source": "manual", "title": "架空の本", "shop": "サンプル書店", "status": "ordered"]))
        let model = ManualParcelModel(
            editing: row,
            update: { _, _, _ in .changed },
            delete: { .success($0) },
            stillThere: { true },
            userID: { FakeSupabase.me },
            reload: {}
        )
        model.input.title = "架空の本（上下巻）"
        await model.submit()
        #expect(model.error == ManualParcelText.changed)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let image = try await Self.render(ManualParcelView(model: model, close: {}), style: style, height: 1700)
            try Self.write(image, "manual-edit-changed-\(style == .dark ? "dark" : "light").png")
        }
    }

    private static func write(_ image: UIImage, _ name: String) throws {
        try #require(image.pngData()).write(to: URL(fileURLWithPath: try #require(dir)).appendingPathComponent(name))
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
        format.scale = min(2, 7_800 / height)
        return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
    }
}
