import SwiftUI
import Testing
import UIKit
@testable import Otodoke

/// The actual cards are rendered locally at phone widths; no simulator or network is launched here.
@Suite("Settings mail recovery local rendering", .serialized)
@MainActor
struct SettingsMailRecoveryRenderingTests {
    private func world() async throws -> (FakeSupabase, SettingsModel) {
        let fake = FakeSupabase.make()
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            consent: .allowedForTests(), reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider), auth: auth,
            inboundDomain: fake.config.inboundDomain, changes: DataChanges(), now: { Date() }
        )
        return (fake, model)
    }

    private func render(_ view: some View, width: CGFloat, dark: Bool, name: String) throws -> UIImage {
        let renderer = ImageRenderer(content: view.padding(16).frame(width: width)
            .background(Color(.systemBackground)).environment(\.colorScheme, dark ? .dark : .light))
        renderer.scale = 1
        let image = try #require(renderer.uiImage)
        #expect(image.size.width == width)
        #expect(image.size.height > 0)
        if let directory = ProcessInfo.processInfo.environment["OTODOKE_SHOTS_DIR"] {
            let url = URL(fileURLWithPath: directory).appendingPathComponent("settings-recovery-\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
            try #require(image.pngData()).write(to: url)
        }
        return image
    }

    @Test func intakeCardRendersWithZeroAndFailedUnreadCountsAt320And390Points() async throws {
        let (fake, model) = try await world()
        await fake.setUnreadEmails(0)
        await model.load()
        for failedUnread in [false, true] {
            await fake.mutate { $0["mail_intake_notices"] = [] }
            if failedUnread {
                await fake.failAlways(where: { $0.url.lastPathComponent == "emails" && !$0.query("or").isEmpty }, with: .http(500))
            }
            await model.load()
            for width in [CGFloat(320), CGFloat(390)] {
                for dark in [false, true] {
                    let absent = try render(SettingsStatusRows(model: model, register: {}), width: width, dark: dark, name: "intake-absent")
                    await fake.mutate { tables in
                        tables["mail_intake_notices"] = [["user_id": .string(FakeSupabase.me), "limited_at": .string(SettingsMailRecoveryTests.stamp)]]
                    }
                    await model.load()
                    #expect(model.intakeNotice == .loaded(SettingsMailRecoveryTests.stamp))
                    #expect(failedUnread ? model.unread == .failed : model.unread == .loaded(0))
                    let present = try render(SettingsStatusRows(model: model, register: {}), width: width, dark: dark, name: "intake-present")
                    #expect(present.size.height > absent.size.height + 80)
                    await fake.mutate { $0["mail_intake_notices"] = [] }
                    await model.load()
                }
            }
        }
    }

    @Test func rememberedRowsAndRemoveButtonsRenderOutsideTheDroppedDisclosure() async throws {
        let (fake, model) = try await world()
        await model.load()
        for width in [CGFloat(320), CGFloat(390)] {
            for dark in [false, true] {
                let empty = try render(SettingsDroppedPage(model: model, register: {}).rememberedSection, width: width, dark: dark, name: "sender-empty")
                await fake.mutate { tables in
                    tables["screen_events"] = [
                        SettingsRows.dropped(1, ["from_domain": "shop.example.test", "flagged_at": .string(SettingsMailRecoveryTests.stamp)]),
                        SettingsRows.dropped(2, ["from_domain": "another-long-shop.example.test", "flagged_at": .string(SettingsMailRecoveryTests.stamp)]),
                    ]
                }
                await model.load()
                #expect(model.rememberedSenders?.value?.count == 2)
                let populated = try render(SettingsDroppedPage(model: model, register: {}).rememberedSection, width: width, dark: dark, name: "senders")
                #expect(populated.size.height >= empty.size.height + 88)
                await fake.mutate { $0["screen_events"] = [] }
                await model.load()
            }
        }
    }
}
