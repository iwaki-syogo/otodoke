import Foundation
import Testing
@testable import Otodoke

/// 「これは荷物」 and 「読み取る」 finish inside the app: the Web's mail endpoints (stubbed on a made-up host, nothing
/// leaves the machine) are asked, the sentence of the answer is shown, and the settings are read again.
@Suite("Settings: 「これは荷物」 and 「読み取る」 in the app")
@MainActor
struct MailActionsTests {
    @MainActor
    final class Counter {
        var reloads = 0
    }

    struct Setup {
        let fake: FakeSupabase
        let server: FakeMailServer
        let model: SettingsModel
        let actions: MailActionsModel
        let counter: Counter
        let changes: DataChanges
        let firstID = Rows.id(60_001)
    }

    private func setUp(token: Bool = true, live: Bool = false) async throws -> Setup {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("screen_events", [SettingsRows.dropped(1), SettingsRows.dropped(2)])
        await fake.setUnreadEmails(3)
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
        let server = FakeMailServer.make(supabase: fake)
        let counter = Counter()
        let actions = MailActionsModel(
            api: MailActionsClient(baseURL: server.baseURL, session: server.urlSession),
            accessToken: {
                guard token else { return nil }
                return try? await provider.auth.session.accessToken
            },
            reload: { [unowned model] in
                counter.reloads += 1
                await model.load()
            },
            announceChange: { ParcelWriter.announceOutsideChange(changes) }
        )
        // `live`: the model's own wiring (its server is the Web's real host, which the stub session refuses).
        if !live { model.mailActions = actions }
        return Setup(fake: fake, server: server, model: model, actions: live ? model.mailActions : actions, counter: counter, changes: changes)
    }

    /// The dropped row `id` as the list shows it.
    private func row(_ s: Setup, _ id: String) -> DroppedMailRow? {
        s.model.dropped?.value?.first { $0.id == id }
    }

    private func waitForRequests(_ server: FakeMailServer, _ endpoint: String, _ n: Int) async {
        for _ in 0..<200 where await server.count(endpoint) < n {
            try? await Task.sleep(for: .milliseconds(25))
        }
    }

    // MARK: 「これは荷物」

    @Test func eachOutcomeSaysItsOwnSentenceAndTheListIsReadAgain() async throws {
        let expected: [(MarkParcelOutcome, String)] = [
            (.remembered, "覚えました。この差出人のメールは、次から Claude が確認します。今回の荷物は手で登録できます。"),
            (.shared, "Gmail など多くの人が使うアドレスは、差出人として覚えられません。今回の荷物は手で登録できます。"),
            (.forwarded, "手で転送されたメールは、差出人として覚えられません。今回の荷物は手で登録できます。"),
            (.own, "ご自身のアドレスから届いたメールは、差出人として覚えられません。今回の荷物は手で登録できます。"),
        ]
        for (outcome, text) in expected {
            let s = try await setUp()
            await s.server.setOutcome(outcome)
            await s.actions.markAsParcel(id: s.firstID)
            #expect(s.actions.markNote == .init(text: text, isError: false, offersRegister: true), "\(outcome)")
            #expect(s.actions.markingID == nil)
            #expect(s.counter.reloads == 1, "\(outcome)")
            // Only `remembered` marks the row; the list was read again either way.
            #expect((row(s, s.firstID)?.flaggedAt != nil) == (outcome == .remembered), "\(outcome)")
        }
    }

    @Test func theRequestIsTheDocumentedOne() async throws {
        let s = try await setUp()
        await s.actions.markAsParcel(id: s.firstID)
        let requests = await s.server.requests("mark-parcel")
        #expect(requests.count == 1)
        let request = try #require(requests.first)
        #expect(request.method == "POST")
        #expect(request.path == "/api/mail/mark-parcel")
        #expect(request.header("content-type") == "application/json")
        #expect(request.header("authorization")?.hasPrefix("Bearer ") == true)
        #expect(request.jsonDictionary as? [String: String] == ["id": s.firstID])
    }

