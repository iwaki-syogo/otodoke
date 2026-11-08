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
        let firstID = Rows.id(60_001)
    }

    private func setUp(token: Bool = true) async throws -> Setup {
        let fake = FakeSupabase.make()
        await fake.insert("user_keys", [SettingsRows.key(1, keyID: "k1")])
        await fake.insert("screen_events", [SettingsRows.dropped(1), SettingsRows.dropped(2)])
        await fake.setUnreadEmails(3)
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
            }
        )
        model.mailActions = actions
        return Setup(fake: fake, server: server, model: model, actions: actions, counter: counter)
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

    @Test func theTimesAreTheDocumentedOnes() {
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

    // MARK: no Web page

    @Test func neitherButtonOpensTheWebAnyMore() {
        let names = SettingsWebAction.allCases.map { "\($0)" }
        #expect(!names.contains("readWaiting"))
        #expect(!names.contains("markAsParcel"))
        // Negative control: the list does carry the names of the pages that still open on the Web.
        #expect(names.contains("privacy"))
    }
}
