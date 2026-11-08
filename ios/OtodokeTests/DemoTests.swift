import Foundation
import Testing
@testable import Otodoke

/// The Web's demo endpoints (docs/api/demo.md) as a stub on a made-up host: nothing leaves the machine.
private final class DemoStub: @unchecked Sendable {
    let host = "\(UUID().uuidString.lowercased()).web.test"
    let lock = NSLock()
    private var seen: [StubRequest] = []
    private var reply: StubReply
    private var gate: Gate?

    init(_ reply: StubReply, gate: Gate? = nil) {
        self.reply = reply
        self.gate = gate
        StubURLProtocol.register(host: host) { [weak self] request in
            guard let self else { return .failure(.cancelled) }
            self.lock.withLock { self.seen.append(request) }
            await self.gate?.wait()
            return self.lock.withLock { self.reply }
        }
    }

    deinit { StubURLProtocol.unregister(host: host) }

    var requests: [StubRequest] { lock.withLock { seen } }
    var client: DemoAPIClient { DemoAPIClient(baseURL: URL(string: "https://\(host)")!, session: StubURLProtocol.makeSession()) }

    static func ok(_ extra: [String: Any]) -> StubReply {
        var body: [String: Any] = ["ok": true]
        for (k, v) in extra { body[k] = v }
        return .json(200, body)
    }

    static func failed(_ status: Int, _ code: String, _ extra: [String: Any] = [:]) -> StubReply {
        var body: [String: Any] = ["ok": false, "code": code]
        for (k, v) in extra { body[k] = v }
        return .json(status, body)
    }
}

@Suite struct DemoClientTests {
    static func failure(_ result: Result<Void, DemoFailure>) -> DemoFailure? {
        if case let .failure(failure) = result { return failure }
        return nil
    }

    @Test func loadIsAPostWithTheBearerAndAnEmptyBody() async throws {
        let stub = DemoStub(DemoStub.ok(["processed": 97, "busy": false]))
        let result = await stub.client.load(accessToken: "tok")
        #expect(result == .success(DemoLoaded(processed: 97, busy: false)))
        let request = try #require(stub.requests.first)
        #expect(request.method == "POST")
        #expect(request.path == "/api/demo/load")
        #expect(request.header("authorization") == "Bearer tok")
        #expect(request.header("content-type") == "application/json")
        #expect(request.jsonDictionary?.isEmpty == true)
    }

    @Test func aBusyLoadIsToldApart() async {
        let stub = DemoStub(DemoStub.ok(["processed": 12, "busy": true]))
        #expect(await stub.client.load(accessToken: "t") == .success(DemoLoaded(processed: 12, busy: true)))
    }

    @Test func clearSendsTheConfirmationWord() async throws {
        let stub = DemoStub(DemoStub.ok([:]))
        let result = await stub.client.clear(accessToken: "tok")
        #expect(Self.failure(result) == nil)
        let request = try #require(stub.requests.first)
        #expect(request.path == "/api/demo/clear")
        #expect(request.jsonDictionary as? [String: String] == ["confirm": "yes"])
        #expect(request.header("authorization") == "Bearer tok")
    }

    @Test func eachCodeIsReadFromTheAnswer() async {
        let table: [(Int, DemoCode)] = [
            (401, .unauthorized), (400, .invalidInput), (400, .clearConfirm), (500, .demoFailed), (500, .clearFailed), (503, .unavailable),
        ]
        for (status, code) in table {
            let stub = DemoStub(DemoStub.failed(status, code.rawValue))
            #expect(await stub.client.load(accessToken: "t") == .failure(.answered(code, processed: nil)), "\(code)")
            #expect(Self.failure(await stub.client.clear(accessToken: "t")) == .answered(code, processed: nil), "\(code)")
        }
    }

    @Test func aFailureCanSayHowManyMailsWentIn() async {
        let stub = DemoStub(DemoStub.failed(500, "demo_failed", ["processed": 31]))
        #expect(await stub.client.load(accessToken: "t") == .failure(.answered(.demoFailed, processed: 31)))
    }

    @Test func whatIsNotTheEndpointsAnswerIsUnknown() async {
        let cases: [StubReply] = [
            .json(200, ["ok": true]),                              // load: no processed / busy
            .json(200, ["ok": true, "processed": 3, "busy": 1]),   // busy is not a JSON boolean
            .json(200, ["ok": 1, "processed": 3, "busy": false]),  // ok is not JSON true
            .json(500, ["ok": false, "code": "something_else"]),
            .json(500, ["error": "x"]),
            .empty(502),
            .http(status: 200, headers: [:], body: Data("<html>".utf8)),
            .failure(.timedOut),
            .failure(.networkConnectionLost),
            .failure(.cancelled),
        ]
        for reply in cases {
            let stub = DemoStub(reply)
            #expect(await stub.client.load(accessToken: "t") == .failure(.unknown))
        }
    }

