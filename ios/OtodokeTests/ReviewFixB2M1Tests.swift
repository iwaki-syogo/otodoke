import Foundation
import Testing
@testable import Otodoke

// [Batch 2, M1, review fix 1] Failing tests written before the fixes of review.md / security.md
// (HEAD 163d35f): M1 = SEC-M1, S1, S2, S3, N2, N3, Codex #3, Codex #4, SEC-N1.

/// A screen model's world against FakeSupabase (made-up rows only).
@MainActor
private enum World {
    static func provider(_ fake: FakeSupabase) async throws -> (SupabaseProvider, AuthService) {
        try await TestSession.signedIn(fake)
    }

    static func settings(_ fake: FakeSupabase, changes: DataChanges = DataChanges()) async throws -> SettingsModel {
        let (provider, auth) = try await provider(fake)
        return SettingsModel(
            reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth,
            inboundDomain: fake.config.inboundDomain,
            changes: changes,
            now: { ISO.date("2026-11-04T03:00:00Z")! }
        )
    }

    static func calendar(_ fake: FakeSupabase) async throws -> CalendarModel {
        let (provider, _) = try await provider(fake)
        return CalendarModel(reader: ParcelReader(provider: provider), changes: DataChanges(), today: { "2026-11-04" })
    }

    static func spend(_ fake: FakeSupabase, changes: DataChanges = DataChanges()) async throws -> SpendModel {
        let (provider, _) = try await provider(fake)
        return SpendModel(
            reader: ParcelReader(provider: provider),
            writer: ParcelWriter(provider: provider, changes: changes),
            changes: changes,
            today: { "2026-11-04" }
        )
    }

    /// The forwarding confirmation mail (newest), with `over` on top.
    static func confirmation(_ over: Row) -> Row {
        var row: Row = ["classification": "forwarding_confirmation", "sent_at": "2026-11-03T00:00:00+00:00"]
        for (k, v) in over { row[k] = v }
        return SettingsRows.mail(90, row)
    }

    /// Settles a cancelled request before the fake answers it.
    static func settle() async {
        try? await Task.sleep(for: .milliseconds(200))
    }
}

// MARK: - [M1] = [SEC-M1] the approval link

/// [M1] = [SEC-M1] Forwarding.confirmURL reads the link as WHATWG does (the Web, unchanged: the
/// difference harness stays). URL(string:) reads `\` as %5C and the text before `@` as user info, so
/// three links Google's for the Web are evil.example for Foundation and Safari. iOS hands out an
/// approval link only when both readers say Google's page; the same check runs right before it opens.
@Suite("Review fix 1: the approval link read by both parsers (M1 = SEC-M1)")
@MainActor
struct ReviewFix1ApprovalLinkTests {
    /// The three forms of review.md / security.md.
    nonisolated static let hostile = [
        #"https://mail-settings.google.com\mail\@evil.example/mail/x"#,
        #"https://mail-settings.google.com\@evil.example/mail/"#,
        #"https://mail-settings.google.com\mail\vf-1@evil.example?x"#,
    ]

    /// The real shape (percent-encoded brackets) and the fixture's 「。」 form, which must still open.
    nonisolated static let real = "https://mail-settings.google.com/mail/vf-%5BABC123%5D-xyz"
    nonisolated static let withJapanese = "https://mail-settings.google.com/mail/vf-abc。ご確認ください"

    private func model(_ mails: [Row]) async throws -> SettingsModel {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", mails)
        let model = try await World.settings(fake)
        await model.load()
        return model
    }

    // Negative controls: what the inputs are (green today; they say why the tests below are red).

    @Test(arguments: hostile)
    func foundationReadsTheHostAsEvilExample(link: String) {
        #expect(URL(string: link)?.host(percentEncoded: false) == "evil.example", "\(link)")
    }

    @Test(arguments: [hostile[0], hostile[2]])
    func theWebCheckStillLetsThemThrough(link: String) {
        // The port of forwarding.ts is not changed (the difference harness is the Web's).
        #expect(Forwarding.confirmURL(stored: link, textBody: nil, htmlBody: nil) == link)
        #expect(Forwarding.confirmURL(stored: nil, textBody: "リンク: \(link)", htmlBody: nil) == link)
    }

