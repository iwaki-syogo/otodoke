import Foundation
import Testing
@testable import Otodoke

/// Made-up rows of the tables the settings screen reads. Nothing here is real data.
enum SettingsRows {
    static func key(_ n: Int, keyID: String, activated: Bool = true, retired: Bool = false, user: String = FakeSupabase.me) -> Row {
        [
            "id": .string(Rows.id(40_000 + n)),
            "user_id": .string(user),
            "key_id": .string(keyID),
            "created_at": "2026-11-05T00:00:00+00:00",
            "activated_at": activated ? "2026-11-05T00:01:00+00:00" : nil,
            "retired_at": retired ? "2026-11-05T00:02:00+00:00" : nil,
        ]
    }

    static func mail(_ n: Int, _ over: Row = [:]) -> Row {
        var row: Row = [
            "id": .string(Rows.id(50_000 + n)),
            "user_id": .string(FakeSupabase.me),
            "processing_status": "processed",
            "body_state": "plain",
            "provider_email_id": .string("re_\(n)"),
            "body_envelope": nil,
            "classification": "shipped",
            "forwarding_confirm_url": nil,
            "text_body": nil,
            "html_body": nil,
            "sent_at": "2026-11-01T00:00:00+00:00",
            "created_at": "2026-11-01T00:00:00+00:00",
        ]
        for (k, v) in over { row[k] = v }
        return row
    }

    static func dropped(_ n: Int, _ over: Row = [:]) -> Row {
        var row: Row = [
            "id": .string(Rows.id(60_000 + n)),
            "user_id": .string(FakeSupabase.me),
            "decision": "dropped",
            "subject": .string("広告\(n)"),
            "from_domain": "ads.example.com",
            "created_at": .string(String(format: "2026-11-01T00:%02d:00+00:00", n % 60)),
            "flagged_at": nil,
        ]
        for (k, v) in over { row[k] = v }
        return row
    }

    static let google = "https://mail-settings.google.com/mail/vf-abc123-def"
}

/// [Batch 2, task 10] The settings screen's reads (src/app/app/settings/page.tsx, 2541793): each with
/// user_id = me, each failing on its own (never 0 or an empty list in place of a failure).
@Suite("SettingsReader (batch 2, task 10)")
@MainActor
struct SettingsReaderTests {
    private func reader(_ fake: FakeSupabase) async throws -> SettingsReader {
        let (provider, _) = try await TestSession.signedIn(fake)
        return SettingsReader(provider: provider)
    }

