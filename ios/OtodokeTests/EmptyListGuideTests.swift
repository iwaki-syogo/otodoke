import Foundation
import Testing
@testable import Otodoke

/// [empty list] The empty parcel list's three guides, decided as the Web's readMailSoFar decides them
/// (src/app/app/settings/settings-reads.ts): nothing → none; Gmail's confirmation and nothing after it → approval;
/// mail of the person's own (or a screen_events row) → received; the samples never count; a failed read → none.
@Suite("Empty parcel list: what has come in so far")
@MainActor
struct EmptyListGuideTests {
    private static let google = SettingsRows.google

    private func confirmation(_ n: Int, at: String = "2026-11-03T00:00:00+00:00", _ over: Row = [:]) -> Row {
        var row: Row = ["classification": "forwarding_confirmation", "created_at": .string(at), "forwarding_confirm_url": .string(Self.google)]
        for (k, v) in over { row[k] = v }
        return SettingsRows.mail(n, row)
    }

    private func reader(_ fake: FakeSupabase) async throws -> SettingsReader {
        let (provider, _) = try await TestSession.signedIn(fake)
        return SettingsReader(provider: provider)
    }

    private func decide(mails: [Row] = [], screened: [Row] = [], faults: (FakeSupabase) async -> Void = { _ in }) async throws -> MailSoFar? {
        let fake = FakeSupabase.make()
        await fake.insert("emails", mails)
        await fake.insert("screen_events", screened)
        await faults(fake)
        return await (try reader(fake)).mailSoFar()
    }

    // MARK: none

    @Test func nothingAtAllIsNone() async throws {
        #expect(try await decide() == MailSoFar.none)
    }

    @Test func theSamplesAloneAreNone() async throws {
        let samples = [SettingsRows.mail(1, ["provider_email_id": "demo:1"]), SettingsRows.mail(2, ["provider_email_id": "demo:2"])]
        #expect(try await decide(mails: samples) == MailSoFar.none)
    }

    @Test func anotherPersonsMailDoesNotCount() async throws {
        let other = SettingsRows.mail(1, ["user_id": "99999999-9999-4999-8999-999999999999"])
        #expect(try await decide(mails: [other]) == MailSoFar.none)
    }

    // MARK: approval

    @Test func onlyGmailsConfirmationIsApproval() async throws {
        #expect(try await decide(mails: [confirmation(1)]) == .approval)
    }

    @Test func aConfirmationAndOnlySamplesAfterItIsStillApproval() async throws {
        let mails = [confirmation(1), SettingsRows.mail(2, ["provider_email_id": "demo:9", "created_at": "2026-11-04T00:00:00+00:00"])]
        #expect(try await decide(mails: mails) == .approval)
    }

    @Test func aSecondConfirmationAfterTheFirstIsStillApproval() async throws {
        let mails = [confirmation(1), confirmation(2, at: "2026-11-04T00:00:00+00:00")]
        #expect(try await decide(mails: mails) == .approval)
    }

    @Test func aConfirmationWithoutGoogleLinkAloneIsApproval() async throws {
        // No usable link (a look-alike): the plain count path, which still sees a confirmation and nothing else.
        let lookAlike = confirmation(1, ["forwarding_confirm_url": nil])
        #expect(try await decide(mails: [lookAlike]) == .approval)
    }

    @Test func aFailedAfterCheckStillAsksForTheApproval() async throws {
        // The after-check is the count with created_at > the confirmation's: it fails, the card is still shown.
        // Mail after the confirmation would make it received; with the count failing it is approval, and a count
        // that works (the control) says received.
        let mails = [confirmation(1), SettingsRows.mail(2, ["created_at": "2026-11-04T00:00:00+00:00"])]
        #expect(try await decide(mails: mails) == .received)
        let got = try await decide(mails: mails) { fake in
            await fake.fail(where: { $0.url.lastPathComponent == "emails" && !$0.query("created_at").isEmpty }, with: .http(500))
        }
        #expect(got == .approval)
    }

    // MARK: received

    @Test func oneOfThePersonsOwnMailsIsReceived() async throws {
        #expect(try await decide(mails: [SettingsRows.mail(1)]) == .received)
    }

    @Test func mailAfterTheConfirmationIsReceived() async throws {
        let mails = [confirmation(1), SettingsRows.mail(2, ["created_at": "2026-11-04T00:00:00+00:00"])]
        #expect(try await decide(mails: mails) == .received)
    }

    @Test func mailBeforeTheConfirmationOnlyIsApproval() async throws {
        // The confirmation is the newest: nothing arrived after it, so waiting brings nothing.
        let mails = [SettingsRows.mail(1, ["created_at": "2026-11-01T00:00:00+00:00"]), confirmation(2)]
        #expect(try await decide(mails: mails) == .approval)
    }

