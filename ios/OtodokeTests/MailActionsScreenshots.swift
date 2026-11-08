import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// 「これは荷物」 (after the press) and the unread card's 「読み取る」, drawn from made-up rows (FakeSupabase and a stub
/// of the Web's mail endpoints: nothing leaves the test), saved as PNGs in light and dark for checking by eye. Runs
/// only when OTODOKE_SHOTS_DIR is set (xcodebuild: TEST_RUNNER_OTODOKE_SHOTS_DIR=<dir>); otherwise every case is skipped.
@Suite("Mail action screenshots (only with OTODOKE_SHOTS_DIR)", .serialized)
@MainActor
struct MailActionsScreenshots {
    nonisolated static let dir = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"]

    enum Scenario: String, CaseIterable, Sendable {
        case droppedRemembered = "dropped-remembered"
        case droppedShared = "dropped-shared"
        case droppedFailed = "dropped-failed"
        case droppedBusy = "dropped-busy"
        case unreadCard = "unread-card"
        case unreadBusy = "unread-busy"
        case unreadFailed = "unread-failed"
    }

    @Test(.enabled(if: dir != nil), arguments: Scenario.allCases)
    func shoot(_ scenario: Scenario) async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("screen_events", [
            SettingsRows.dropped(1, ["subject": "【秋のセール】最大 50% オフ", "from_domain": "news.example.com"]),
            SettingsRows.dropped(2, ["subject": "ポイントが失効します", "from_domain": "point.example.jp", "flagged_at": "2026-11-02T00:00:00+00:00"]),
            SettingsRows.dropped(3, ["subject": "ご注文ありがとうございます", "from_domain": "shop.example.com"]),
        ])
        await fake.setUnreadEmails(2)
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
        let server = FakeMailServer.make(supabase: fake)
        let actions = MailActionsModel(
            api: MailActionsClient(baseURL: server.baseURL, session: server.urlSession),
            accessToken: { try? await provider.auth.session.accessToken },
            reload: { [unowned model] in await model.load() }
        )
        model.mailActions = actions
        let first = Rows.id(60_001)
        let gate = Gate()
        var pending: Task<Void, Never>?

        switch scenario {
        case .droppedRemembered:
            await actions.markAsParcel(id: first)
        case .droppedShared:
            await server.setOutcome(.shared)
            await actions.markAsParcel(id: first)
        case .droppedFailed:
            await server.force("mark-parcel", .answer(status: 503, ok: false, code: "unavailable"))
            await actions.markAsParcel(id: first)
        case .droppedBusy:
            await server.hold("mark-parcel", on: gate)
            pending = Task { await actions.markAsParcel(id: first) }
            try await waitFor(server, "mark-parcel")
        case .unreadCard:
            break
        case .unreadBusy:
            await server.hold("read-waiting", on: gate)
            pending = Task { await actions.readWaiting() }
            try await waitFor(server, "read-waiting")
        case .unreadFailed:
            await server.force("read-waiting", .answer(status: 500, ok: false, code: "read_failed"))
            await actions.readWaiting()
            // The failed run leaves mail waiting (the card stays, with the sentence under the button).
            await fake.setUnreadEmails(2)
            await model.load()
        }

        let isDropped = scenario.rawValue.hasPrefix("dropped")
        for style in [UIUserInterfaceStyle.light, .dark] {
            let view = isDropped ? SettingsView(model: model, expanded: true, page: .dropped) : SettingsView(model: model)
            let image = try await Self.render(view, style: style, height: isDropped ? 900 : 760)
            let name = "mail-\(scenario.rawValue)-\(style == .dark ? "dark" : "light").png"
            try #require(image.pngData()).write(to: URL(fileURLWithPath: try #require(Self.dir)).appendingPathComponent(name))
        }
        gate.open()
        await pending?.value
    }

    private func waitFor(_ server: FakeMailServer, _ endpoint: String) async throws {
        for _ in 0..<200 where await server.count(endpoint) < 1 {
            try await Task.sleep(for: .milliseconds(25))
        }
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