    private func onlyMine(_ fake: FakeSupabase, _ table: String) async {
        let reads = await fake.restRequests().filter { $0.url.lastPathComponent == table }
        #expect(!reads.isEmpty, "\(table)")
        for r in reads { #expect(r.query("user_id") == ["eq.\(FakeSupabase.me)"], "\(table)") }
    }

    // MARK: the key in use

    @Test func theKeyInUse() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [
            SettingsRows.key(1, keyID: "old0000000000000000000000000000", retired: true),
            SettingsRows.key(2, keyID: "new0000000000000000000000000000", activated: false),
            SettingsRows.key(3, keyID: "use0000000000000000000000000000"),
            SettingsRows.key(4, keyID: "oth0000000000000000000000000000", user: FakeSupabase.other),
        ])
        let r = try await reader(fake)
        #expect(await r.currentKey() == .loaded(UserKeyRow(keyId: "use0000000000000000000000000000", createdAt: "2026-11-05T00:00:00+00:00")))
        await onlyMine(fake, "user_keys")
        let q = await fake.requests("GET", "user_keys").first
        #expect(q?.query("activated_at") == ["not.is.null"])
        #expect(q?.query("retired_at") == ["is.null"])
    }

    @Test func noKeyIsLoadedNil() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k", retired: true)])
        let r = try await reader(fake)
        #expect(await r.currentKey() == .loaded(nil))
    }

    @Test func twoKeysInUseAreAFailure() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "a"), SettingsRows.key(2, keyID: "b")])
        let r = try await reader(fake)
        #expect(await r.currentKey() == .failed)
    }

    @Test func aFailedKeyReadIsAFailure() async throws {
        let fake = FakeSupabase.make()
        await fake.fail("GET", "user_keys", with: .http(500))
        let r = try await reader(fake)
        #expect(await r.currentKey() == .failed)
    }

    // MARK: counts

    @Test func oldKeyCountIsSealedMailOfAnotherKid() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("emails", [
            SettingsRows.mail(1, ["body_state": "sealed", "body_envelope": ["kid": "k1"]]),
            SettingsRows.mail(2, ["body_state": "sealed", "body_envelope": ["kid": "k0"]]),
            SettingsRows.mail(3, ["body_state": "sealed", "body_envelope": ["kid": "k0"]]),
            SettingsRows.mail(4, ["body_state": "plain"]),
            SettingsRows.mail(5, ["body_state": "sealed", "body_envelope": ["kid": "k0"], "user_id": .string(FakeSupabase.other)]),
        ])
        let r = try await reader(fake)
        #expect(await r.oldKeyCount(currentKeyID: "k1") == .loaded(2))
        await onlyMine(fake, "emails")
    }

    @Test func aFailedOldKeyCountIsNotZero() async throws {
        let fake = FakeSupabase.make()
        await fake.fail(where: { $0.url.lastPathComponent == "emails" }, with: .http(503))
        let r = try await reader(fake)
        #expect(await r.oldKeyCount(currentKeyID: "k1") == .failed)
    }

    @Test func unreadUsesTheUnreadFilter() async throws {
        let fake = FakeSupabase.make()
        await fake.setUnreadEmails(4)
        let now = ISO.date("2026-11-04T03:00:00Z")!
        let r = try await reader(fake)
        #expect(await r.unreadCount(now: now) == .loaded(4))
        let q = await fake.restRequests().first { $0.url.lastPathComponent == "emails" }
        #expect(q?.query("or") == ["(\(StatusRules.unreadFilter(now: now)))"] || q?.query("or") == [StatusRules.unreadFilter(now: now)])
        await onlyMine(fake, "emails")
    }

    @Test func aFailedUnreadCountIsNotZero() async throws {
        let fake = FakeSupabase.make()
        await fake.setUnreadEmails(0)
        await fake.fail(where: { !$0.query("or").isEmpty }, with: .http(500))
        let r = try await reader(fake)
        #expect(await r.unreadCount(now: Date()) == .failed)
    }

    // MARK: the forwarding confirmation and the dropped mails

    @Test func theNewestConfirmation() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("emails", [
            SettingsRows.mail(1, ["classification": "forwarding_confirmation", "created_at": "2026-11-01T00:00:00+00:00", "forwarding_confirm_url": "https://mail-settings.google.com/mail/old"]),
            SettingsRows.mail(2, ["classification": "forwarding_confirmation", "created_at": "2026-11-03T00:00:00+00:00", "forwarding_confirm_url": .string(SettingsRows.google)]),
            SettingsRows.mail(3, ["classification": "shipped", "created_at": "2026-11-04T00:00:00+00:00"]),
        ])
        let r = try await reader(fake)
        let got = await r.forwardingConfirmations()
        // The newest few, newest created_at first (the Web's readConfirmUrl): the picked one is the newer.
        #expect(got.value?.first?.forwardingConfirmUrl == SettingsRows.google)
        let q = await fake.requests("GET", "emails").first
        #expect(q?.query("classification") == ["eq.forwarding_confirmation"])
        #expect((q?.query("order").first ?? "").hasPrefix("created_at.desc"))
        #expect(q?.query("limit") == ["10"])
        await onlyMine(fake, "emails")
    }

    @Test func noConfirmationIsLoadedNil() async throws {
        let fake = FakeSupabase.make()
        let r = try await reader(fake)
        #expect(await r.forwardingConfirmations() == .loaded([]))
    }

    @Test func aFailedConfirmationReadIsAFailure() async throws {
        let fake = FakeSupabase.make()
        await fake.fail("GET", "emails", with: .http(500))
        let r = try await reader(fake)
        #expect(await r.forwardingConfirmations() == .failed)
    }

    @Test func everyDroppedMailNewestFirst() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("screen_events", (1...1_200).map { SettingsRows.dropped($0) } + [
            SettingsRows.dropped(2_000, ["decision": "kept"]),
            SettingsRows.dropped(2_001, ["user_id": .string(FakeSupabase.other)]),
        ])
        let r = try await reader(fake)
        guard case let .loaded(rows) = await r.dropped() else {
            Issue.record("the dropped mails did not load")
            return
        }
        #expect(rows.count == 1_200)
        #expect(rows.map(\.createdAt) == rows.map(\.createdAt).sorted(by: >))
        await onlyMine(fake, "screen_events")
    }

    @Test func aFailedDroppedReadIsNotAnEmptyList() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("screen_events", [SettingsRows.dropped(1)])
        await fake.fail("GET", "screen_events", with: .http(500))
        let r = try await reader(fake)
        #expect(await r.dropped() == .failed)
    }
}