    // The fix.

    @Test(arguments: hostile)
    func aStoredHostileLinkGivesNoButton(link: String) async throws {
        let m = try await model([World.confirmation(["forwarding_confirm_url": .string(link)])])
        #expect(m.confirmURL == nil, "\(link) → \(String(describing: m.confirmURL?.host()))")
    }

    @Test(arguments: hostile)
    func aHostileLinkInTheTextBodyGivesNoButton(link: String) async throws {
        let m = try await model([World.confirmation(["text_body": .string("確認してください: \(link)")])])
        #expect(m.confirmURL == nil, "\(link) → \(String(describing: m.confirmURL?.host()))")
    }

    @Test(arguments: hostile)
    func aHostileStoredLinkFallsBackToAGoodBody(link: String) async throws {
        // As CX4: a stored value that fails goes on to the body.
        let m = try await model([World.confirmation([
            "forwarding_confirm_url": .string(link),
            "text_body": .string("確認してください: \(Self.real)"),
        ])])
        #expect(m.confirmURL?.absoluteString == Self.real, "\(link)")
    }

    // Positive controls: the real forms still open.

    @Test func theRealShapeStoredOpens() async throws {
        let m = try await model([World.confirmation(["forwarding_confirm_url": .string(Self.real)])])
        #expect(m.confirmURL?.absoluteString == Self.real)
        #expect(m.confirmURL?.host(percentEncoded: false) == "mail-settings.google.com")
    }

    @Test func theRealShapeInTheTextBodyOpens() async throws {
        let m = try await model([World.confirmation(["text_body": .string("確認するには次のリンクを開いてください: \(Self.real)")])])
        #expect(m.confirmURL?.absoluteString == Self.real)
    }

    @Test func theFixturesJapaneseFormOpens() async throws {
        // encodingInvalidCharacters stays as it is: this form must not be lost.
        let stored = try await model([World.confirmation(["forwarding_confirm_url": .string(Self.withJapanese)])])
        #expect(stored.confirmURL?.host(percentEncoded: false) == "mail-settings.google.com")
        #expect(stored.confirmURL?.path(percentEncoded: false) == "/mail/vf-abc。ご確認ください")
        let body = try await model([World.confirmation(["text_body": .string(Self.withJapanese)])])
        #expect(body.confirmURL?.host(percentEncoded: false) == "mail-settings.google.com")
        #expect(body.confirmURL?.path(percentEncoded: false) == "/mail/vf-abc。ご確認ください")
    }

    // The check right before openPage.

    @Test(arguments: hostile + [
        "https://mail-settings.google.com:8443/mail/vf-abc",
        "https://user@mail-settings.google.com/mail/vf-abc",
        "https://user:pw@mail-settings.google.com/mail/vf-abc",
        "https://mail-settings.google.com/settings/vf-abc",
        "https://mail-settings.google.com.evil.example/mail/vf-abc",
        "http://mail-settings.google.com/mail/vf-abc",
        "https://evil.example/mail/vf-abc",
    ])
    func theOpenCheckRefuses(link: String) throws {
        let url = try #require(URL(string: link), "\(link)")
        #expect(SettingsModel.isApprovalPage(url) == false, "\(link)")
    }

    @Test(arguments: [
        real,
        withJapanese,
        "https://mail-settings.google.com:443/mail/vf-abc",
        "https://mail-settings.google.com/mail/vf-abc123-def",
    ])
    func theOpenCheckLetsGooglesPageThrough(link: String) throws {
        let url = try #require(URL(string: link), "\(link)")
        #expect(SettingsModel.isApprovalPage(url), "\(link)")
    }

    @Test func everyLinkHandedOutPassesTheOpenCheck() async throws {
        // approvalURL and the check before opening agree (a positive control of the check).
        let m = try await model([World.confirmation(["forwarding_confirm_url": .string(Self.real)])])
        let url = try #require(m.confirmURL)
        #expect(SettingsModel.isApprovalPage(url))
    }
}

// MARK: - [S1] a first read cut off by the .task being cancelled

