import Foundation
import PostgREST
import Testing
@testable import Otodoke

private actor FakeAIReadingConsentStore: AIReadingConsentStoring {
    struct Step: Sendable {
        let result: LoadResult<AIReadingDecision>
        var gate: Gate? = nil
    }

    private var stored: [String: AIReadingDecision] = [:]
    private var reads: [Step] = []
    private var saves: [Step] = []
    private(set) var readStamps: [SessionStamp] = []
    private(set) var saveCalls: [(allowed: Bool, stamp: SessionStamp)] = []

    func set(_ decision: AIReadingDecision, userID: String) { stored[userID] = decision }
    func enqueueRead(_ result: LoadResult<AIReadingDecision>, gate: Gate? = nil) { reads.append(Step(result: result, gate: gate)) }
    func enqueueSave(_ result: LoadResult<AIReadingDecision>, gate: Gate? = nil) { saves.append(Step(result: result, gate: gate)) }

    func load(for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> {
        readStamps.append(stamp)
        let step = reads.isEmpty ? Step(result: .loaded(stored[stamp.userID] ?? .notDetermined)) : reads.removeFirst()
        await step.gate?.wait()
        return step.result
    }

    func save(_ allowed: Bool, for stamp: SessionStamp) async -> LoadResult<AIReadingConsentSaveReceipt> {
        saveCalls.append((allowed, stamp))
        let step = saves.isEmpty ? Step(result: .loaded(allowed ? .allowed : .denied)) : saves.removeFirst()
        await step.gate?.wait()
        guard case let .loaded(value) = step.result else { return .failed }
        stored[stamp.userID] = value
        return .loaded(AIReadingConsentSaveReceipt(decision: value, decidedAt: "2026-11-12T03:00:00.123456+00:00", stamp: stamp))
    }
}

@Suite("AI reading consent state")
@MainActor
struct AIReadingConsentTests {
    private func session(_ userID: String = FakeSupabase.me) -> SessionGeneration {
        let session = SessionGeneration()
        session.follow(userID: userID)
        return session
    }

    private func model(_ store: any AIReadingConsentStoring, session: SessionGeneration) -> AIReadingConsentModel {
        AIReadingConsentModel(store: store, session: session, loadFailureMessage: "read failed", saveFailureMessage: "save failed")
    }

    @Test func startsUnknownAndOnlyARealUnselectedAnswerPrompts() async {
        let store = FakeAIReadingConsentStore()
        let model = model(store, session: session())
        #expect(model.decision == nil)
        #expect(!model.needsPrompt)
        #expect(!model.mayShowAddress)
        await model.load()
        #expect(model.decision == .notDetermined)
        #expect(model.needsPrompt)
        #expect(!model.mayShowAddress)
        #expect(model.message == nil)
    }

    @Test func theInitialChoiceGuardBlocksUnknownWithoutPretendingItIsAnUnselectedAnswer() async {
        let store = FakeAIReadingConsentStore()
        let model = model(store, session: session())
        #expect(model.requiresInitialChoice)
        #expect(model.decision == nil)
        #expect(!model.needsPrompt)
        await store.enqueueRead(.failed)
        await model.load()
        #expect(model.requiresInitialChoice)
        #expect(model.decision == nil)
        #expect(!model.needsPrompt)
        #expect(model.message == "read failed")
        await model.load()
        #expect(model.requiresInitialChoice)
        #expect(model.needsPrompt)
        #expect(model.decision == .notDetermined)
        model.retire()
        #expect(!model.requiresInitialChoice)
    }

    @Test(arguments: [AIReadingDecision.allowed, .denied])
    func anAnsweredAccountDoesNotAskAgainDuringRefreshOrAfterRestart(_ decision: AIReadingDecision) async {
        let store = FakeAIReadingConsentStore()
        let session = session()
        await store.set(decision, userID: FakeSupabase.me)
        let first = model(store, session: session)
        await first.load()
        #expect(!first.requiresInitialChoice)
        let gate = Gate()
        await store.enqueueRead(.failed, gate: gate)
        let refresh = Task { await first.load() }
        #expect(await waitFor { await first.isLoading })
        #expect(!first.requiresInitialChoice)
        #expect(!first.needsPrompt)
        gate.open()
        await refresh.value
        #expect(!first.requiresInitialChoice)
        #expect(first.decision == decision)
        first.retire()
        let restarted = model(store, session: session)
        await restarted.load()
        #expect(!restarted.requiresInitialChoice)
        #expect(restarted.decision == decision)
    }

    @Test func anOfflineReadIsNeitherAnUnselectedNorARefusedChoiceAndCanBeRetried() async {
        let store = FakeAIReadingConsentStore()
        await store.enqueueRead(.failed)
        let model = model(store, session: session())
        await model.load()
        #expect(model.decision == nil)
        #expect(!model.needsPrompt)
        #expect(!model.mayShowAddress)
        #expect(model.message == "read failed")
        #expect(!model.isLoading)
        await model.load()
        #expect(model.decision == .notDetermined)
        #expect(model.needsPrompt)
        #expect(model.requiresInitialChoice)
        #expect(model.message == nil)
    }

    @Test func anExplicitRefusalPersistsAcrossANewModelAndCanBeChangedInSettings() async {
        let store = FakeAIReadingConsentStore()
        let session = session()
        let first = model(store, session: session)
        await first.load()
        #expect(await first.choose(false))
        #expect(first.decision == .denied)
        #expect(!first.needsPrompt)
        #expect(!first.mayShowAddress)
        first.retire()
        let restarted = model(store, session: session)
        await restarted.load()
        #expect(restarted.decision == .denied)
        #expect(!restarted.needsPrompt)
        #expect(!restarted.mayShowAddress)
        #expect(await restarted.choose(true))
        #expect(restarted.decision == .allowed)
        #expect(restarted.mayShowAddress)
    }

    @Test func anAddressAppearsOnlyAfterTheServerConfirmsAnAllowChoice() async {
        let store = FakeAIReadingConsentStore()
        let gate = Gate()
        await store.enqueueSave(.loaded(.allowed), gate: gate)
        let model = model(store, session: session())
        await model.load()
        let choosing = Task { await model.choose(true) }
        #expect(await waitFor { await store.saveCalls.count == 1 })
        #expect(model.isSaving)
        #expect(model.needsPrompt)
        #expect(!model.mayShowAddress)
        gate.open()
        #expect(await choosing.value)
        #expect(model.decision == .allowed)
        #expect(!model.needsPrompt)
        #expect(model.mayShowAddress)
    }

    @Test func failedSavesDoNotCloseTheFirstChoiceAndAnExplicitRetryCanSucceed() async {
        let store = FakeAIReadingConsentStore()
        await store.enqueueSave(.failed)
        let model = model(store, session: session())
        await model.load()
        #expect(!(await model.choose(true)))
        #expect(model.decision == .notDetermined)
        #expect(model.needsPrompt)
        #expect(!model.mayShowAddress)
        #expect(model.message == "save failed")
        #expect(!model.isSaving)
        #expect(await model.choose(true))
        #expect(model.decision == .allowed)
        #expect(model.mayShowAddress)
        #expect(model.message == nil)
        #expect(await store.saveCalls.count == 2)
    }

    @Test func aFailedWithdrawalNeverKeepsAddressPermissionFromTheOldAllowedValue() async {
        let store = FakeAIReadingConsentStore()
        await store.set(.allowed, userID: FakeSupabase.me)
        let gate = Gate()
        await store.enqueueSave(.failed, gate: gate)
        let model = model(store, session: session())
        var permissions: [Bool] = []
        model.onAddressPermissionChange = { permissions.append($0) }
        await model.load()
        #expect(model.mayShowAddress)
        let withdrawing = Task { await model.choose(false) }
        #expect(await waitFor { await store.saveCalls.count == 1 })
        #expect(model.isSaving)
        #expect(!model.mayShowAddress)
        #expect(permissions.last == false)
        gate.open()
        #expect(!(await withdrawing.value))
        #expect(model.decision == .allowed)
        #expect(model.message == "save failed")
        #expect(!model.mayShowAddress)
        #expect(await model.choose(false))
        #expect(model.decision == .denied)
        #expect(!model.mayShowAddress)
    }

    @Test func anAllowedRefreshFailureKeepsHistoryButHidesTheAddressUntilConfirmedAgain() async {
        let store = FakeAIReadingConsentStore()
        await store.set(.allowed, userID: FakeSupabase.me)
        let model = model(store, session: session())
        await model.load()
        #expect(model.mayShowAddress)
        await store.enqueueRead(.failed)
        await model.load()
        #expect(model.decision == .allowed)
        #expect(model.message == "read failed")
        #expect(!model.mayShowAddress)
        await model.load()
        #expect(model.mayShowAddress)
    }

    @Test func theNewestLoadWinsAndALateAllowedLoadCannotResurrectAWithdrawal() async {
        let store = FakeAIReadingConsentStore()
        let gate = Gate()
        await store.enqueueRead(.loaded(.allowed), gate: gate)
        let model = model(store, session: session())
        let oldRead = Task { await model.load() }
        #expect(await waitFor { await store.readStamps.count == 1 })
        #expect(model.isLoading)
        #expect(await model.choose(false))
        #expect(model.decision == .denied)
        gate.open()
        await oldRead.value
        #expect(model.decision == .denied)
        #expect(!model.needsPrompt)
        #expect(!model.mayShowAddress)
        #expect(!model.isLoading)
    }

    @Test func anOlderLoadCannotReplaceANewerReadOrItsLoadingState() async {
        let store = FakeAIReadingConsentStore()
        let firstGate = Gate()
        let secondGate = Gate()
        await store.enqueueRead(.loaded(.allowed), gate: firstGate)
        await store.enqueueRead(.loaded(.denied), gate: secondGate)
        let model = model(store, session: session())
        let first = Task { await model.load() }
        #expect(await waitFor { await store.readStamps.count == 1 })
        let second = Task { await model.load() }
        #expect(await waitFor { await store.readStamps.count == 2 })
        firstGate.open()
        await first.value
        #expect(model.isLoading)
        #expect(model.decision == nil)
        #expect(!model.mayShowAddress)
        secondGate.open()
        await second.value
        #expect(!model.isLoading)
        #expect(model.decision == .denied)
    }

    @Test func onlyOneSaveIsSentAndALoadCannotStartInsideIt() async {
        let store = FakeAIReadingConsentStore()
        let gate = Gate()
        await store.enqueueSave(.loaded(.denied), gate: gate)
        let model = model(store, session: session())
        let first = Task { await model.choose(false) }
        #expect(await waitFor { await store.saveCalls.count == 1 })
        #expect(model.isSaving)
        #expect(!(await model.choose(true)))
        await model.load()
        #expect(await store.saveCalls.count == 1)
        #expect(await store.readStamps.isEmpty)
        #expect(!model.mayShowAddress)
        gate.open()
        #expect(await first.value)
        #expect(model.decision == .denied)
    }

    @Test(arguments: [true, false])
    func retireDropsLateLoadAndSaveResults(save: Bool) async {
        let store = FakeAIReadingConsentStore()
        let gate = Gate()
        if save { await store.enqueueSave(.loaded(.allowed), gate: gate) }
        else { await store.enqueueRead(.loaded(.allowed), gate: gate) }
        let model = model(store, session: session())
        let pending = Task { if save { _ = await model.choose(true) } else { await model.load() } }
        #expect(await waitFor { save ? await store.saveCalls.count == 1 : await store.readStamps.count == 1 })
        model.retire()
        gate.open()
        await pending.value
        #expect(model.decision == nil)
        #expect(!model.isLoading)
        #expect(!model.isSaving)
        #expect(!model.needsPrompt)
        #expect(!model.mayShowAddress)
        #expect(model.message == nil)
    }

    @Test(arguments: [true, false])
    func changedUserOrSameUsersNewSessionCannotInheritAPendingChoice(changeUser: Bool) async {
        let store = FakeAIReadingConsentStore()
        let gate = Gate()
        await store.enqueueSave(.loaded(.allowed), gate: gate)
        let session = session()
        let model = model(store, session: session)
        let saving = Task { await model.choose(true) }
        #expect(await waitFor { await store.saveCalls.count == 1 })
        if changeUser { session.follow(userID: FakeSupabase.other) }
        else { session.advance() }
        gate.open()
        #expect(!(await saving.value))
        #expect(model.decision == nil)
        #expect(!model.mayShowAddress)
        #expect(!model.isSaving)
    }

    @Test func anUnexpectedSaveAnswerIsAFailureRatherThanAnImplicitGrant() async {
        let store = FakeAIReadingConsentStore()
        await store.enqueueSave(.loaded(.allowed))
        let model = model(store, session: session())
        #expect(!(await model.choose(false)))
        #expect(model.decision == nil)
        #expect(model.message == "save failed")
        #expect(!model.mayShowAddress)
    }
}

private actor AIConsentWireServer {
    nonisolated let host = "\(UUID().uuidString.lowercased()).supabase.test"
    nonisolated let urlSession = StubURLProtocol.makeSession()
    private(set) var requests: [StubRequest] = []
    private var reply: StubReply?
    private var gate: Gate?

    static func make() -> AIConsentWireServer {
        let server = AIConsentWireServer()
        StubURLProtocol.register(host: server.host) { [weak server] request in
            guard let server else { return .failure(.cancelled) }
            return await server.handle(request)
        }
        return server
    }

    deinit { StubURLProtocol.unregister(host: host) }

    nonisolated func database() -> PostgrestClient {
        PostgrestClient(configuration: PostgrestClient.Configuration(
            url: URL(string: "https://\(host)/rest/v1")!,
            headers: ["apikey": "test-anon-key", "Authorization": "Bearer consent-test-token"],
            fetch: { request in try await self.urlSession.data(for: request) },
            retryEnabled: false
        ))
    }

    func force(_ reply: StubReply) { self.reply = reply }
    func hold(on gate: Gate) { self.gate = gate }

    private func handle(_ request: StubRequest) async -> StubReply {
        requests.append(request)
        await gate?.wait()
        guard request.header("authorization") == "Bearer consent-test-token",
              request.header("apikey") == "test-anon-key" else { return .json(401, ["code": "PGRST301", "message": "unauthorized"]) }
        if let reply { return reply }
        guard request.path == "/rest/v1/rpc/set_ai_reading", request.method == "POST",
              let body = request.jsonDictionary,
              Set(body.keys) == ["p_decision", "p_text_version"],
              let decision = body["p_decision"] as? String, ["granted", "declined"].contains(decision),
              body["p_text_version"] as? String == "v1" else { return .json(400, ["code": "22023", "message": "invalid input"]) }
        return .json(200, [["decision": decision, "decided_at": "2026-11-12T03:00:00.123456+00:00"]])
    }
}

@Suite("AI reading consent PostgREST contract")
@MainActor
struct AIReadingConsentClientTests {
    @Test(arguments: [true, false])
    func liveReadUsesThePersonsJWTAndTheExactColumnsWithoutInvalidatingAnOlderTextVersion(allowed: Bool) async throws {
        let fake = FakeSupabase.make()
        await fake.insert("ai_reading_consents", [["user_id": .string(FakeSupabase.me), "decision": .string(allowed ? "granted" : "declined"), "decided_at": "2026-11-12T03:00:00.123456+00:00", "text_version": "previous-text"]])
        let (provider, auth) = try await TestSession.signedIn(fake)
        let stamp = try #require(auth.session.stamp())
        let client = AIReadingConsentClient(provider: provider, isCurrent: { auth.session.isCurrent($0) })
        #expect(await client.load(for: stamp) == .loaded(allowed ? .allowed : .denied))
        let request = try #require(await fake.requests("GET", "ai_reading_consents").first)
        #expect(request.query("user_id") == ["eq.\(FakeSupabase.me)"])
        let columns = (request.query("select").first ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        #expect(Set(columns) == ["decision", "decided_at", "text_version"])
        #expect(request.header("authorization")?.hasPrefix("Bearer ") == true)
        #expect(request.header("authorization") != "Bearer \(FakeSupabase.anonKey)")
    }

    @Test func zeroRowsAndAFailedReadAreDifferentAndNeitherWritesAnything() async throws {
        let fake = FakeSupabase.make()
        let (provider, auth) = try await TestSession.signedIn(fake)
        let stamp = try #require(auth.session.stamp())
        let client = AIReadingConsentClient(provider: provider, isCurrent: { auth.session.isCurrent($0) })
        #expect(await client.load(for: stamp) == .loaded(.notDetermined))
        await fake.fail("GET", "ai_reading_consents", nth: 2, with: .http(500))
        #expect(await client.load(for: stamp) == .failed)
        #expect(await fake.requests("POST", "set_ai_reading").isEmpty)
    }

    @Test func anotherAccountsStampCannotUseTheProvidersCurrentJWT() async throws {
        let fake = FakeSupabase.make()
        let (provider, _) = try await TestSession.signedIn(fake)
        let other = SessionStamp(userID: FakeSupabase.other, generation: 1)
        let client = AIReadingConsentClient(provider: provider, isCurrent: { _ in true })
        #expect(await client.load(for: other) == .failed)
        #expect(await client.save(true, for: other) == .failed)
        #expect(await fake.restRequests().isEmpty)
    }

    @Test(arguments: [true, false])
    func savesTheExactRPCDecisionAndVersionAndWaitsForTheServersTimestamp(allowed: Bool) async throws {
        let server = AIConsentWireServer.make()
        let stamp = SessionStamp(userID: FakeSupabase.me, generation: 1)
        let client = AIReadingConsentClient(database: server.database(), isCurrent: { $0 == stamp })
        #expect(await client.save(allowed, for: stamp) == .loaded(AIReadingConsentSaveReceipt(decision: allowed ? .allowed : .denied, decidedAt: "2026-11-12T03:00:00.123456+00:00", stamp: stamp)))
        let requests = await server.requests
        #expect(requests.count == 1)
        let request = try #require(requests.first)
        #expect(request.path == "/rest/v1/rpc/set_ai_reading")
        #expect(request.method == "POST")
        let body = try #require(request.jsonDictionary)
        #expect(Set(body.keys) == ["p_decision", "p_text_version"])
        #expect(body["p_decision"] as? String == (allowed ? "granted" : "declined"))
        #expect(body["p_text_version"] as? String == AIReadingConsentContract.textVersion)
        #expect(AIReadingConsentContract.textVersion == "v1")
    }

    @Test(arguments: [
        "2026-11-12T03:00:00.123456+00:00",
        "2026-11-12T12:00:00.000001+09:00",
        "2026-11-11T22:30:00.999999-04:30",
        "2026-11-12T03:00:00Z",
    ])
    func theConfirmedReceiptKeepsTheExactServerTimestampAndSessionOwnerThroughTheAutomaticRead(decidedAt: String) async throws {
        let server = AIConsentWireServer.make()
        await server.force(.json(200, [["decision": "granted", "decided_at": decidedAt]]))
        let stamp = SessionStamp(userID: FakeSupabase.me, generation: 17)
        let client = AIReadingConsentClient(database: server.database(), isCurrent: { $0 == stamp })
        let saved = try #require(await client.save(true, for: stamp).value)
        #expect(saved.decision == .allowed)
        #expect(saved.decidedAt == decidedAt)
        #expect(Array(saved.decidedAt.utf8) == Array(decidedAt.utf8))
        #expect(saved.stamp == stamp)

        let fake = FakeSupabase.make()
        let mailServer = FakeMailServer.make(supabase: fake)
        await mailServer.force("read-waiting", .answer(status: 200, ok: true, code: nil, extra: ["stopped": false, "over_limit": false]))
        let mail = MailActionsClient(baseURL: mailServer.baseURL, session: mailServer.urlSession)
        _ = try await mail.readWaiting(afterConsent: saved, accessToken: "receipt-owner-test-token")
        let request = try #require(await mailServer.requests("read-waiting").first)
        #expect(request.jsonDictionary as? [String: String] == ["after_consent": decidedAt])
        #expect(request.header("authorization") == "Bearer receipt-owner-test-token")
        #expect(await mailServer.count("read-waiting") == 1)
    }

    @Test func anRPCResponseFromAnOldSessionIsNotPublishedAsASavedChoice() async throws {
        let server = AIConsentWireServer.make()
        let gate = Gate()
        await server.hold(on: gate)
        let session = SessionGeneration()
        session.follow(userID: FakeSupabase.me)
        let stamp = try #require(session.stamp())
        let client = AIReadingConsentClient(database: server.database(), isCurrent: { session.isCurrent($0) })
        let saving = Task { await client.save(true, for: stamp) }
        #expect(await waitFor { await server.requests.count == 1 })
        session.advance()
        gate.open()
        #expect(await saving.value == .failed)
        #expect(await server.requests.count == 1)
    }

    @Test(arguments: ["unknownDecision", "missingTime", "invalidTime", "many"])
    func malformedConsentRowsAreUnknownRatherThanAbsentOrAllowed(answer: String) async {
        let server = AIConsentWireServer.make()
        let good = ["decision": "granted", "decided_at": "2026-11-12T03:00:00Z", "text_version": "v1"]
        let rows: [[String: String]]
        switch answer {
        case "unknownDecision": rows = [["decision": "allowed", "decided_at": "2026-11-12T03:00:00Z", "text_version": "v1"]]
        case "missingTime": rows = [["decision": "granted", "text_version": "v1"]]
        case "invalidTime": rows = [["decision": "granted", "decided_at": "infinity", "text_version": "v1"]]
        default: rows = [good, good]
        }
        await server.force(.json(200, rows))
        let stamp = SessionStamp(userID: FakeSupabase.me, generation: 1)
        let client = AIReadingConsentClient(database: server.database(), isCurrent: { $0 == stamp })
        #expect(await client.load(for: stamp) == .failed)
        #expect(await server.requests.count == 1)
    }

    @Test(arguments: ["empty", "many", "wrongDecision", "missingTime", "emptyTime", "invalidTime", "infinity", "object", "network", "server"])
    func anUnconfirmedSaveIsAFailureAndIsNeverRetried(answer: String) async {
        let server = AIConsentWireServer.make()
        let good = ["decision": "granted", "decided_at": "2026-11-12T03:00:00Z"]
        let reply: StubReply
        switch answer {
        case "empty": reply = .json(200, [[String: String]]())
        case "many": reply = .json(200, [good, good])
        case "wrongDecision": reply = .json(200, [["decision": "declined", "decided_at": "2026-11-12T03:00:00Z"]])
        case "missingTime": reply = .json(200, [["decision": "granted"]])
        case "emptyTime": reply = .json(200, [["decision": "granted", "decided_at": ""]])
        case "invalidTime": reply = .json(200, [["decision": "granted", "decided_at": "not a date"]])
        case "infinity": reply = .json(200, [["decision": "granted", "decided_at": "infinity"]])
        case "object": reply = .json(200, good)
        case "network": reply = .failure(.networkConnectionLost)
        default: reply = .json(500, ["code": "XX000", "message": "server error"])
        }
        await server.force(reply)
        let stamp = SessionStamp(userID: FakeSupabase.me, generation: 1)
        let client = AIReadingConsentClient(database: server.database(), isCurrent: { $0 == stamp })
        #expect(await client.save(true, for: stamp) == .failed)
        #expect(await server.requests.count == 1)
    }
}