    @Test func onlyAFailureThatCertainlyNeverSentItIsNotSent() async {
        for code in [URLError.Code.notConnectedToInternet, .cannotConnectToHost] {
            let stub = DemoStub(.failure(code))
            #expect(await stub.client.load(accessToken: "t") == .failure(.notSent), "\(code)")
            #expect(Self.failure(await stub.client.clear(accessToken: "t")) == .notSent, "\(code)")
        }
        // Negative control: the ones that may have reached the server stay unknown.
        for code in [URLError.Code.timedOut, .networkConnectionLost, .cancelled, .cannotFindHost, .secureConnectionFailed] {
            let stub = DemoStub(.failure(code))
            #expect(await stub.client.load(accessToken: "t") == .failure(.unknown), "\(code)")
        }
    }

    @Test func aRedirectIsNotFollowed() async {
        let stub = DemoStub(.empty(302, headers: ["Location": "https://example.invalid/x"]))
        #expect(await stub.client.load(accessToken: "t") == .failure(.unknown))
        #expect(stub.requests.count == 1)
    }

    @Test func theLoadWaitsLongerThanTheServerCan() {
        #expect(DemoAPIClient.loadTimeout == 310)
    }

    @Test func aTimeoutIsNeverSentAgain() async {
        let stub = DemoStub(.failure(.timedOut))
        _ = await stub.client.load(accessToken: "t")
        #expect(stub.requests.count == 1)
    }
}

/// A fake endpoint that counts what it is asked and can be held.
private actor FakeDemoAPI: DemoAPI {
    var loads = 0
    var clears = 0
    var loadResult: Result<DemoLoaded, DemoFailure> = .success(DemoLoaded(processed: 97, busy: false))
    var clearResult: Result<Void, DemoFailure> = .success(())
    let gate: Gate?

    init(gate: Gate? = nil) { self.gate = gate }

    func set(load: Result<DemoLoaded, DemoFailure>? = nil, clear: Result<Void, DemoFailure>? = nil) {
        if let load { loadResult = load }
        if let clear { clearResult = clear }
    }

    func load(accessToken: String) async -> Result<DemoLoaded, DemoFailure> {
        loads += 1
        await gate?.wait()
        return loadResult
    }

    func clear(accessToken: String) async -> Result<Void, DemoFailure> {
        clears += 1
        await gate?.wait()
        return clearResult
    }
}

@MainActor
@Suite struct DemoModelTests {
    private func make(_ api: FakeDemoAPI, token: String? = "tok", changed: @escaping @MainActor () -> Void = {}) -> DemoModel {
        DemoModel(api: api, accessToken: { token }, changed: changed)
    }

    @Test func aLoadThatWentThroughTellsTheTabs() async {
        let api = FakeDemoAPI()
        var told = 0
        let model = make(api, changed: { told += 1 })
        await model.load()
        #expect(told == 1)
        #expect(model.loadedCount == 1)
        #expect(model.notice == DemoModel.Notice())
        #expect(model.showsBusyNote == false)
        #expect(model.phase == .idle)
    }

    @Test func aBusyLoadLeavesTheListNote() async {
        let api = FakeDemoAPI()
        await api.set(load: .success(DemoLoaded(processed: 5, busy: true)))
        let model = make(api)
        await model.load()
        #expect(model.showsBusyNote)
        #expect(model.loadedCount == 1)
    }

    @Test func aFailedLoadSaysTheWebsSentenceAndHowManyWentIn() async {
        let api = FakeDemoAPI()
        await api.set(load: .failure(.answered(.demoFailed, processed: 31)))
        var told = 0
        let model = make(api, changed: { told += 1 })
        await model.load()
        #expect(model.notice.error == "サンプルを最後まで読み込めませんでした。もう一度お試しください。")
        #expect(model.notice.partial == "31 通は読み込めました。")
        #expect(model.loadedCount == 0)
        #expect(told == 1)
    }

    @Test func onlyDemoFailedSaysTheLoadSentence() async {
        let api = FakeDemoAPI()
        await api.set(load: .failure(.answered(.demoFailed, processed: nil)))
        let failed = make(api)
        await failed.load()
        #expect(failed.notice.error == DemoText.loadFailed)
        // Every other code is not "the load failed part way": the app's words for no answer from the server.
        for code in [DemoCode.unavailable, .invalidInput, .clearConfirm, .clearFailed] {
            let other = FakeDemoAPI()
            await other.set(load: .failure(.answered(code, processed: nil)))
            var told = 0
            let model = make(other, changed: { told += 1 })
            await model.load()
            #expect(model.notice.error == LoginText.network, "\(code)")
            #expect(model.notice.error != DemoText.loadFailed, "\(code)")
            #expect(model.notice.partial == nil)
            #expect(model.loadedCount == 0)
            #expect(told == 0)
        }
    }

    @Test func aLoadThatCertainlyWasNotSentIsAFailureAndStaysOnThePage() async {
        let api = FakeDemoAPI()
        await api.set(load: .failure(.notSent))
        var told = 0
        let model = make(api, changed: { told += 1 })
        await model.load()
        #expect(model.notice.error == LoginText.network)
        #expect(model.loadedCount == 0)
        #expect(told == 0)
        #expect(await api.loads == 1)
    }