/// [S1] Leaving the tab while its first read is on the way cancels the `.task`: the cut-off answers
/// are not shown as 「読み込めませんでした」, and the next appearance reads again.
@Suite("Review fix 1: a cancelled first read (S1)", .serialized)
@MainActor
struct ReviewFix1CancelledReadTests {
    @Test func settingsDoesNotStickAtTheFailure() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        let gate = Gate()
        await fake.fail("GET", "user_keys", with: .hold(gate))
        let model = try await World.settings(fake)

        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "user_keys") == 1 })
        first.cancel()
        await World.settle()
        gate.open()
        await first.value
        // No flash of 「読み込めませんでした」 for a read that was only cut off.
        #expect(model.keyPanel != .failed)
        #expect(model.unread != .failed)
        #expect(model.dropped != .failed)

        // Shown again: read again (hasRead does not hold it back).
        await model.onAppear()
        let expected = SettingsModel.KeyPanel.present(oldKeyCount: .loaded(0))
        #expect(await waitFor { await model.keyPanel == expected }, "\(String(describing: model.keyPanel))")
        #expect(model.unread == .loaded(0))
    }

    @Test func theCalendarDoesNotFlashTheFailure() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["expected_date": "2026-11-05"])])
        let gate = Gate()
        await fake.fail("GET", "parcels", with: .hold(gate))
        let model = try await World.calendar(fake)

        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == 1 })
        first.cancel()
        await World.settle()
        gate.open()
        await first.value
        #expect(model.byDay != .failed)

        await model.onAppear()
        #expect(await waitFor { await model.byDay?.value != nil })
        #expect(model.entries(on: "2026-11-05").map(\.id) == [Rows.id(1)])
    }

    @Test func spendDoesNotFlashTheFailure() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1000])])
        let gate = Gate()
        await fake.fail("GET", "parcels", with: .hold(gate))
        let model = try await World.spend(fake)

        let first = Task { await model.onAppear() }
        #expect(await waitFor { await fake.count("GET", "parcels") == 1 })
        first.cancel()
        await World.settle()
        gate.open()
        await first.value
        #expect(model.parcels != .failed)

        await model.onAppear()
        #expect(await waitFor { await model.parcels?.value != nil })
        #expect(model.total?.total == 1000)
    }
}

// MARK: - [S2] the old-key count and the confirmation read fail on their own

/// [S2] The orchestrator's decision: as task.md (each read fails on its own, never 0), a failed
/// old-key count or a failed read of the forwarding confirmation shows SettingsModel.failedText,
/// told apart from a count of 0 and from no confirmation.
@Suite("Review fix 1: failures of the old-key count and the confirmation read (S2)")
@MainActor
struct ReviewFix1QuietFailureTests {
    private func model(mails: [Row] = [], faults: (FakeSupabase) async -> Void = { _ in }) async throws -> SettingsModel {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("emails", mails)
        await faults(fake)
        let model = try await World.settings(fake)
        await model.load()
        return model
    }

    @Test func aFailedOldKeyCountSaysSo() async throws {
        let m = try await model(faults: { await $0.fail(where: { !$0.query("body_envelope->>kid").isEmpty }, with: .http(500)) })
        guard case .present(.failed)? = m.keyPanel else {
            Issue.record("expected a key in use with a failed old-key count, got \(String(describing: m.keyPanel))")
            return
        }
        #expect(m.oldKeyNote == SettingsWebText.oldKeyCountFailed)
    }

    @Test func noOldKeyMailShowsNothing() async throws {
        // Positive control: 0 is not the failure.
        let m = try await model()
        #expect(m.keyPanel == .present(oldKeyCount: .loaded(0)))
        #expect(m.oldKeyNote == nil)
    }

    @Test func oldKeyMailIsCounted() async throws {
        let m = try await model(mails: [
            SettingsRows.mail(1, ["body_state": "sealed", "body_envelope": ["kid": "k0"]]),
            SettingsRows.mail(2, ["body_state": "sealed", "body_envelope": ["kid": "k0"]]),
        ])
        #expect(m.oldKeyNote == SettingsModel.oldKeyText(2))
    }

    @Test func noKeyInUseHasNoOldKeyLine() async throws {
        let fake = FakeSupabase.make()
        let m = try await World.settings(fake)
        await m.load()
        #expect(m.keyPanel == .none)
        #expect(m.oldKeyNote == nil)
    }

