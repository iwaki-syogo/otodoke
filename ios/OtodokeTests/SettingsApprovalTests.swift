import Foundation
import Testing
@testable import Otodoke

/// The Gmail approval, read as the Web's origin/dev 84255fc reads it (src/app/app/settings/settings-reads.ts):
/// the newest few confirmation mails by created_at (CONFIRMATION_LOOKBACK = 10), the first whose link is Google's own;
/// the card shows whenever such a mail exists; the list's 「承認待ち」 badge is decided by time (nothing arrived after
/// that mail's created_at).
@Suite("Settings: the approval as the Web reads it")
@MainActor
struct SettingsApprovalTests {
    private static let real = SettingsRows.google

    /// A confirmation mail made at `day` (2026-11-<day>), with `over` on top.
    private func confirmation(_ n: Int, day: Int, _ over: Row = [:]) -> Row {
        var row: Row = [
            "classification": "forwarding_confirmation",
            "created_at": .string(String(format: "2026-11-%02dT00:00:00+00:00", day)),
            "sent_at": .string(String(format: "2026-11-%02dT00:00:00+00:00", day)),
        ]
        for (k, v) in over { row[k] = v }
        return SettingsRows.mail(n, row)
    }

    private func model(mails: [Row], dropped: [Row] = [], faults: (FakeSupabase) async -> Void = { _ in }) async throws -> SettingsModel {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", mails)
        await fake.insert("screen_events", dropped)
        await faults(fake)
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
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

    // MARK: which confirmation is picked

    @Test func theLookbackIsTheWebs() {
        #expect(SettingsReader.confirmationLookback == 10)
    }

    @Test func aLookAlikeThatIsTheNewestDoesNotHideTheRealOne() async throws {
        // Two forged ones are newer than the real one: no link at all, and a link that is not Google's.
        let m = try await model(mails: [
            confirmation(1, day: 3, ["forwarding_confirm_url": .string(Self.real)]),
            confirmation(2, day: 4, ["forwarding_confirm_url": nil, "text_body": "確認してください"]),
            confirmation(3, day: 5, ["forwarding_confirm_url": "https://evil.example/mail/vf-abc"]),
        ])
        #expect(m.confirmURL?.absoluteString == Self.real)
        #expect(m.approvalNote == nil)
    }

    @Test func negativeControlOnlyLookAlikesGiveNoLink() async throws {
        let m = try await model(mails: [
            confirmation(1, day: 4, ["forwarding_confirm_url": nil]),
            confirmation(2, day: 5, ["forwarding_confirm_url": "https://mail-settings.google.com.evil.example/mail/vf-abc"]),
        ])
        #expect(m.confirmURL == nil)
        #expect(m.approvalWaiting == false)
        #expect(m.approvalBadgeFailed == false)
    }

    @Test func thePickerTakesTheFirstValidRowInTheOrderItIsGiven() {
        let forged = ForwardingConfirmationRow(forwardingConfirmUrl: nil, textBody: nil, htmlBody: nil, createdAt: "2026-11-05T00:00:00+00:00")
        let realRow = ForwardingConfirmationRow(forwardingConfirmUrl: Self.real, textBody: nil, htmlBody: nil, createdAt: "2026-11-03T00:00:00+00:00")
        let newer = ForwardingConfirmationRow(forwardingConfirmUrl: "https://mail-settings.google.com/mail/vf-newer", textBody: nil, htmlBody: nil, createdAt: "2026-11-04T00:00:00+00:00")
        #expect(SettingsModel.pickApproval([forged, newer, realRow])?.url.absoluteString == "https://mail-settings.google.com/mail/vf-newer")
        #expect(SettingsModel.pickApproval([forged, newer, realRow])?.at == "2026-11-04T00:00:00+00:00")
        #expect(SettingsModel.pickApproval([forged, realRow])?.at == "2026-11-03T00:00:00+00:00")
        #expect(SettingsModel.pickApproval([forged]) == nil)
        #expect(SettingsModel.pickApproval([]) == nil)
    }

    @Test func theNewestByCreatedAtWinsNotBySentAt() async throws {
        let m = try await model(mails: [
            confirmation(1, day: 3, ["sent_at": "2026-11-09T00:00:00+00:00", "forwarding_confirm_url": "https://mail-settings.google.com/mail/vf-old"]),
            confirmation(2, day: 4, ["sent_at": "2026-11-01T00:00:00+00:00", "forwarding_confirm_url": .string(Self.real)]),
        ])
        #expect(m.confirmURL?.absoluteString == Self.real)
    }

    @Test func onlyTheNewestTenAreLookedThrough() async throws {
        // Ten look-alikes newer than the real one: it is the eleventh, so it is not read (the Web's lookback).
        let forged = (1...10).map { confirmation(100 + $0, day: 10 + $0, ["forwarding_confirm_url": nil]) }
        let m = try await model(mails: forged + [confirmation(1, day: 2, ["forwarding_confirm_url": .string(Self.real)])])
        #expect(m.confirmURL == nil)
        // Nine look-alikes: the real one is the tenth and is found.
        let nine = try await model(mails: Array(forged.dropFirst()) + [confirmation(1, day: 2, ["forwarding_confirm_url": .string(Self.real)])])
        #expect(nine.confirmURL?.absoluteString == Self.real)
    }

    // MARK: the card always shows; the badge is decided by time

    @Test func theBadgeWaitsWhileNothingArrivedAfterTheConfirmation() async throws {
        let m = try await model(mails: [confirmation(1, day: 3, ["forwarding_confirm_url": .string(Self.real)])])
        #expect(m.approvalWaiting)
        #expect(m.approvalBadgeFailed == false)
        #expect(SettingsView.forwardBadge(for: m) == .init(text: "承認待ち", kind: .amber))
    }

    @Test func anOrdinaryMailAfterTheConfirmationClearsTheBadgeButNotTheCard() async throws {
        let m = try await model(mails: [
            confirmation(1, day: 3, ["forwarding_confirm_url": .string(Self.real)]),
            SettingsRows.mail(2, ["created_at": "2026-11-04T00:00:00+00:00"]),
        ])
        #expect(m.approvalWaiting == false)
        #expect(SettingsView.forwardBadge(for: m) == nil)
        // The link is there all the same (an approval already done can be ignored).
        #expect(m.confirmURL?.absoluteString == Self.real)
    }

    @Test func aMailBeforeTheConfirmationDoesNotClearTheBadge() async throws {
        let m = try await model(mails: [
            confirmation(1, day: 3, ["forwarding_confirm_url": .string(Self.real)]),
            SettingsRows.mail(2, ["created_at": "2026-11-02T00:00:00+00:00"]),
        ])
        #expect(m.approvalWaiting)
    }

    @Test func aSampleAndAnotherConfirmationAfterItDoNotClearTheBadgeButAScreenedMailDoes() async throws {
        let base = [confirmation(1, day: 3, ["forwarding_confirm_url": .string(Self.real)])]
        let sample = try await model(mails: base + [SettingsRows.mail(2, ["created_at": "2026-11-04T00:00:00+00:00", "provider_email_id": "demo:1"])])
        #expect(sample.approvalWaiting)
        // A look-alike confirmation after it is a confirmation, not mail that arrived.
        let another = try await model(mails: base + [confirmation(3, day: 4, ["forwarding_confirm_url": nil])])
        #expect(another.approvalWaiting)
        // A mail the screen dropped after it did arrive.
        let screened = try await model(mails: base, dropped: [SettingsRows.dropped(1, ["created_at": "2026-11-04T00:00:00+00:00"])])
        #expect(screened.approvalWaiting == false)
    }

    @Test func aFailedAfterCheckIsUnknownNotWaiting() async throws {
        let m = try await model(
            mails: [confirmation(1, day: 3, ["forwarding_confirm_url": .string(Self.real)])],
            faults: { await $0.fail(where: { $0.url.lastPathComponent == "screen_events" && !$0.query("created_at").isEmpty }, with: .http(500)) }
        )
        #expect(m.approvalBadgeFailed)
        #expect(m.approvalWaiting == false)
        #expect(SettingsView.forwardBadge(for: m) == .init(text: SettingsMenuText.keyUnknownBadge, kind: .red))
        // The card is still there: it never waits for the after-check.
        #expect(m.confirmURL?.absoluteString == Self.real)
    }

    @Test func aFailedConfirmationReadIsUnknownToo() async throws {
        let m = try await model(
            mails: [confirmation(1, day: 3, ["forwarding_confirm_url": .string(Self.real)])],
            faults: { await $0.fail(where: { $0.url.lastPathComponent == "emails" && $0.query("classification") == ["eq.forwarding_confirmation"] }, with: .http(500)) }
        )
        #expect(m.approvalBadgeFailed)
        #expect(m.approvalNote == SettingsWebText.approvalReadFailed)
    }

    @Test func noConfirmationNoBadge() async throws {
        let m = try await model(mails: [])
        #expect(SettingsView.forwardBadge(for: m) == nil)
    }

    // MARK: the pages the buttons open, and the failure sentences

    @Test func eachWebButtonOpensThePageThatHoldsIt() {
        let base = "https://otodoke.app"
        let expected: [(SettingsWebAction, String)] = [
            (.changePassphrase, "/app/settings/password"),
            (.deleteAccount, "/app/settings/delete"),
            (.openWeb, "/app"),
            (.privacy, "/privacy"),
        ]
        #expect(Set(expected.map { "\($0.0)" }) == Set(SettingsWebAction.allCases.map { "\($0)" }))
        for (action, path) in expected {
            #expect(SettingsModel.webLink(action).absoluteString == base + path, "\(action)")
        }
        #expect(WebLink.settingsPassword.absoluteString == base + "/app/settings/password")
        // No old section hash anywhere.
        for action in SettingsWebAction.allCases { #expect(SettingsModel.webLink(action).fragment == nil, "\(action)") }
    }

    @Test func theFailureSentencesNameWhatCouldNotBeRead() {
        #expect(SettingsWebText.approvalReadFailed == "Gmail の承認の案内を読み込めませんでした")
        #expect(SettingsWebText.passwordKeyReadFailed == "メールの鍵を読み込めませんでした")
        #expect(SettingsWebText.oldKeyCountFailed == "前の鍵のメールの数を読み込めませんでした")
        #expect(SettingsWebText.unreadCountFailed == "未読のメールの数を読み込めませんでした")
    }
}
