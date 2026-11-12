import Foundation
import Testing
@testable import Otodoke

@Suite("Settings mail recovery: owner-scoped notices and remembered senders (N3/N5)")
@MainActor
struct SettingsMailRecoveryTests {
    nonisolated static let stamp = "2026-11-12T01:02:03.123456+00:00"
    nonisolated static let newer = "2026-11-12T01:02:03.123457+00:00"

    struct World {
        let fake: FakeSupabase
        let provider: SupabaseProvider
        let auth: AuthService
        let model: SettingsModel
    }

    @MainActor final class Context {
        var current = true
        var reloads = 0
    }

    private func world(_ fake: FakeSupabase = .make()) async throws -> World {
        let (provider, auth) = try await TestSession.signedIn(fake)
        let model = SettingsModel(
            consent: .allowedForTests(), reader: SettingsReader(provider: provider),
            inbox: InboxAddressService(provider: provider, randomBytes: { Array(repeating: 0, count: $0) }),
            auth: auth, inboundDomain: fake.config.inboundDomain, changes: DataChanges(),
            now: { ISO.date("2026-11-12T02:00:00Z")! }
        )
        return World(fake: fake, provider: provider, auth: auth, model: model)
    }

    private nonisolated func notice(_ stamp: String?, user: String = FakeSupabase.me) -> Row {
        ["user_id": .string(user), "limited_at": stamp.map(JSONValue.string) ?? .null]
    }

    private nonisolated func marked(_ n: Int, _ domain: String) -> Row {
        SettingsRows.dropped(n, ["from_domain": .string(domain), "flagged_at": .string(Self.stamp)])
    }

    private func actions(_ world: World, server: FakeSettingsMailServer, context: Context) -> SettingsMailRecoveryModel {
        SettingsMailRecoveryModel(
            api: SettingsMailActionsClient(baseURL: server.baseURL, session: server.urlSession),
            accessToken: { try? await world.provider.auth.session.accessToken },
            isCurrent: { context.current },
            reload: { context.reloads += 1; await world.model.load() }
        )
    }

