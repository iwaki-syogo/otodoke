import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// [Batch 2, tasks 18, 19, 21, 22, implementer's own] Pictures for checking by eye, light and dark: a sealed
/// mail before opening, the passphrase field (and a wrong passphrase), 「開いています…」, opened (the vector's
/// made-up mail, from the git-ignored vectors), opened on a device that cannot keep the key; the delivered page
/// (as read, searched, narrowed with 「クリア」, a month); the cancelled page; the settings' Face ID switch.
/// Drawn from the fake Supabase with made-up shops and goods (nothing leaves the test). Runs only when
/// OTODOKE_SHOTS_DIR is given (xcodebuild: TEST_RUNNER_OTODOKE_SHOTS_DIR=<dir>); writes PNGs there.
@Suite("M2 screenshots (tasks 18, 19, 21, 22, on request)", .enabled(if: M2bShots.dir != nil), .serialized)
@MainActor
struct M2bScreenshots {
    // MARK: task 18: the sealed mail

    struct Sealed {
        let fake: FakeSupabase
        let unlock: UnlockWorld
        let detail: ParcelDetailModel
        let emailID: String
    }

    func sealed(availability: BiometricAvailability = .available(.faceID), faults: (FakeSupabase) async -> Void = { _ in }) async throws -> Sealed {
        let v = try EnvelopeVector()
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, [
            "shop": "テスト雑貨店", "title": "ステンレス保温ボトル（架空の品）", "status": "shipped",
            "expected_date": "2026-11-08", "ordered_at": "2026-11-01", "total_amount": 3_980,
        ])])
        let sealedMail = Rows.email(1, [
            "id": .string(v.emailID), "subject": nil, "from_address": nil, "from_name": nil, "text_body": nil, "html_body": nil,
            "body_state": "sealed", "from_domain": "example.test", "classification": "shipped", "sent_at": "2026-11-02T09:45:00+00:00",
        ])
        await fake.insert("extractions", [Rows.extraction(1, parcel: 1, email: sealedMail, ["email_id": .string(v.emailID), "confidence": 0.93])])
        await fake.insert("emails", [[
            "id": .string(v.emailID), "user_id": .string(FakeSupabase.me), "body_state": "sealed",
            "body_envelope": JSONValue(any: v.envelopeObject),
            "subject": nil, "text_body": nil, "html_body": nil, "sent_at": "2026-11-02T09:45:00+00:00",
        ]])
        await fake.insert("user_keys", [v.keyRow(userID: FakeSupabase.me)])
        await faults(fake)
        let (provider, auth) = try await TestSession.signedIn(fake)
        let u = try UnlockWorld(session: auth.session, availability: availability)
        auth.cleanup = u.store
        let detail = ParcelDetailModel(id: Rows.id(1), reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider), today: { "2026-11-06" })
        detail.unlock = u.model
        detail.mailKeys = MailKeyReader(provider: provider)
        await detail.load()
        return Sealed(fake: fake, unlock: u, detail: detail, emailID: v.emailID)
    }

    private static let mailCard: Set<String> = [Rows.id(20_001)]

    @Test func sealedMail() async throws {
        let before = try await sealed()
        try await shootBoth(ParcelDetailView(model: before.detail), "t18-1-before", height: 1100)

        let asking = try await sealed()
        await asking.detail.openSealed(emailID: asking.emailID)
        try await shootBoth(ParcelDetailView(model: asking.detail, initiallyOpen: Self.mailCard), "t18-2-passphrase", height: 1200)
        await asking.detail.submitPassphrase("ちがう合言葉ちがう合言葉", emailID: asking.emailID)
        try await shootBoth(ParcelDetailView(model: asking.detail, initiallyOpen: Self.mailCard), "t18-3-wrong-passphrase", height: 1200)

        let gate = Gate()
        let opening = try await sealed(faults: { await $0.fail("GET", "emails", with: .hold(gate)) })
        opening.unlock.plantVaultKey()
        let task = Task { await opening.detail.openSealed(emailID: opening.emailID) }
        let fake = opening.fake
        _ = await waitFor { await fake.count("GET", "emails") == 1 }
        try await shootBoth(ParcelDetailView(model: opening.detail, initiallyOpen: Self.mailCard), "t18-4-opening", height: 1200)
        gate.open()
        await task.value

        let opened = try await sealed()
        opened.unlock.plantVaultKey()
        await opened.detail.openSealed(emailID: opened.emailID)
        try await shootBoth(ParcelDetailView(model: opened.detail, initiallyOpen: Self.mailCard).environment(\.scenePhase, .active), "t18-5-opened", height: 1400)

        // A device with no passcode: opened with the passphrase, kept in memory only.
        let memory = try await sealed(availability: .noPasscode)
        await memory.detail.openSealed(emailID: memory.emailID)
        await memory.detail.submitPassphrase(memory.unlock.v.passphrase, emailID: memory.emailID)
        #expect(memory.unlock.model.saveResult == .memoryOnly)
        try await shootBoth(ParcelDetailView(model: memory.detail, initiallyOpen: Self.mailCard).environment(\.scenePhase, .active), "t18-6-cannot-save", height: 1400)

    }

    // MARK: tasks 21, 22: the delivered and cancelled pages

    static var deliveredRows: [Row] {
        let plan: [(String?, String, String?, String, String?)] = [
            ("2026-11-03", "テスト珈琲", nil, "コーヒー豆 200g（架空の品）", "food"),
            ("2026-11-02", "Amazon.co.jp", "amazon", "ＵＳＢ－Ｃ ケーブル 2 本（架空）", "electronics"),
            ("2026-11-01", "サンプル書店", nil, "文庫本 3 冊（架空）", "hobby"),
            ("2026-10-21", "テスト雑貨店", nil, "ステンレス保温ボトル（架空の品）", "daily"),
            ("2026-10-05", "Amazonマーケットプレイス", "amazon", "替えパッキン（架空）", nil),
            ("2026-09-14", "例のアウトドア店", nil, "折りたたみチェア（架空の品）", "hobby"),
            (nil, "サンプル家電", nil, "電気ケトル（架空の品）", "electronics"),
        ]
        return plan.enumerated().map { i, p in
            Rows.parcel(i + 1, [
                "status": "delivered",
                "ordered_at": p.0.map(JSONValue.string) ?? .null,
                "shop": .string(p.1),
                "shop_key": p.2.map(JSONValue.string) ?? .null,
                "title": .string(p.3),
                "category": p.4.map(JSONValue.string) ?? .null,
                "expected_date": "2026-11-05",
                "requires_presence": false,
            ])
        }
    }

    @Test func deliveredPage() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.deliveredRows)
        await fake.insert("parcel_items", [Rows.item(1, parcel: 4, ["name": "保温ボトル用の替えパッキン"])])
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = DeliveredModel(reader: StatusListReader(provider: provider), changes: nil)
        await model.load()
        let page = { NavigationStack { DeliveredView(model: model) { _ in EmptyView() } } }
        try await shootBoth(page(), "t21-1-all", height: 1700)
        model.query = "ｕｓｂ"
        try await shootBoth(page(), "t21-2-search", height: 900)
        model.query = "パッキン"
        try await shootBoth(page(), "t21-3-search-item-name", height: 1100)
        model.query = ""
        model.shop = "Amazon"
        model.category = "electronics"
        try await shootBoth(page(), "t21-4-narrowed-clear", height: 900)
        model.clear()
        model.month = "2026-10"
        try await shootBoth(page(), "t21-5-month", height: 1000)
        model.clear()
        model.query = "見つからない言葉"
        try await shootBoth(page(), "t21-6-no-match", height: 800)

        let empty = FakeSupabase.make()
        let (p2, _) = try await TestSession.signedIn(empty)
        let none = DeliveredModel(reader: StatusListReader(provider: p2), changes: nil)
        await none.load()
        try await shootBoth(NavigationStack { DeliveredView(model: none) { _ in EmptyView() } }, "t21-7-empty", height: 700)

        let down = FakeSupabase.make()
        await down.fail("GET", "parcel_items", with: .http(500))
        let (p3, _) = try await TestSession.signedIn(down)
        let failed = DeliveredModel(reader: StatusListReader(provider: p3), changes: nil)
        await failed.load()
        try await shootBoth(NavigationStack { DeliveredView(model: failed) { _ in EmptyView() } }, "t21-8-failed", height: 700)
    }

    @Test func cancelledPage() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [
            Rows.parcel(1, ["status": "cancelled", "ordered_at": "2026-11-02", "shop": "テスト雑貨店", "title": "マグカップ（架空の品）", "expected_date": nil]),
            Rows.parcel(2, ["status": "cancelled", "ordered_at": "2026-10-12", "shop": "サンプル書店", "title": "図鑑（架空）", "expected_date": nil]),
            Rows.parcel(3, ["status": "cancelled", "ordered_at": "2026-10-03", "shop": "Amazon.co.jp", "shop_key": "amazon", "title": "モバイルバッテリー（架空）", "expected_date": nil]),
            Rows.parcel(4, ["status": "cancelled", "ordered_at": nil, "shop": "例のアウトドア店", "title": "テント（架空の品）", "expected_date": nil]),
        ])
        let (provider, _) = try await TestSession.signedIn(fake)
        let model = CancelledModel(reader: StatusListReader(provider: provider), changes: nil)
        await model.load()
        try await shootBoth(NavigationStack { CancelledView(model: model) { _ in EmptyView() } }, "t22-1-cancelled", height: 1200)

        let empty = FakeSupabase.make()
        let (p2, _) = try await TestSession.signedIn(empty)
        let none = CancelledModel(reader: StatusListReader(provider: p2), changes: nil)
        await none.load()
        try await shootBoth(NavigationStack { CancelledView(model: none) { _ in EmptyView() } }, "t22-2-empty", height: 600)
    }

    // MARK: task 19: the settings switch

    @Test func faceIDSwitch() async throws {
        let v = try EnvelopeVector()
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [v.keyRow(userID: FakeSupabase.me)])
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 7, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { Date() }
        )
        let policy = KeyStorePolicy(defaults: scratchDefaults())
        let vault = KeyVault(keychain: FakeKeychain(), biometrics: FakeBiometrics(.available(.faceID)), policy: policy, service: UnlockWorld.service)
        let toggle = FaceIDSwitch(policy: policy, vault: vault)
        model.faceID = toggle
        await model.load()
        try await shootBoth(SettingsView(model: model), "t19-1-switch-on", height: 1200)
        toggle.set(false)
        try await shootBoth(SettingsView(model: model), "t19-2-switch-off", height: 1200)
        try await shootBoth(SettingsView(model: model), "t19-3-mail-handling", height: 5200)
    }

    // MARK: drawing (as SettingsScreenShots)

    private func shootBoth(_ view: some View, _ name: String, height: CGFloat) async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let image = try await Self.render(view, style: style, height: height)
            let url = URL(fileURLWithPath: try #require(M2bShots.dir)).appendingPathComponent("\(name)-\(style == .dark ? "dark" : "light").png")
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try #require(image.pngData()).write(to: url)
        }
    }

    private static func render(_ view: some View, style: UIUserInterfaceStyle, height: CGFloat) async throws -> UIImage {
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
        try await Task.sleep(for: .milliseconds(900))
        window.layoutIfNeeded()
        let format = UIGraphicsImageRendererFormat()
        format.scale = min(2, 7_800 / height)
        return UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
    }
}

enum M2bShots {
    static let dir = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"]
}