/// [Batch 2, tasks 10 and 11] The settings screen's model: the passphrase card's three states, the
/// address only with a key row, the unread count that is never 0 for a failure (iOS-9), the approval
/// link only to Google's page (CX4), the pages opened on the Web, and signing out.
@Suite("SettingsModel (batch 2, tasks 10 and 11)")
@MainActor
struct SettingsModelTests {
    private struct Setup: Sendable {
        let fake: FakeSupabase
        let model: SettingsModel
        let auth: AuthService
        let changes: DataChanges
    }

    private func setUp(keys: [Row] = [SettingsRows.key(1, keyID: "k1")], mails: [Row] = [], dropped: [Row] = [], unread: Int = 0, faults: (FakeSupabase) async -> Void = { _ in }) async throws -> Setup {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", keys)
        await fake.insert("emails", mails)
        await fake.insert("screen_events", dropped)
        await fake.setUnreadEmails(unread)
        await faults(fake)
        let (provider, auth) = try await TestSession.signedIn(fake)
        let changes = DataChanges()
        let model = SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: changes,
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
        await model.load()
        return Setup(fake: fake, model: model, auth: auth, changes: changes)
    }

    private func confirm(_ over: Row) -> Row {
        var row: Row = ["classification": "forwarding_confirmation", "sent_at": "2026-11-03T00:00:00+00:00"]
        for (k, v) in over { row[k] = v }
        return SettingsRows.mail(90, row)
    }

    @Test func theWords() {
        #expect(SettingsModel.failedText == "読み込めませんでした")
        #expect(SettingsModel.gmailFilter == "{注文 発送 出荷 配達 お届け 配送 到着 荷物}")
        #expect(SettingsModel.oldKeyText(3) == "前の鍵で暗号化したメールが 3 通あります。開けませんが、荷物は残っています。")
    }

    // MARK: the passphrase card, three states

    @Test func aKeyThatCannotBeReadShowsNeitherTheAddressNorTheButton() async throws {
        let s = try await setUp(faults: { await $0.fail("GET", "user_keys", with: .http(500)) })
        #expect(s.model.keyPanel == .failed)
        #expect(s.model.showsAddress == false)
        #expect(s.model.address == nil)
    }

    @Test func noKeyAsksToChooseAPassphrase() async throws {
        let s = try await setUp(keys: [], mails: [SettingsRows.mail(1), SettingsRows.mail(2)])
        #expect(s.model.keyPanel == .none)
        #expect(s.model.showsAddress == false)
        #expect(s.model.address == nil)
    }

    @Test func aKeyInUseShowsTheAddress() async throws {
        let s = try await setUp(mails: [
            SettingsRows.mail(1),
            SettingsRows.mail(2, ["body_state": "sealed", "body_envelope": ["kid": "k0"]]),
        ])
        #expect(s.model.keyPanel == .present(oldKeyCount: .loaded(1)))
        // Positive control of the two tests above: with a key row the address is there.
        #expect(s.model.showsAddress == true)
        guard case let .loaded(address)? = s.model.address else {
            Issue.record("no address")
            return
        }
        #expect(address.hasSuffix("@\(s.fake.config.inboundDomain)"))
    }