    @Test(arguments: [
        (401, "unauthorized", LoginText.signedOut),
        (400, "invalid_input", "記録できませんでした。もう一度お試しください。"),
        (404, "not_found", "記録できませんでした。もう一度お試しください。"),
        (500, "mark_failed", "記録できませんでした。もう一度お試しください。"),
        (503, "unavailable", "記録できませんでした。もう一度お試しください。"),
        (500, "something_new", "記録できませんでした。もう一度お試しください。"),
    ])
    func eachFailureCodeSaysItsSentence(_ status: Int, _ code: String, _ text: String) async throws {
        let s = try await setUp()
        await s.server.force("mark-parcel", .answer(status: status, ok: false, code: code))
        await s.actions.markAsParcel(id: s.firstID)
        #expect(s.actions.markNote == .init(text: text, isError: true, offersRegister: false))
        #expect(s.actions.markingID == nil)
        #expect(row(s, s.firstID)?.flaggedAt == nil)
        // The result of a failure is read again too (the person sees what is there).
        #expect(s.counter.reloads == 1)
    }

    @Test func noAnswerIsAFailureButARunOutOfTimeIsNot() async throws {
        let offline = try await setUp()
        await offline.server.force("mark-parcel", .transport(.notConnectedToInternet))
        await offline.actions.markAsParcel(id: offline.firstID)
        #expect(offline.actions.markNote?.text == "記録できませんでした。もう一度お試しください。")

        // Out of time: whether the server marked it is not known. No sentence; the list is read again and tells.
        for code in [URLError.Code.timedOut, .cancelled] {
            let s = try await setUp()
            await s.server.force("mark-parcel", .transport(code))
            await s.actions.markAsParcel(id: s.firstID)
            #expect(s.actions.markNote == nil, "\(code)")
            #expect(s.counter.reloads == 1, "\(code)")
        }
    }

    @Test func anAnswerThatIsNotTheEndpointsIsNotShownAsSuccessOrFailure() async throws {
        let s = try await setUp()
        // 200 ok:true but no known outcome.
        await s.server.force("mark-parcel", .answer(status: 200, ok: true, code: nil))
        await s.actions.markAsParcel(id: s.firstID)
        #expect(s.actions.markNote == nil)
        #expect(s.counter.reloads == 1)
    }

    @Test func aSecondPressWhileOneRunsSendsNothing() async throws {
        let s = try await setUp()
        let gate = Gate()
        await s.server.hold("mark-parcel", on: gate)
        let first = Task { await s.actions.markAsParcel(id: s.firstID) }
        await waitForRequests(s.server, "mark-parcel", 1)
        #expect(s.actions.markingID == s.firstID)
        // The same row again, and another row: both do nothing.
        await s.actions.markAsParcel(id: s.firstID)
        await s.actions.markAsParcel(id: Rows.id(60_002))
        gate.open()
        await first.value
        #expect(await s.server.count("mark-parcel") == 1)
        #expect(s.counter.reloads == 1)
        #expect(s.actions.markingID == nil)
        // Negative control: pressing after it is over is a new request.
        await s.actions.markAsParcel(id: Rows.id(60_002))
        #expect(await s.server.count("mark-parcel") == 2)
    }

    @Test func withoutASessionNothingIsSentAndTheWordsAreTheLoginOnes() async throws {
        let s = try await setUp(token: false)
        await s.actions.markAsParcel(id: s.firstID)
        #expect(s.actions.markNote == .init(text: "ログインし直してください。", isError: true, offersRegister: false))
        #expect(await s.server.count("mark-parcel") == 0)
        await s.actions.readWaiting()
        #expect(s.actions.readNote == "ログインし直してください。")
        #expect(await s.server.count("read-waiting") == 0)
    }

    @Test func theNoteGoesWhenThePageIsLeft() async throws {
        let s = try await setUp()
        await s.actions.markAsParcel(id: s.firstID)
        #expect(s.actions.markNote != nil)
        s.actions.clearNotes()
        #expect(s.actions.markNote == nil)
    }

    // MARK: 「読み取る」

    @Test func readingEmptiesTheUnreadCountAndSendsTheDocumentedRequest() async throws {
        let s = try await setUp()
        #expect(s.model.unread == .loaded(3))
        await s.actions.readWaiting()
        #expect(s.model.unread == .loaded(0))
        #expect(s.actions.readNote == nil)
        #expect(s.actions.isReading == false)
        #expect(s.counter.reloads == 1)
        let requests = await s.server.requests("read-waiting")
        #expect(requests.count == 1)
        let request = try #require(requests.first)
        #expect(request.method == "POST")
        #expect(request.path == "/api/mail/read-waiting")
        #expect(request.header("authorization")?.hasPrefix("Bearer ") == true)
        #expect(request.jsonDictionary?.isEmpty == true)
    }