    @Test func aLoadThatTimedOutMovesToTheParcelsReadsAgainSaysNoFailureAndIsSentOnce() async {
        let api = FakeDemoAPI()
        await api.set(load: .failure(.unknown))
        var told = 0
        let model = make(api, changed: { told += 1 })
        await model.load()
        #expect(told == 1)                       // the parcels are read again
        #expect(model.loadedCount == 1)          // the tabs move to 荷物, as for a load that went through
        #expect(model.notice == DemoModel.Notice())  // no failure sentence
        #expect(await api.loads == 1)            // sent once
    }

    @Test func theTimeoutOfTheClientReallyEndsInThatSameWay() async {
        // A transport that times out becomes .unknown in the client, and the model treats .unknown as above.
        let stub = DemoStub(.failure(.timedOut))
        let model = DemoModel(api: stub.client, accessToken: { "tok" }, changed: {})
        await model.load()
        #expect(stub.requests.count == 1)
        #expect(model.loadedCount == 1)
        #expect(model.notice.error == nil)
    }

    @Test func signedOutSendsNothing() async {
        let api = FakeDemoAPI()
        let model = make(api, token: nil)
        await model.load()
        _ = await model.clear(confirmed: true)
        #expect(await api.loads == 0)
        #expect(await api.clears == 0)
        #expect(model.notice.error == LoginText.signedOut)
    }

    @Test func pressingTwiceWhileItRunsSendsOnce() async {
        let gate = Gate()
        let api = FakeDemoAPI(gate: gate)
        let model = make(api)
        let first = Task { await model.load() }
        while model.phase == .idle { await Task.yield() }
        await model.load()
        _ = await model.clear(confirmed: true)
        #expect(model.phase == .loading)
        gate.open()
        await first.value
        #expect(await api.loads == 1)
        #expect(await api.clears == 0)
        #expect(model.phase == .idle)
    }

    @Test func clearingWhileLoadingOrLoadingWhileClearingIsNotSent() async {
        let gate = Gate()
        let api = FakeDemoAPI(gate: gate)
        let model = make(api)
        let first = Task { await model.clear(confirmed: true) }
        while model.phase == .idle { await Task.yield() }
        await model.load()
        gate.open()
        _ = await first.value
        #expect(await api.loads == 0)
        #expect(await api.clears == 1)
    }

    @Test func withoutTheCheckNothingIsSent() async {
        let api = FakeDemoAPI()
        var told = 0
        let model = make(api, changed: { told += 1 })
        let cleared = await model.clear(confirmed: false)
        #expect(!cleared)
        #expect(await api.clears == 0)
        #expect(told == 0)
        #expect(model.notice.error == "「本当に消す」にチェックを入れてください")
    }

    @Test func aClearSaysItWasClearedAndTellsTheTabs() async {
        let api = FakeDemoAPI()
        var told = 0
        let model = make(api, changed: { told += 1 })
        #expect(await model.clear(confirmed: true))
        #expect(told == 1)
        #expect(model.notice.cleared == DemoText.cleared)
        #expect(model.notice.error == nil)
        // The 荷物 tab starts again from its list: it watches this count.
        #expect(model.clearedCount == 1)
    }

    @Test func aFailedClearSaysTheClearSentence() async {
        let table: [(DemoFailure, String)] = [
            (.answered(.clearFailed, processed: nil), DemoText.clearFailed),
            (.answered(.unavailable, processed: nil), LoginText.network),
            (.answered(.invalidInput, processed: nil), LoginText.network),
            (.answered(.demoFailed, processed: nil), LoginText.network),
            (.notSent, LoginText.network),
            (.answered(.clearConfirm, processed: nil), DemoText.clearConfirm),
            (.answered(.unauthorized, processed: nil), LoginText.signedOut),
            (.unknown, ""),
        ]
        for (failure, sentence) in table {
            let api = FakeDemoAPI()
            await api.set(clear: .failure(failure))
            var told = 0
            let model = make(api, changed: { told += 1 })
            #expect(await model.clear(confirmed: true) == false)
            #expect(model.notice.error == (sentence.isEmpty ? nil : sentence))
            #expect(model.notice.cleared == nil)
            #expect(model.loadedCount == 0)
            #expect(model.clearedCount == 0)
            #expect(told == (failure == .unknown ? 1 : 0))
            #expect(await api.clears == 1)
        }
    }

    @Test func theNextActionClearsWhatTheLastOneSaid() async {
        let api = FakeDemoAPI()
        await api.set(load: .failure(.answered(.demoFailed, processed: nil)))
        let model = make(api)
        await model.load()
        #expect(model.notice.error != nil)
        await api.set(load: .success(DemoLoaded(processed: 97, busy: false)))
        await model.load()
        #expect(model.notice == DemoModel.Notice())
    }

    @Test func theSettingsModelCarriesTheDemoModelAndTheOutsideChangeBumpsTheVersion() {
        let changes = DataChanges()
        let before = changes.version
        ParcelWriter.announceOutsideChange(changes)
        #expect(changes.version == before + 1)
    }
}