    @Test func theAddressFollowsTheKeyRowNotTheDevice() async throws {
        // A retired key only: no key in use, so no address, whatever this device holds.
        let s = try await setUp(keys: [SettingsRows.key(1, keyID: "k0", retired: true)])
        #expect(s.model.keyPanel == .none)
        #expect(s.model.showsAddress == false)
    }

    @Test func plainMailIsNeverCountedOrShown() async throws {
        // Mail saved before encryption is sealed by the server now: the app reads no count of it and the key row
        // carries no mention of it, whatever the table holds, and a failing read of it changes nothing.
        let s = try await setUp(mails: (1...5).map { SettingsRows.mail($0) }, faults: { await $0.fail(where: { $0.query("body_state") == ["eq.plain"] }, with: .http(500)) })
        #expect(s.model.keyPanel == .present(oldKeyCount: .loaded(0)))
        #expect(SettingsView.keyBadge(for: s.model) == nil)
        // The read of plain mail is not made at all.
        #expect(await s.fake.requests.contains { $0.query("body_state") == ["eq.plain"] } == false)
    }

    @Test func aFailedOldKeyCountIsNotZero() async throws {
        let s = try await setUp(faults: { await $0.fail(where: { !$0.query("body_envelope->>kid").isEmpty }, with: .http(500)) })
        guard case let .present(old)? = s.model.keyPanel else {
            Issue.record("expected a key in use")
            return
        }
        #expect(old == .failed)
    }

    // MARK: iOS-9: unread

    @Test func unreadMailIsCounted() async throws {
        let s = try await setUp(unread: 4)
        #expect(s.model.unread == .loaded(4))
        #expect(s.model.unreadHeading == "未読のメールが 4 通あります")
    }

    @Test func noUnreadMailShowsNothing() async throws {
        let s = try await setUp(unread: 0)
        #expect(s.model.unread == .loaded(0))
        #expect(s.model.unreadHeading == nil)
    }

    @Test func anUnreadCountThatCannotBeReadIsNotZero() async throws {
        let s = try await setUp(unread: 0, faults: { await $0.fail(where: { !$0.query("or").isEmpty }, with: .http(500)) })
        #expect(s.model.unread == .failed)
        #expect(s.model.unreadHeading == SettingsWebText.unreadCountFailed)
        #expect(s.model.unreadHeading == "未読のメールの数を読み込めませんでした")
    }

    // MARK: each read fails on its own

    @Test func theDroppedListFailsOnItsOwn() async throws {
        let s = try await setUp(dropped: [SettingsRows.dropped(1)], unread: 2, faults: { await $0.fail("GET", "screen_events", with: .http(500)) })
        #expect(s.model.dropped == .failed)
        #expect(s.model.unread == .loaded(2))
        #expect(s.model.keyPanel == .present(oldKeyCount: .loaded(0)))
    }

    @Test func theDroppedListLoads() async throws {
        let s = try await setUp(dropped: [SettingsRows.dropped(1), SettingsRows.dropped(2)])
        #expect(s.model.dropped?.value?.count == 2)
    }

    // MARK: CX4: the approval link

    @Test func theStoredLinkWhenItIsGooglesPage() async throws {
        let s = try await setUp(mails: [confirm(["forwarding_confirm_url": .string(SettingsRows.google)])])
        #expect(s.model.confirmURL?.absoluteString == SettingsRows.google)
        #expect(s.model.confirmURL?.scheme == "https")
    }

    @Test func aStoredLinkThatFailsTheCheckFallsBackToTheBody() async throws {
        let s = try await setUp(mails: [confirm([
            "forwarding_confirm_url": "https://evil.example/mail/vf-abc",
            "text_body": .string("確認してください: \(SettingsRows.google) よろしく"),
        ])])
        #expect(s.model.confirmURL?.absoluteString == SettingsRows.google)
    }