    @Test func aDroppedMailAfterTheConfirmationIsReceived() async throws {
        let dropped = SettingsRows.dropped(1, ["created_at": "2026-11-04T00:00:00+00:00"])
        #expect(try await decide(mails: [confirmation(1)], screened: [dropped]) == .received)
    }

    @Test func aScreenedRowAloneIsReceivedWhatEverItsDecision() async throws {
        #expect(try await decide(screened: [SettingsRows.dropped(1)]) == .received)
        #expect(try await decide(screened: [SettingsRows.dropped(2, ["decision": "kept"])]) == .received)
    }

    // MARK: a failed read is none (nil here, none on the list)

    @Test func aFailedConfirmationReadIsNil() async throws {
        let got = try await decide(mails: [SettingsRows.mail(1)]) { fake in
            await fake.fail(where: { $0.method == "GET" && $0.url.lastPathComponent == "emails" && $0.query("classification") == ["eq.forwarding_confirmation"] && $0.query("limit") == ["10"] }, with: .http(500))
        }
        #expect(got == nil)
    }

    @Test func aFailedPlainCountIsNil() async throws {
        let got = try await decide(mails: [SettingsRows.mail(1)]) { fake in
            await fake.fail(where: { $0.url.lastPathComponent == "screen_events" }, with: .http(500))
        }
        #expect(got == nil)
    }

    // MARK: the words and the buttons

    @Test func theThreeGuidesAndWhereTheirButtonsGo() {
        let none = ParcelEmptyText.guide(.none)
        #expect([none.first, none.second, none.button] == ["メールの自動転送を設定しますか？", "設定は最初の 1 回だけです。", "設定する"])
        #expect(none.destination == .forwarding)
        let received = ParcelEmptyText.guide(.received)
        #expect([received.first, received.second, received.button] == ["メールは届いています。", "荷物のメールが届くまで、お待ちください。", "設定を見る"])
        #expect(received.destination == .trouble)
        let approval = ParcelEmptyText.guide(.approval)
        #expect([approval.first, approval.second, approval.button] == ["Gmail の転送は承認しましたか？", "承認すると、荷物のメールが届きはじめます。", "設定で承認する"])
        #expect(approval.destination == .forwarding)
    }

    @Test func theRoutesOpenTheirPages() {
        var route = TabRoute()
        route.showTrouble()
        #expect(route.tab == .settings)
        #expect(route.settingsPath == [.delivery])
        route.showForwarding()
        #expect(route.settingsPath == [.forward])
    }

    // MARK: the list model

    private func model(_ fake: FakeSupabase, mail: @escaping @Sendable () async -> MailSoFar?) async throws -> ParcelListModel {
        let (provider, _) = try await TestSession.signedIn(fake)
        return ParcelListModel(
            reader: ParcelReader(provider: provider), writer: ParcelWriter(provider: provider),
            today: { "2026-11-04" }, now: { ISO.date("2026-11-04T03:00:00Z")! }, sleep: { try await Task.sleep(for: $0) },
            readMail: mail
        )
    }

    @Test func anEmptyListReadsWhatHasComeIn() async throws {
        let model = try await model(FakeSupabase.make()) { .received }
        await model.load()
        #expect(model.isEmpty)
        #expect(model.mailSoFar == .received)
    }

    @Test func aFailedMailReadLeavesTheSetupQuestion() async throws {
        let model = try await model(FakeSupabase.make()) { nil }
        await model.load()
        #expect(model.isEmpty)
        #expect(model.mailSoFar == MailSoFar.none)
    }

    @Test func aListWithParcelsDoesNotReadTheMailAtAll() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["status": "shipped", "expected_date": "2026-11-05"])])
        let calls = GuideCallCounter()
        let model = try await model(fake) {
            await calls.bump()
            return .received
        }
        await model.load()
        #expect(!model.isEmpty)
        #expect(model.mailSoFar == MailSoFar.none)
        #expect(await calls.count == 0)
    }

    @Test func theGuideFollowsTheMailOnTheNextRead() async throws {
        let state = GuideMailBox(MailSoFar.approval)
        let model = try await model(FakeSupabase.make()) { await state.value }
        await model.load()
        #expect(model.mailSoFar == .approval)
        await state.set(.received)
        await model.load()
        #expect(model.mailSoFar == .received)
    }

    @Test func theRealReaderThroughTheModel() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("emails", [confirmation(1)])
        let (provider, _) = try await TestSession.signedIn(fake)
        let reader = SettingsReader(provider: provider)
        let model = try await model(fake) { await reader.mailSoFar() }
        await model.load()
        #expect(model.mailSoFar == .approval)
    }
}

private actor GuideCallCounter {
    private(set) var count = 0
    func bump() { count += 1 }
}

private actor GuideMailBox<T: Sendable> {
    private(set) var value: T
    init(_ value: T) { self.value = value }
    func set(_ new: T) { value = new }
}