    @Test func aFailedConfirmationReadSaysSo() async throws {
        let m = try await model(
            mails: [World.confirmation(["forwarding_confirm_url": .string(SettingsRows.google)])],
            faults: { await $0.fail(where: { $0.url.lastPathComponent == "emails" && $0.query("classification") == ["eq.forwarding_confirmation"] }, with: .http(500)) }
        )
        #expect(m.confirmURL == nil)
        #expect(m.approvalNote == SettingsWebText.approvalReadFailed)
        // The other reads are not dragged down with it (the confirmation mail is a plain one).
        #expect(m.keyPanel == .present(oldKeyCount: .loaded(0)))
        #expect(m.unread == .loaded(0))
    }

    @Test func noConfirmationShowsNothing() async throws {
        // Positive control: none is not the failure.
        let m = try await model()
        #expect(m.confirmURL == nil)
        #expect(m.approvalNote == nil)
    }

    @Test func aConfirmationReadShowsNoNote() async throws {
        let m = try await model(mails: [World.confirmation(["forwarding_confirm_url": .string(SettingsRows.google)])])
        #expect(m.confirmURL?.absoluteString == SettingsRows.google)
        #expect(m.approvalNote == nil)
    }
}

// MARK: - [S3] the login widget

/// [S3; password-v1] A form change makes a new widget: the token of the old one is not kept. (The code step and
/// its 60-second wait are gone with the code login.)
@Suite("Review fix 1: the login widget across steps (S3)")
@MainActor
struct ReviewFix1LoginWidgetTests {
    private let start = Date(timeIntervalSince1970: 1_793_000_000)

    private func make(_ fake: FakeSupabase, clock: TestClock) -> (LoginModel, TurnstileToken) {
        let auth = AuthService(provider: SupabaseProvider(config: fake.config, urlSession: fake.urlSession, storage: InMemorySessionStorage()), deriver: PW.fastDeriver())
        let token = TurnstileToken()
        let model = LoginModel(auth: auth, launch: LaunchOptions(arguments: ["Otodoke"]), now: clock.function, turnstile: token, tokenWait: .milliseconds(100))
        model.email = FakeSupabase.email
        return (model, token)
    }

    private func sentToken(_ fake: FakeSupabase, _ endpoint: String, _ nth: Int) async -> String? {
        let sent = await fake.requests("POST", endpoint)
        guard sent.count >= nth else { return nil }
        return PW.captcha(sent[nth - 1])
    }

    @Test func changingTheAddressDropsTheOldWidgetsToken() async {
        let fake = FakeSupabase.make()
        let clock = TestClock(start)
        let (model, token) = make(fake, clock: clock)
        token.receive(.token("tok-1"), generation: 0)
        model.password = PW.good
        await model.submit()
        #expect(await sentToken(fake, "token", 1) == "tok-1")
        // The sign-in form's widget gives a token; then the sign-up form (a new widget) is shown.
        token.receive(.token("tok-2"), generation: token.generation)
        #expect(token.hasToken)
        let before = token.generation
        model.setMode(.signUp)
        #expect(model.mode == .signUp)
        #expect(token.hasToken == false)
        #expect(token.generation > before)
        // The next press does not carry the old widget's token.
        model.password = PW.good
        model.passwordAgain = PW.good
        await model.submit()
        #expect(await fake.count("POST", "signup") == 1)
        #expect(await sentToken(fake, "signup", 1) == nil)
    }
}

// MARK: - [N2] a load during a month move