    @Test(arguments: [
        "https://evil.example/mail/vf-abc",
        "https://mail-settings.google.com.evil.example/mail/vf-abc",
        "https://mail-settings.google.com@evil.example/mail/vf-abc",
        "https://mail-settings.google.com/settings/vf-abc",
        "http://mail-settings.google.com/mail/vf-abc",
        "javascript:alert(1)",
    ])
    func refusesEveryOtherLink(link: String) async throws {
        let s = try await setUp(mails: [confirm(["forwarding_confirm_url": .string(link), "text_body": .string("リンク: \(link)")])])
        #expect(s.model.confirmURL == nil, "\(link)")
    }

    @Test func anEmptyTextBodyHidesTheHTMLAsOnTheWeb() async throws {
        // text_body ?? html_body: "" is not null, so the HTML is not looked at.
        let s = try await setUp(mails: [confirm(["text_body": "", "html_body": .string("<a href=\"\(SettingsRows.google)\">承認</a>")])])
        #expect(s.model.confirmURL == nil)
    }

    @Test func theHTMLWhenThereIsNoText() async throws {
        let s = try await setUp(mails: [confirm(["text_body": nil, "html_body": .string("<a href=\"\(SettingsRows.google)\">承認</a>")])])
        #expect(s.model.confirmURL?.absoluteString == SettingsRows.google)
    }

    @Test func noConfirmationNoLink() async throws {
        let s = try await setUp()
        #expect(s.model.confirmURL == nil)
    }

    // MARK: task 11: the pages opened on the Web

    @Test func theWebPagesAreTheListOfTaskMd() {
        // One page per item (the Web's dev 84255fc): the button opens the page that holds it.
        #expect(SettingsModel.webLink(.createPassphrase).absoluteString == "https://otodoke.app/app/settings/password")
        #expect(SettingsModel.webLink(.changePassphrase).absoluteString == "https://otodoke.app/app/settings/password")
        #expect(SettingsModel.webLink(.readWaiting).absoluteString == "https://otodoke.app/app/settings/trouble")
        #expect(SettingsModel.webLink(.markAsParcel).absoluteString == "https://otodoke.app/app/settings/dropped")
        #expect(SettingsModel.webLink(.openWeb).absoluteString == "https://otodoke.app/app")
        for action in SettingsWebAction.allCases {
            #expect(SettingsModel.webLink(action).scheme == "https", "\(action)")
            #expect(SettingsModel.webLink(action).host() == "otodoke.app", "\(action)")
        }
        #expect(WebLink.settingsPassword.absoluteString == "https://otodoke.app/app/settings/password")
        #expect(WebLink.app.absoluteString == "https://otodoke.app/app")
    }

    @Test func thePrivacyAndDeletionRows() {
        #expect(SettingsModel.webLink(.privacy).absoluteString == "https://otodoke.app/privacy")
        #expect(SettingsModel.webLink(.deleteAccount).absoluteString == "https://otodoke.app/app/settings/delete")
    }

    @Test func theMailHandlingItemsOfM1() {
        #expect(MailHandlingText.heading == "あなたのメールの扱い")
        // M2 task 19 adds the item about keeping the key in the Keychain with Face ID (12 → 13); the Web later added an item about mail that is read and found not to be about shopping (13 → 14).
        #expect(MailHandlingText.items.count == 14)
        #expect(MailHandlingText.items.first == "届いたメールは、読み取る数秒のあいだ、サーバーと Claude API が中身を扱います。Anthropic は API のデータを、既定では学習に使いません。")
        #expect(MailHandlingText.items.last == "運営者が正しいプログラムを動かしていることが前提です。コードはすべて公開しています。")
        #expect(MailHandlingText.repositoryURL.absoluteString == "https://github.com/iwaki-syogo/otodoke")
        // M2 task 19: exactly one item about the Face ID key (FaceIDSettingsTests checks its words).
        #expect(MailHandlingText.items.filter { $0.contains("Face ID") || $0.contains("キーチェーン") }.count == 1)
    }

    // MARK: signed in, signing out