    @Test func overLimitAndBusyAreNotFailuresAndSayNothing() async throws {
        for (over, busy) in [(true, false), (false, true)] {
            let s = try await setUp()
            await s.server.force("read-waiting", .answer(status: 200, ok: true, code: nil, extra: ["over_limit": over, "busy": busy]))
            await s.actions.readWaiting()
            #expect(s.actions.readNote == nil)
            #expect(s.counter.reloads == 1)
            #expect(await s.server.count("read-waiting") == 1)
        }
    }

    @Test func theTimesAreTheDocumentedOnes() {
        #expect(MailActionsClient.readTimeout > 300)
        #expect(MailActionsClient.readTimeout == 310)
        #expect(MailActionsClient.markTimeout == 30)
    }

    @Test(arguments: [
        (500, "read_failed", "読み取れなかったメールがあります。少し時間をおいて、もう一度お試しください。"),
        (200, "read_failed", "読み取れなかったメールがあります。少し時間をおいて、もう一度お試しください。"),
        (401, "unauthorized", "ログインし直してください。"),
        (503, "unavailable", "うまくいきませんでした。もう一度お試しください。"),
        (400, "invalid_input", "うまくいきませんでした。もう一度お試しください。"),
        (500, "something_new", "うまくいきませんでした。もう一度お試しください。"),
    ])
    func eachFailureCodeOfReadingSaysItsSentence(_ status: Int, _ code: String, _ text: String) async throws {
        let s = try await setUp()
        await s.server.force("read-waiting", .answer(status: status, ok: false, code: code))
        await s.actions.readWaiting()
        #expect(s.actions.readNote == text)
        #expect(s.actions.isReading == false)
        // Some mails may have been read before it failed: the count is read again.
        #expect(s.counter.reloads == 1)
        #expect(s.model.unread == .loaded(3))
    }

    @Test func aRunOutOfTimeIsReadAgainAndNotShownAsAFailure() async throws {
        for code in [URLError.Code.timedOut, .cancelled] {
            let s = try await setUp()
            await s.server.force("read-waiting", .transport(code))
            await s.actions.readWaiting()
            #expect(s.actions.readNote == nil, "\(code)")
            #expect(s.counter.reloads == 1, "\(code)")
        }
        // Negative control: no answer at all (offline) is told.
        let s = try await setUp()
        await s.server.force("read-waiting", .transport(.notConnectedToInternet))
        await s.actions.readWaiting()
        #expect(s.actions.readNote == "うまくいきませんでした。もう一度お試しください。")
    }

    @Test func aSecondPressWhileReadingSendsNothingAndTheSpinnerShows() async throws {
        let s = try await setUp()
        let gate = Gate()
        await s.server.hold("read-waiting", on: gate)
        let first = Task { await s.actions.readWaiting() }
        await waitForRequests(s.server, "read-waiting", 1)
        #expect(s.actions.isReading)
        await s.actions.readWaiting()
        gate.open()
        await first.value
        #expect(await s.server.count("read-waiting") == 1)
        #expect(s.counter.reloads == 1)
        #expect(s.actions.isReading == false)
    }

    @Test func aNewPressClearsTheOldFailure() async throws {
        let s = try await setUp()
        await s.server.force("read-waiting", nth: 1, .answer(status: 500, ok: false, code: "read_failed"))
        await s.actions.readWaiting()
        #expect(s.actions.readNote != nil)
        await s.actions.readWaiting()
        #expect(s.actions.readNote == nil)
        #expect(s.model.unread == .loaded(0))
    }

    // MARK: the other tabs

    @Test func readingTellsTheOtherTabsOnceWhateverCameOfIt() async throws {
        let answers: [FakeMailServer.Forced?] = [
            nil,
            .answer(status: 500, ok: false, code: "read_failed"),
            .transport(.timedOut),
            .transport(.networkConnectionLost),
        ]
        for forced in answers {
            let s = try await setUp()
            if let forced { await s.server.force("read-waiting", forced) }
            let before = s.changes.version
            await s.actions.readWaiting()
            #expect(s.changes.version == before + 1, "\(String(describing: forced))")
        }
    }

    @Test func markingAParcelDoesNotTellTheOtherTabs() async throws {
        for outcome in [MarkParcelOutcome.remembered, .shared] {
            let s = try await setUp()
            await s.server.setOutcome(outcome)
            let before = s.changes.version
            await s.actions.markAsParcel(id: s.firstID)
            #expect(s.changes.version == before, "\(outcome)")
        }
    }