/// [N2] = [Codex #6] load() (coming back to the front) during a move to another month: the month
/// moved to stays.
@Suite("Review fix 1: the calendar's move and a load (N2)")
@MainActor
struct ReviewFix1CalendarMoveTests {
    @Test func aLoadDuringAMoveKeepsTheMonthMovedTo() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [
            Rows.parcel(1, ["expected_date": "2026-11-05"]),
            Rows.parcel(8, ["expected_date": "2026-12-01"]),
        ])
        let model = try await World.calendar(fake)
        await model.load()
        #expect(model.month == "2026-11")

        let gate = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let move = Task { await model.nextMonth() }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        #expect(model.isMoving)
        await model.load()
        gate.open()
        await move.value
        #expect(model.month == "2026-12")
        #expect(model.entries(on: "2026-12-01").map(\.id) == [Rows.id(8)])
        #expect(model.isMoving == false)
    }

    @Test func comingBackDuringAMoveKeepsTheMonthMovedTo() async throws {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", [Rows.parcel(8, ["expected_date": "2026-12-01"])])
        let model = try await World.calendar(fake)
        await model.load()

        let gate = Gate()
        let reads = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: reads + 1, with: .hold(gate))
        let move = Task { await model.show(month: "2026-12") }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        await model.sceneBecameActive()
        gate.open()
        await move.value
        #expect(model.month == "2026-12")
    }
}

// MARK: - [N3] ScreenRefresher by token, tab and stack

/// [N3] = [Codex #5, #7] Each appearance has its own token; a screen that disappears is let go; the
/// front is the selected tab's top screen (a pushed detail over its root), whatever the order the
/// appear and disappear calls come in.
@Suite("Review fix 1: ScreenRefresher by token, tab and stack (N3)")
@MainActor
struct ReviewFix1RefresherTests {
    final class Calls {
        var list: [String] = []
    }

    final class Box {}

    final class Weak {
        weak var value: Box?
        init(_ value: Box) { self.value = value }
    }

    @Test func theSameDetailInTwoTabsReadsTheOneInFront() async {
        let calls = Calls()
        let id = Rows.id(1)
        let r = ScreenRefresher()
        r.select(.calendar)
        let calendarRoot = r.appeared(.calendar, in: .calendar) { calls.list.append("calendar") }
        let calendarDetail = r.appeared(.detail(id), in: .calendar) { calls.list.append("calendar's detail") }
        r.disappeared(calendarRoot)
        await r.sceneBecameActive()
        #expect(calls.list == ["calendar's detail"])

        // To the parcels tab, where the same parcel is open too: it appears before the other goes.
        r.select(.parcels)
        let parcelsDetail = r.appeared(.detail(id), in: .parcels) { calls.list.append("parcels' detail") }
        r.disappeared(calendarDetail)
        await r.sceneBecameActive()
        #expect(calls.list == ["calendar's detail", "parcels' detail"])

        // Back to the calendar tab: its detail is in front again (the other goes after it appears).
        r.select(.calendar)
        let again = r.appeared(.detail(id), in: .calendar) { calls.list.append("calendar's detail") }
        r.disappeared(parcelsDetail)
        await r.sceneBecameActive()
        #expect(calls.list == ["calendar's detail", "parcels' detail", "calendar's detail"])
        r.disappeared(again)
    }

    @Test func aDetailThatDisappearedIsLetGo() async {
        let calls = Calls()
        let r = ScreenRefresher()
        r.select(.parcels)
        var box: Box? = Box()
        let ref = Weak(box!)
        let token = r.appeared(.detail(Rows.id(1)), in: .parcels) { [box] in
            _ = box
            calls.list.append("detail")
        }
        box = nil
        await r.sceneBecameActive()
        #expect(calls.list == ["detail"])
        #expect(ref.value != nil)
        r.disappeared(token)
        #expect(ref.value == nil)
        await r.sceneBecameActive()
        #expect(calls.list == ["detail"])
    }

    @Test func detailsDoNotPileUp() async {
        let calls = Calls()
        let r = ScreenRefresher()
        r.select(.spend)
        var weaks: [Weak] = []
        for n in 1...100 {
            let box = Box()
            weaks.append(Weak(box))
            let token = r.appeared(.detail(Rows.id(n)), in: .spend) { [box] in
                _ = box
                calls.list.append("detail \(n)")
            }
            await r.sceneBecameActive()
            r.disappeared(token)
        }
        #expect(calls.list.count == 100)
        #expect(calls.list.last == "detail 100")
        #expect(weaks.allSatisfy { $0.value == nil })
    }