    @Test func showsWhoIsSignedIn() async throws {
        let s = try await setUp()
        #expect(s.model.signedInEmail == FakeSupabase.email)
    }

    @Test func signingOutShowsTheSpinnerAndEndsSignedOut() async throws {
        let gate = Gate()
        let s = try await setUp(faults: { await $0.fail("POST", "logout", with: .hold(gate)) })
        let out = Task { await s.model.signOut() }
        #expect(await waitFor { await s.fake.count("POST", "logout") == 1 })
        #expect(s.model.isSigningOut)
        gate.open()
        await out.value
        #expect(s.model.isSigningOut == false)
        #expect(s.auth.state == .signedOut)
    }

    // MARK: 「古くなった」 and the front

    @Test func readsWhenShownFirstThenOnlyWhenStale() async throws {
        let s = try await setUp()
        let first = await s.fake.count("GET", "user_keys")
        #expect(first >= 1)
        await s.model.onAppear()
        #expect(await s.fake.count("GET", "user_keys") == first)
        s.changes.publish()
        await s.model.onAppear()
        #expect(await s.fake.count("GET", "user_keys") > first)
    }

    @Test func comingBackToTheFrontReadsOnce() async throws {
        let s = try await setUp()
        let before = await s.fake.count("GET", "user_keys")
        await s.model.sceneBecameActive()
        #expect(await s.fake.count("GET", "user_keys") == before + 1)
    }
    // MARK: 「メールの転送」 page shown (the Gmail approval: open it again after a while)

    private func confirmationReads(_ fake: FakeSupabase) async -> Int {
        await fake.requests("GET", "emails").filter { $0.query("classification") == ["eq.forwarding_confirmation"] }.count
    }

    @Test func theForwardingPageShownReadsTheApprovalAgain() async throws {
        let s = try await setUp()
        #expect(s.model.confirmURL == nil)
        let before = await confirmationReads(s.fake)
        // The approval mail arrives while the settings tab stays open (no change is published, no scene change).
        await s.fake.insert("emails", [confirm(["forwarding_confirm_url": .string(SettingsRows.google)])])
        await s.model.pageShown()
        #expect(await confirmationReads(s.fake) == before + 1)
        #expect(s.model.confirmURL?.absoluteString == SettingsRows.google)
        // Shown again later: read again, not only the first time.
        await s.model.pageShown()
        #expect(await confirmationReads(s.fake) == before + 2)
    }

    @Test func theOldAnswerStaysWhileThePageReadsAgain() async throws {
        let s = try await setUp(mails: [confirm(["forwarding_confirm_url": .string(SettingsRows.google)])])
        #expect(s.model.confirmURL != nil)
        let gate = Gate()
        let before = await confirmationReads(s.fake)
        await s.fake.fail(where: { $0.query("classification") == ["eq.forwarding_confirmation"] }, nth: before + 1, with: .hold(gate))
        let shown = Task { await s.model.pageShown() }
        #expect(await waitFor { await self.confirmationReads(s.fake) == before + 1 })
        // Mid-read: nothing is cleared (no spinner state, the approval card stays).
        #expect(s.model.keyPanel != nil)
        #expect(s.model.confirmURL != nil)
        gate.open()
        await shown.value
        #expect(s.model.keyPanel != nil)
        #expect(s.model.confirmURL != nil)
    }

    @Test func aPageShownWhileReadingDoesNotStartASecondRead() async throws {
        let s = try await setUp()
        let gate = Gate()
        let keys = await s.fake.count("GET", "user_keys")
        await s.fake.fail("GET", "user_keys", nth: keys + 1, with: .hold(gate))
        let first = Task { await s.model.pageShown() }
        #expect(await waitFor { await s.fake.count("GET", "user_keys") == keys + 1 })
        await s.model.pageShown()
        await s.model.pageShown()
        #expect(await s.fake.count("GET", "user_keys") == keys + 1)
        gate.open()
        await first.value
        #expect(await s.fake.count("GET", "user_keys") == keys + 1)
        // Once it ended, the next showing reads again.
        await s.model.pageShown()
        #expect(await s.fake.count("GET", "user_keys") == keys + 2)
    }
    @Test func aPageShownWhileTheReadWasCutOffReadsAgain() async throws {
        let s = try await setUp()
        let gate = Gate()
        let keys = await s.fake.count("GET", "user_keys")
        await s.fake.fail("GET", "user_keys", nth: keys + 1, with: .hold(gate))
        let first = Task { await s.model.pageShown() }
        #expect(await waitFor { await s.fake.count("GET", "user_keys") == keys + 1 })
        // The read is still running, but cut off (its answers will be dropped): a page shown starts a new one.
        first.cancel()
        await s.model.pageShown()
        #expect(await s.fake.count("GET", "user_keys") == keys + 2)
        gate.open()
        await first.value
    }

