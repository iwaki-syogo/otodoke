import Foundation
import Testing
@testable import Otodoke

/// The mail group of the settings list moves the rows that need something done to the top, as the Web's
/// orderRows does (settings-row.tsx, (list)/page.tsx): the key row (no key), 「うまく届かないとき」 (mail waiting to be
/// read), then 「メールの転送」 (a confirmation waiting for its approval), each only while it needs something;
/// everything else keeps the fixed order.
@Suite("Settings: the order of the mail rows")
@MainActor
struct SettingsOrderTests {
    private let fixed: [SettingsPage] = [.forward, .key, .dropped, .handling, .delivery, .sample]

    // MARK: the rule itself

    @Test func withNothingToDoTheOrderIsTheFixedOne() {
        #expect(SettingsView.orderedMailPages(actions: []) == fixed)
        #expect(SettingsView.mailOrder == fixed)
    }

    @Test func eachConditionMovesItsRowAlone() {
        #expect(SettingsView.orderedMailPages(actions: [.forward]) == fixed)
        #expect(SettingsView.orderedMailPages(actions: [.key]) == [.key, .forward, .dropped, .handling, .delivery, .sample])
        #expect(SettingsView.orderedMailPages(actions: [.delivery]) == [.delivery, .forward, .key, .dropped, .handling, .sample])
    }

    @Test func severalConditionsGoInTheWebsOrderKeyThenTroubleThenForwarding() {
        #expect(SettingsView.orderedMailPages(actions: [.forward, .delivery, .key]) == [.key, .delivery, .forward, .dropped, .handling, .sample])
        #expect(SettingsView.orderedMailPages(actions: [.forward, .delivery]) == [.delivery, .forward, .key, .dropped, .handling, .sample])
        #expect(SettingsView.orderedMailPages(actions: [.forward, .key]) == [.key, .forward, .dropped, .handling, .delivery, .sample])
    }

    @Test func rowsThatNeverMoveStayWhereTheyAreAndNothingIsLostOrRepeated() {
        for actions in [Set<SettingsPage>(), [.key], [.delivery], [.forward], [.key, .delivery, .forward], [.dropped, .handling, .sample]] {
            let ordered = SettingsView.orderedMailPages(actions: actions)
            #expect(ordered.count == 6)
            #expect(Set(ordered) == Set(fixed))
            // .dropped, .handling and .sample are never moved: they keep their order among themselves.
            #expect(ordered.filter { [.dropped, .handling, .sample].contains($0) } == [.dropped, .handling, .sample])
        }
        #expect(SettingsView.orderedMailPages(actions: [.dropped, .handling, .sample]) == fixed)
    }

    // MARK: what the model says needs doing

    private func model(keys: [Row] = [SettingsRows.key(1, keyID: "k1")], mails: [Row] = [], unread: Int = 0, faults: (FakeSupabase) async -> Void = { _ in }) async throws -> SettingsModel {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", keys)
        await fake.insert("emails", mails)
        await fake.setUnreadEmails(unread)
        await faults(fake)
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            consent: .allowedForTests(),
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: DataChanges(),
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
        await model.load()
        return model
    }

    private func confirmation() -> Row {
        SettingsRows.mail(1, [
            "classification": "forwarding_confirmation",
            "created_at": "2026-11-03T00:00:00+00:00",
            "sent_at": "2026-11-03T00:00:00+00:00",
            "forwarding_confirm_url": .string(SettingsRows.google),
        ])
    }

    @Test func nothingToDoKeepsTheFixedOrder() async throws {
        let m = try await model()
        #expect(SettingsView.actionPages(for: m).isEmpty)
        #expect(SettingsView.mailPages(for: m) == fixed)
    }

    @Test func noKeyMovesTheKeyRowUp() async throws {
        let m = try await model(keys: [])
        #expect(SettingsView.actionPages(for: m) == [.key])
        #expect(SettingsView.mailPages(for: m).first == .key)
    }

    @Test func mailWaitingToBeReadMovesTheTroubleRowUp() async throws {
        let m = try await model(unread: 2)
        #expect(SettingsView.actionPages(for: m) == [.delivery])
        #expect(SettingsView.mailPages(for: m).first == .delivery)
    }

    @Test func aConfirmationWaitingForApprovalMovesNothingBeforeTheForwardRow() async throws {
        let m = try await model(mails: [confirmation()])
        #expect(m.approvalWaiting)
        #expect(SettingsView.actionPages(for: m) == [.forward])
        #expect(SettingsView.mailPages(for: m) == fixed)
    }

    @Test func allThreeAtOnceGoKeyTroubleForward() async throws {
        let m = try await model(keys: [], mails: [confirmation()], unread: 3)
        #expect(SettingsView.mailPages(for: m) == [.key, .delivery, .forward, .dropped, .handling, .sample])
    }

    @Test func aCountOrKeyThatCouldNotBeReadIsNotSomethingToDo() async throws {
        // The Web: a read that failed shows the red 確認できません and does not move the row (action is false).
        let failedKey = try await model(faults: { await $0.fail("GET", "user_keys", with: .http(500)) })
        #expect(failedKey.keyPanel == .failed)
        #expect(SettingsView.actionPages(for: failedKey).contains(.key) == false)
        let failedUnread = try await model(unread: 2, faults: { await $0.fail(where: { !$0.query("or").isEmpty }, with: .http(500)) })
        #expect(failedUnread.unread == .failed)
        #expect(SettingsView.actionPages(for: failedUnread).contains(.delivery) == false)
    }
}