    @Test func theModelsOwnWiringPublishesToItsChanges() async throws {
        // The live wiring points at the Web's real host, which the stub session refuses: nothing leaves the test,
        // and a run whose answer did not come still announces (parcels may have been added).
        let s = try await setUp(live: true)
        let before = s.changes.version
        await s.actions.readWaiting()
        #expect(s.changes.version == before + 1)
        await s.actions.markAsParcel(id: s.firstID)
        #expect(s.changes.version == before + 1)
    }

    // MARK: the connection breaks after sending

    @Test func aBrokenConnectionOrAGatewayPageIsNotShownAsAFailure() async throws {
        let cases: [FakeMailServer.Forced] = [.transport(.networkConnectionLost), .transport(.secureConnectionFailed), .raw(status: 504), .raw(status: 502)]
        for forced in cases {
            let marking = try await setUp()
            await marking.server.force("mark-parcel", forced)
            await marking.actions.markAsParcel(id: marking.firstID)
            #expect(marking.actions.markNote == nil, "\(forced)")
            #expect(marking.counter.reloads == 1, "\(forced)")
            let reading = try await setUp()
            await reading.server.force("read-waiting", forced)
            await reading.actions.readWaiting()
            #expect(reading.actions.readNote == nil, "\(forced)")
            #expect(reading.counter.reloads == 1, "\(forced)")
        }
        // Negative control: nothing was sent, or it is not a gateway: still a failure.
        for forced in [FakeMailServer.Forced.transport(.notConnectedToInternet), .transport(.cannotConnectToHost), .raw(status: 404), .raw(status: 302)] {
            let s = try await setUp()
            await s.server.force("mark-parcel", forced)
            await s.actions.markAsParcel(id: s.firstID)
            #expect(s.actions.markNote?.isError == true, "\(forced)")
        }
    }

    // MARK: leaving the page

    @Test func leavingTheSettingsTakesTheReadNoteAway() async throws {
        let s = try await setUp()
        await s.server.force("read-waiting", .answer(status: 500, ok: false, code: "read_failed"))
        await s.actions.readWaiting()
        #expect(s.actions.readNote != nil)
        s.actions.clearReadNote()
        #expect(s.actions.readNote == nil)
    }

    @Test func aPageLeftWhileItRunsKeepsNoNoteWhenItEnds() async throws {
        let s = try await setUp()
        let gate = Gate()
        await s.server.hold("mark-parcel", on: gate)
        await s.server.force("mark-parcel", .answer(status: 503, ok: false, code: "unavailable"))
        let marking = Task { await s.actions.markAsParcel(id: s.firstID) }
        await waitForRequests(s.server, "mark-parcel", 1)
        s.actions.clearNotes()
        gate.open()
        await marking.value
        #expect(s.actions.markNote == nil)

        let readGate = Gate()
        await s.server.hold("read-waiting", on: readGate)
        await s.server.force("read-waiting", .answer(status: 500, ok: false, code: "read_failed"))
        let reading = Task { await s.actions.readWaiting() }
        await waitForRequests(s.server, "read-waiting", 1)
        s.actions.clearReadNote()
        readGate.open()
        await reading.value
        #expect(s.actions.readNote == nil)
        // Negative control: a run not left shows its note.
        await s.server.hold("read-waiting", on: Gate.opened())
        await s.server.force("read-waiting", nth: 2, .answer(status: 500, ok: false, code: "read_failed"))
        await s.actions.readWaiting()
        #expect(s.actions.readNote != nil)
    }

    @Test func theRequestsCarryTheirTimeouts() async throws {
        let s = try await setUp()
        await s.actions.markAsParcel(id: s.firstID)
        await s.actions.readWaiting()
        #expect(await s.server.requests("mark-parcel").first?.timeoutInterval == 30)
        #expect(await s.server.requests("read-waiting").first?.timeoutInterval == 310)
    }

    // MARK: no Web page

    @Test func neitherButtonOpensTheWebAnyMore() {
        let names = SettingsWebAction.allCases.map { "\($0)" }
        #expect(!names.contains("readWaiting"))
        #expect(!names.contains("markAsParcel"))
        // Negative control: the list does carry the names of the pages that still open on the Web.
        #expect(names.contains("privacy"))
    }
}