    // MARK: the key row's badge (a failed count is never drawn as no badge)

    @Test func theKeyBadgeForTheCountThatCouldNotBeRead() async throws {
        // A failing read of the samples no longer reaches the key row (nothing counts plain mail now).
        let sampleFails = try await setUp(faults: { await $0.fail(where: { !$0.query("provider_email_id").isEmpty }, with: .http(500)) })
        #expect(SettingsView.keyBadge(for: sampleFails.model) == nil)
        let oldKeyFails = try await setUp(faults: { await $0.fail(where: { $0.query("body_state") == ["eq.sealed"] }, with: .http(503)) })
        #expect(SettingsView.keyBadge(for: oldKeyFails.model) == .init(text: SettingsMenuText.keyUnknownBadge, kind: .red))
        #expect(SettingsMenuText.keyUnknownBadge == "確認できません")
    }

    @Test func unencryptedMailShowsNoBadgeAndNoOtherBadgeIsHiddenByIt() async throws {
        let sealedFails: (FakeSupabase) async -> Void = { await $0.fail(where: { $0.query("body_state") == ["eq.sealed"] }, with: .http(503)) }
        // Plain mail only: no badge (it used to be 未暗号化 n 通).
        let plainOnly = try await setUp(mails: (1...5).map { SettingsRows.mail($0) })
        #expect(SettingsView.keyBadge(for: plainOnly.model) == nil)
        // Plain mail and the old-key count failed: the failure still shows.
        let plainAndOldFails = try await setUp(mails: (1...5).map { SettingsRows.mail($0) }, faults: sealedFails)
        #expect(SettingsView.keyBadge(for: plainAndOldFails.model) == .init(text: SettingsMenuText.keyUnknownBadge, kind: .red))
        // No key: 未設定 whatever the mail table holds.
        let noKey = try await setUp(keys: [], mails: (1...5).map { SettingsRows.mail($0) })
        #expect(SettingsView.keyBadge(for: noKey.model) == .init(text: SettingsMenuText.keyNoneBadge, kind: .amber))
    }

    @Test func theApprovalBadgeIsTheWebs() {
        #expect(SettingsMenuText.approvalBadge == "承認待ち")
    }

    @Test func theKeyBadgeKeepsItsOtherStates() async throws {
        let clean = try await setUp()
        #expect(SettingsView.keyBadge(for: clean.model) == nil)
        let noKey = try await setUp(keys: [])
        #expect(SettingsView.keyBadge(for: noKey.model) == .init(text: SettingsMenuText.keyNoneBadge, kind: .amber))
    }

    @Test func aKeyStepThatFailedShowsOnTheKeyRow() async throws {
        let w = try await KeyOwnerAndOrderTests.SignInWorld(keyInUse: false)
        try await w.signIn()
        let screens = MainScreens.live(auth: w.auth)
        let setup = try #require(screens.keySetup)
        #expect(await waitFor(.seconds(5)) { await MainActor.run { setup.lastOutcome != nil } })
        await screens.settings.onAppear()
        #expect(screens.settings.keyStepFailure != nil)
        #expect(SettingsView.keyBadge(for: screens.settings) == .init(text: SettingsMenuText.keyStepFailedBadge, kind: .red))
        #expect(SettingsMenuText.keyStepFailedBadge == "鍵を作れませんでした")
    }
}