    private func waitForRequest(_ server: FakeSettingsMailServer) async {
        for _ in 0..<200 {
            if !(await server.requests()).isEmpty { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        Issue.record("the local request did not start")
    }

    // MARK: actual Reader and model reads, through URLProtocol

    @Test func noticeDistinguishesAbsentNullMalformedFailureAndRawServerStamp() async throws {
        let w = try await world()
        let reader = w.model.reader
        #expect(await reader.intakeNotice() == .loaded(nil))
        await w.fake.insert("mail_intake_notices", [notice(nil)])
        #expect(await reader.intakeNotice() == .failed)
        await w.fake.mutate { tables in
            tables["mail_intake_notices"] = [notice(Self.stamp), notice(Self.newer, user: FakeSupabase.other)]
        }
        #expect(await reader.intakeNotice() == .loaded(Self.stamp))
        let requests = await w.fake.requests("GET", "mail_intake_notices")
        #expect(!requests.isEmpty)
        for request in requests {
            #expect(request.query("user_id") == ["eq.\(FakeSupabase.me)"])
            #expect(request.query("select") == ["limited_at"])
        }
        await w.fake.mutate { $0["mail_intake_notices"] = [["user_id": .string(FakeSupabase.me)]] }
        #expect(await reader.intakeNotice() == .failed)
        await w.fake.mutate { $0["mail_intake_notices"] = [notice("broken")] }
        #expect(await reader.intakeNotice() == .failed)
        await w.fake.failAlways(where: { $0.url.lastPathComponent == "mail_intake_notices" }, with: .http(503))
        #expect(await reader.intakeNotice() == .failed)
    }

    @Test func noticeIsIndependentOfZeroOrFailedUnreadAndItsFailureDoesNotHideOtherReads() async throws {
        let w = try await world()
        #expect(w.model.intakeNotice == nil)
        await w.fake.insert("mail_intake_notices", [notice(Self.stamp)])
        await w.fake.setUnreadEmails(0)
        await w.model.load()
        #expect(w.model.unread == .loaded(0))
        #expect(w.model.intakeNotice == .loaded(Self.stamp))
        await w.fake.failAlways(where: { $0.url.lastPathComponent == "emails" && !$0.query("or").isEmpty }, with: .http(500))
        await w.model.load()
        #expect(w.model.unread == .failed)
        #expect(w.model.intakeNotice == .loaded(Self.stamp))

        let failed = try await world()
        await failed.fake.setUnreadEmails(3)
        await failed.fake.failAlways(where: { $0.url.lastPathComponent == "mail_intake_notices" }, with: .http(500))
        await failed.model.load()
        #expect(failed.model.intakeNotice == .failed)
        #expect(failed.model.unread == .loaded(3))
        #expect(failed.model.dropped == .loaded([]))
    }

    @Test func rememberedSenderAtRow1001IsNotLostAndEveryReadIsOwnerScoped() async throws {
        let w = try await world()
        await w.fake.insert("screen_events", (1...1_001).map { n in
            if n == 1_001 {
                var last = marked(n, "last.shop.test")
                last["created_at"] = "2026-10-01T00:00:00+00:00"
                return last
            }
            return SettingsRows.dropped(n)
        } + [SettingsRows.dropped(2_000, ["user_id": .string(FakeSupabase.other), "from_domain": "other.shop.test", "flagged_at": .string(Self.stamp)])])
        await w.model.load()
        let loadedRows = try #require(w.model.dropped?.value)
        #expect(loadedRows.count == 1_001)
        #expect(loadedRows.last?.fromDomain == "last.shop.test")
        #expect(w.model.rememberedSenders == .loaded(["last.shop.test"]))
        let requests = await w.fake.requests("GET", "screen_events")
        #expect(requests.count == 2)
        for request in requests { #expect(request.query("user_id") == ["eq.\(FakeSupabase.me)"]) }
    }

    @Test func rememberedSendersAreUniqueRawValuesAndSharedProvidersAreExcluded() async throws {
        let w = try await world()
        await w.fake.insert("screen_events", [
            marked(1, "shop.test"), marked(2, "shop.test"), marked(3, "mail.yahoo.co.jp"),
            marked(4, "gmail.com"), marked(5, "xxx.plala.or.jp"), marked(6, "Shop.Example.COM."),
            SettingsRows.dropped(7, ["from_domain": "unmarked.test"]),
        ])
        await w.model.load()
        #expect(w.model.rememberedSenders == .loaded(["Shop.Example.COM.", "mail.yahoo.co.jp", "shop.test"]))
        for domain in RememberedSenderRule.sharedMailDomains + RememberedSenderRule.sharedMailDomainSuffixes {
            #expect(!RememberedSenderRule.isRememberable(domain))
            #expect(!RememberedSenderRule.isRememberable(" \(domain.uppercased()). "))
        }
        #expect(RememberedSenderRule.isRememberable("mail.yahoo.co.jp"))
        #expect(!RememberedSenderRule.isRememberable("abc.ocn.ne.jp"))
    }

    @Test func aFailedSecondPageIsNotAnEmptyRememberedList() async throws {
        let w = try await world()
        await w.fake.insert("screen_events", (1...1_001).map { marked($0, "shop.test") })
        await w.fake.insert("mail_intake_notices", [notice(Self.stamp)])
        await w.fake.fail("GET", "screen_events", nth: 2, with: .http(500))
        await w.model.load()
        #expect(w.model.dropped == .failed)
        #expect(w.model.rememberedSenders == .failed)
        #expect(w.model.intakeNotice == .loaded(Self.stamp))
    }

    @Test func rawUTF16DistinctDomainsStaySeparateAndUseTheWebTrimRule() async throws {
        let w = try await world()
        let decomposed = "e\u{301}.shop.test"
        let composed = "\u{e9}.shop.test"
        await w.fake.insert("screen_events", [marked(1, decomposed), marked(2, composed)])
        await w.model.load()
        let domains = try #require(w.model.rememberedSenders?.value)
        #expect(domains.count == 2)
        #expect(domains.map { Array($0.utf16) } == [decomposed, composed].sorted(by: JSText.less).map { Array($0.utf16) })
        #expect(Set(domains.map { RememberedSenderRule.Entry(domain: $0).id }).count == 2)
        #expect(!RememberedSenderRule.isRememberable("\u{FEFF}gmail.com\u{FEFF}"))
        #expect(RememberedSenderRule.isRememberable("mail.yahoo.co.jp"))
    }

    @Test func delayedOldReadAndAChangedAccountCannotPublishTheOldNotice() async throws {
        let w = try await world()
        await w.fake.insert("mail_intake_notices", [notice(Self.stamp)])
        let gate = Gate()
        await w.fake.fail("GET", "mail_intake_notices", with: .delay(gate))
        let old = Task { await w.model.load() }
        for _ in 0..<200 {
            if !(await w.fake.requests("GET", "mail_intake_notices")).isEmpty { break }
            try? await Task.sleep(for: .milliseconds(10))
        }
        await w.fake.mutate { $0["mail_intake_notices"] = [notice(Self.newer)] }
        await w.model.load()
        #expect(w.model.intakeNotice == .loaded(Self.newer))
        gate.open()
        await old.value
        #expect(w.model.intakeNotice == .loaded(Self.newer))
        w.auth.session.update(userID: FakeSupabase.other)
        #expect(w.model.intakeNotice == nil)
        #expect(w.model.rememberedSenders == nil)
        await w.model.load()
        #expect(w.model.intakeNotice == nil)
        w.model.clearForSignOut()
        #expect(w.model.intakeNotice == nil)
    }

    // MARK: actual native client and action model, through URLProtocol

    @Test func confirmSendsTheRawMicrosecondsAndNeverClearsANewerNotice() async throws {
        let w = try await world()
        await w.fake.insert("mail_intake_notices", [notice(Self.stamp)])
        await w.model.load()
        let server = FakeSettingsMailServer.make(w.fake)
        let context = Context()
        let actions = actions(w, server: server, context: context)
        let gate = Gate()
        await server.hold(on: gate)
        let task = Task { await actions.dismissIntake(limitedAt: Self.stamp) }
        await waitForRequest(server)
        await w.fake.mutate { $0["mail_intake_notices"] = [notice(Self.newer)] }
        gate.open()
        await task.value
        let request = try #require(await server.requests().first)
        #expect(request.path == "/api/mail/dismiss-intake")
        #expect(request.method == "POST")
        #expect(request.header("cache-control") == "no-store")
        #expect(request.header("authorization")?.hasPrefix("Bearer ") == true)
        #expect(request.jsonDictionary as? [String: String] == ["limited_at": Self.stamp])
        #expect(context.reloads == 1)
        #expect(actions.intakeNote == nil)
        #expect(w.model.intakeNotice == .loaded(Self.newer))
    }

    @Test func forgetSendsTheDisplayedRawDomainAndReadsBackTheWholeList() async throws {
        let w = try await world()
        let domain = "Shop.Example.COM."
        await w.fake.insert("screen_events", [marked(1, domain), marked(2, domain), marked(3, "keep.shop.test")])
        await w.model.load()
        let server = FakeSettingsMailServer.make(w.fake)
        let context = Context()
        let actions = actions(w, server: server, context: context)
        await actions.forgetSender(domain: domain)
        let request = try #require(await server.requests().first)
        #expect(request.path == "/api/mail/forget-sender")
        #expect(request.jsonDictionary as? [String: String] == ["domain": domain])
        #expect(actions.senderNote == .init(text: RememberedSenderText.removed, isError: false))
        #expect(w.model.rememberedSenders == .loaded(["keep.shop.test"]))
        #expect(context.reloads == 1)
    }

    @Test func uncertainRepliesReadBackWithoutRetryOrSuccessNotes() async throws {
        let replies: [FakeSettingsMailServer.Answer] = [.transport(.timedOut), .transport(.cancelled), .integerOK, .html(200), .html(201), .html(204), .html(502), .applyThenLose(.networkConnectionLost)]
        for reply in replies {
            let w = try await world()
            await w.fake.insert("screen_events", [marked(1, "shop.test")])
            await w.fake.insert("mail_intake_notices", [notice(Self.stamp)])
            let server = FakeSettingsMailServer.make(w.fake)
            await server.force(reply)
            let context = Context()
            let actions = actions(w, server: server, context: context)
            await actions.forgetSender(domain: "shop.test")
            #expect(actions.senderNote == nil)
            #expect(context.reloads == 1)
            #expect(await server.requests().count == 1)
            await actions.dismissIntake(limitedAt: Self.stamp)
            #expect(actions.intakeNote == nil)
            #expect(context.reloads == 2)
            #expect(await server.requests().count == 2)
        }
    }

    @Test func everyDefiniteErrorIsNotCalledSuccess() async throws {
        for (status, code) in [(401, "unauthorized"), (400, "invalid_input"), (503, "unavailable"), (500, "forget_failed"), (500, "dismiss_failed")] {
            let w = try await world()
            let server = FakeSettingsMailServer.make(w.fake)
            await server.force(.failure(status, code))
            let context = Context()
            let actions = actions(w, server: server, context: context)
            await actions.forgetSender(domain: "shop.test")
            #expect(actions.senderNote?.isError == true)
            #expect(actions.senderNote?.text != RememberedSenderText.removed)
            #expect(context.reloads == 1)
        }
    }

    @Test func domainLengthUsesTheWebUTF16BoundaryAndNeverRewritesTheValue() async throws {
        let w = try await world()
        let server = FakeSettingsMailServer.make(w.fake)
        let client = SettingsMailActionsClient(baseURL: server.baseURL, session: server.urlSession)
        let token = try await w.provider.auth.session.accessToken
        let unicode = String(repeating: "あ", count: 200)
        #expect(unicode.utf16.count <= 255 && unicode.utf8.count > 255)
        for value in [unicode, String(repeating: "x", count: 255), " Shop.Example.TEST. ", " "] {
            try await client.forgetSender(domain: value, accessToken: token)
            let request = try #require(await server.requests().last)
            #expect(request.jsonDictionary as? [String: String] == ["domain": value])
        }
        let before = await server.requests().count
        for value in ["", String(repeating: "x", count: 256)] {
            do {
                try await client.forgetSender(domain: value, accessToken: token)
                Issue.record("an out-of-contract domain was sent")
            } catch {
                #expect(error == .invalidInput)
            }
        }
        #expect(await server.requests().count == before)
    }

    @Test func accountChangeWhileFetchingTheTokenSendsNothing() async throws {
        let w = try await world()
        let server = FakeSettingsMailServer.make(w.fake)
        let context = Context()
        let started = Gate(), release = Gate()
        let actions = SettingsMailRecoveryModel(
            api: SettingsMailActionsClient(baseURL: server.baseURL, session: server.urlSession),
            accessToken: { started.open(); await release.wait(); return try? await w.provider.auth.session.accessToken },
            isCurrent: { context.current }, reload: { context.reloads += 1 }
        )
        let task = Task { await actions.forgetSender(domain: "shop.test") }
        await started.wait()
        context.current = false
        release.open()
        await task.value
        #expect(await server.requests().isEmpty)
        #expect(context.reloads == 0)
        #expect(actions.senderNote == nil)
    }

    @Test func aLateWriteResponseCannotPublishOrReloadForAnotherAccount() async throws {
        let w = try await world()
        let server = FakeSettingsMailServer.make(w.fake)
        let context = Context()
        let actions = actions(w, server: server, context: context)
        let gate = Gate()
        await server.hold(on: gate)
        let task = Task { await actions.forgetSender(domain: "shop.test") }
        await waitForRequest(server)
        context.current = false
        gate.open()
        await task.value
        #expect(actions.senderNote == nil)
        #expect(context.reloads == 0)
        await actions.dismissIntake(limitedAt: Self.stamp)
        #expect(await server.requests().count == 1)
    }

    @Test func theLiveWiringRejectsAnAccountDifferentFromTheDisplayedOwner() async throws {
        let w = try await world()
        await w.fake.insert("mail_intake_notices", [notice(Self.stamp)])
        await w.model.load()
        let actions = w.model.mailRecovery
        let count = await w.fake.restRequests().count
        w.auth.session.update(userID: FakeSupabase.other)
        await actions.dismissIntake(limitedAt: Self.stamp)
        await actions.forgetSender(domain: "shop.test")
        #expect(actions.intakeNote == nil && actions.senderNote == nil)
        #expect(await w.fake.restRequests().count == count)
        #expect(w.model.intakeNotice == nil)
    }
}