    @Test func theFrontIsTheSelectedTabsTopScreenWhateverTheOrder() async {
        let calls = Calls()
        let id = Rows.id(1)
        let r = ScreenRefresher()
        r.select(.parcels)
        // The pushed detail reports before its tab's root does.
        let detail = r.appeared(.detail(id), in: .parcels) { calls.list.append("detail") }
        let root = r.appeared(.parcels, in: .parcels) { calls.list.append("parcels") }
        await r.sceneBecameActive()
        #expect(calls.list == ["detail"])

        // Another tab's screen reports before the selection moves: the parcels tab is still in front.
        let spend = r.appeared(.spend, in: .spend) { calls.list.append("spend") }
        await r.sceneBecameActive()
        #expect(calls.list == ["detail", "detail"])
        r.select(.spend)
        await r.sceneBecameActive()
        #expect(calls.list == ["detail", "detail", "spend"])

        // Back on the parcels tab with the detail popped: the root is in front.
        r.select(.parcels)
        r.disappeared(detail)
        await r.sceneBecameActive()
        #expect(calls.list == ["detail", "detail", "spend", "parcels"])
        r.disappeared(root)
        r.disappeared(spend)
    }
}

// MARK: - [Codex #3] a period move overlapping a category save

/// [Codex #3] A period move that a save overlapped is read once the save ends: a load() meanwhile
/// (coming back to the front) does not lose it, and the spinner stays until the period moved to is
/// shown (also during the read after the save).
@Suite("Review fix 1: a spend move overlapping a save (Codex #3)", .serialized)
@MainActor
struct ReviewFix1SpendMoveAndSaveTests {
    static let rows: [Row] = [
        Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1000, "category": "food", "shop": "テスト店"]),
        Rows.parcel(2, ["ordered_at": "2026-11-03", "total_amount": 3000, "category": nil, "shop": "別の店"]),
        Rows.parcel(4, ["ordered_at": "2026-10-15", "total_amount": 500, "category": "food", "shop": "テスト店"]),
    ]

    private func loaded() async throws -> (FakeSupabase, SpendModel) {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.rows)
        let model = try await World.spend(fake)
        await model.load()
        return (fake, model)
    }

    private func shownIDs(_ m: SpendModel) -> [String] { m.parcels?.value?.map(\.id) ?? [] }

    @Test func aComingBackDoesNotLoseTheMoveWaitingForTheSave() async throws {
        let (fake, model) = try await loaded()
        let save = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(save))
        let saving = Task { await model.setCategory(parcelID: Rows.id(2), to: .daily) }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })

        let reads = await fake.count("GET", "parcels")
        let move = Task { await model.showMonth("2026-10") }
        // The move's read is answered while the save is on the way (so it is stale).
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        await World.settle()

        // Back in front meanwhile.
        await model.load()
        #expect(model.isDimmed, "the move is not shown yet")

        save.open()
        await saving.value
        await move.value
        #expect(await waitFor { await model.period == .month("2026-10") }, "\(model.period)")
        #expect(shownIDs(model) == [Rows.id(4)])
        #expect(model.isDimmed == false)
    }

    @Test func theSpinnerStaysUntilTheMonthMovedToIsShown() async throws {
        let (fake, model) = try await loaded()
        let save = Gate()
        await fake.fail("PATCH", "parcels", with: .hold(save))
        let saving = Task { await model.setCategory(parcelID: Rows.id(2), to: .daily) }
        #expect(await waitFor { await fake.count("PATCH", "parcels") == 1 })

        let reads = await fake.count("GET", "parcels")
        let move = Task { await model.showMonth("2026-10") }
        #expect(await waitFor { await fake.count("GET", "parcels") == reads + 1 })
        await World.settle()
        // The move's read came back stale (the save is on the way): October is not shown yet.
        #expect(model.period == .month("2026-11"))
        #expect(model.isDimmed)

        // The read after the save: held, and the spinner still shows.
        let after = Gate()
        let now = await fake.count("GET", "parcels")
        await fake.fail("GET", "parcels", nth: now + 1, with: .hold(after))
        save.open()
        #expect(await waitFor { await fake.count("GET", "parcels") == now + 1 })
        #expect(model.isDimmed)
        after.open()
        await saving.value
        await move.value
        #expect(await waitFor { await model.period == .month("2026-10") }, "\(model.period)")
        #expect(model.isDimmed == false)
    }
}

// MARK: - [Codex #4] shop names compared as the Web compares them

/// [Codex #4] Swift's String `==` and Dictionary keys treat canonically equivalent names (NFC 「ガ」 and
/// NFD 「カ」+U+3099) as one; the Web and Spend.slices compare UTF-16 units and keep them as two
/// shops. The 店ごと rows and the narrowed totals must agree.
@Suite("Review fix 1: shop names in NFC and NFD (Codex #4)")
@MainActor
struct ReviewFix1ShopNameTests {
    static let nfc = "\u{30AC}店"
    static let nfd = "\u{30AB}\u{3099}店"

    static let rows: [Row] = [
        Rows.parcel(1, ["ordered_at": "2026-11-02", "total_amount": 1000, "shop": .string(nfc)]),
        Rows.parcel(2, ["ordered_at": "2026-11-03", "total_amount": 2000, "shop": .string(nfd)]),
    ]

    private func loaded() async throws -> SpendModel {
        let fake = FakeSupabase.make()
        await fake.insert("parcels", Self.rows)
        let model = try await World.spend(fake)
        await model.load()
        return model
    }

    private func units(_ s: String?) -> [UInt16] { Array((s ?? "").utf16) }

    @Test func theTrap() {
        // Negative control: Swift says equal, the Web does not.
        #expect(Self.nfc == Self.nfd)
        #expect(units(Self.nfc) != units(Self.nfd))
        #expect(JSText.equal(Self.nfc, Self.nfd) == false)
    }

    @Test func twoShopsByShop() async throws {
        let m = try await loaded()
        let rows = m.shopRows
        #expect(rows.count == 2)
        #expect(rows.map { units($0.name) } == [units(Self.nfd), units(Self.nfc)])
        #expect(rows.map(\.amount) == [2000, 1000])
    }

    @Test func eachShopRowEqualsItsNarrowedTotal() async throws {
        let m = try await loaded()
        let rows = m.shopRows
        #expect(!rows.isEmpty)
        for row in rows {
            await m.toggleShop(row.name)
            #expect(units(m.shop) == units(row.name))
            #expect(m.total?.total == row.amount, "\(row.name)")
            await m.clearShop()
            #expect(m.shop == nil)
        }
    }

    @Test func fromOneSpellingToTheOtherNarrowsToTheOther() async throws {
        let m = try await loaded()
        await m.toggleShop(Self.nfc)
        #expect(units(m.shop) == units(Self.nfc))
        #expect(m.total?.total == 1000)
        await m.toggleShop(Self.nfd)
        #expect(units(m.shop) == units(Self.nfd))
        #expect(m.total?.total == 2000)
        // The same spelling again takes it off.
        await m.toggleShop(Self.nfd)
        #expect(m.shop == nil)
    }
}

// MARK: - [SEC-N1] Turnstile's new windows

/// [SEC-N1] A new window of the widget (「プライバシー」「ヘルプ」) goes to Safari only for cloudflare.com
/// and its subdomains.
@Suite("Review fix 1: Turnstile's new windows (SEC-N1)")
struct ReviewFix1TurnstileWindowTests {
    @Test(arguments: [
        "https://www.cloudflare.com/privacypolicy/",
        "https://cloudflare.com/",
        "https://developers.cloudflare.com/turnstile/",
        "https://www.cloudflare.com/website-terms/",
    ])
    func cloudflareGoesToSafari(link: String) throws {
        let url = try #require(URL(string: link))
        #expect(Turnstile.externalURL(forNewWindow: url) == url, "\(link)")
    }

    @Test(arguments: [
        "https://example.com/",
        "https://evil.example/www.cloudflare.com/",
        "https://cloudflare.com.evil.example/",
        "https://challenges.cloudflare.com.evil.example/",
        "https://notcloudflare.com/",
        "https://evilcloudflare.com/",
        "https://www.cloudflare.com@evil.example/",
        "https://otodoke.app/",
    ])
    func anotherHttpsHostDoesNot(link: String) throws {
        let url = try #require(URL(string: link))
        #expect(Turnstile.externalURL(forNewWindow: url) == nil, "\(link)")
    }
}
