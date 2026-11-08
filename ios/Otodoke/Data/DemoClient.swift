// The sample load and "clear everything" of the 「サンプルで試す」 page, through the Web's HTTP endpoints
// (docs/api/demo.md): POST /api/demo/load {} and POST /api/demo/clear {"confirm":"yes"}, JSON, no-store,
// `Authorization: Bearer <access token>`. Built like the key endpoints' client (KeyAPIClient): the same URL
// building, headers, no redirect followed, `ok` read as JSON true only, the result code read from `{ ok: false, code }`.
// A request is never sent again here: when the answer is not known the caller reads the data again.

import Foundation

/// A load that went through.
struct DemoLoaded: Equatable, Sendable {
    /// How many sample mails were taken in.
    let processed: Int
    /// Another load is running: it finishes the sample.
    let busy: Bool
}

/// The result codes of docs/api/demo.md.
enum DemoCode: String, Equatable, Sendable, CaseIterable {
    case unauthorized
    case invalidInput = "invalid_input"
    case clearConfirm = "clear_confirm"
    case demoFailed = "demo_failed"
    case clearFailed = "clear_failed"
    case unavailable
}

enum DemoFailure: Error, Equatable, Sendable {
    /// The endpoint's own answer: its code, and (when it says) how many mails were taken in before it stopped.
    case answered(DemoCode, processed: Int?)
    /// The request certainly never reached the server (no connection at all, the host cannot be connected to):
    /// a failure, and nothing happened there.
    case notSent
    /// No answer, a redirect, or something that is not the endpoint's JSON (a timeout, a connection lost on the way,
    /// cancelled): whether it went through is not known.
    case unknown
}

protocol DemoAPI: Sendable {
    func load(accessToken: String) async -> Result<DemoLoaded, DemoFailure>
    func clear(accessToken: String) async -> Result<Void, DemoFailure>
}

struct DemoAPIClient: DemoAPI {
    /// The load can run for up to 300 seconds on the server (maxDuration); the request waits a little longer than that
    /// (URLSession's own is 60 seconds, so it is set here). Even when it gives up first, the server reads on to the end.
    static let loadTimeout: TimeInterval = 310
    static let clearTimeout: TimeInterval = 60

    /// The errors that say the request was never sent (nothing reached the server).
    static let neverSent: Set<URLError.Code> = [.notConnectedToInternet, .cannotConnectToHost]

    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = AppConfig.webBase, session: URLSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func load(accessToken: String) async -> Result<DemoLoaded, DemoFailure> {
        switch await post("load", [:], timeout: Self.loadTimeout, accessToken: accessToken) {
        case let .failure(failure):
            return .failure(failure)
        case let .success(answer):
            // `processed` is a whole number and `busy` JSON true or false: else this is not the endpoint's answer.
            guard let processed = (answer["processed"] as? NSNumber).flatMap(Self.wholeNumber), processed >= 0,
                  let busy = answer["busy"] as? NSNumber, CFGetTypeID(busy) == CFBooleanGetTypeID()
            else { return .failure(.unknown) }
            return .success(DemoLoaded(processed: processed, busy: busy.boolValue))
        }
    }

    func clear(accessToken: String) async -> Result<Void, DemoFailure> {
        switch await post("clear", ["confirm": "yes"], timeout: Self.clearTimeout, accessToken: accessToken) {
        case let .failure(failure): .failure(failure)
        case .success: .success(())
        }
    }

    private static func wholeNumber(_ number: NSNumber) -> Int? {
        guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let value = number.doubleValue
        return value == value.rounded() && abs(value) < 1_000_000 ? Int(value) : nil
    }

    /// `{ ok: true, ... }` on 200; else the code of `{ ok: false, code }`. Anything else is .unknown.
    private func post(_ endpoint: String, _ body: [String: Any], timeout: TimeInterval, accessToken: String) async -> Result<[String: Any], DemoFailure> {
        var request = URLRequest(url: baseURL.appending(path: "api/demo/\(endpoint)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = timeout
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return .failure(.unknown) }
        request.httpBody = data
        let reply: (Data, URLResponse)
        do {
            reply = try await session.data(for: request, delegate: KeyAPIClient.NoRedirect())
        } catch let error as URLError where Self.neverSent.contains(error.code) {
            return .failure(.notSent)
        } catch {
            return .failure(.unknown)
        }
        guard let http = reply.1 as? HTTPURLResponse,
              let object = (try? JSONSerialization.jsonObject(with: reply.0)) as? [String: Any]
        else { return .failure(.unknown) }
        if http.statusCode == 200, KeyAPIClient.isJSONTrue(object["ok"]) { return .success(object) }
        guard let text = object["code"] as? String, let code = DemoCode(rawValue: text)
        else { return .failure(.unknown) }
        let processed = (object["processed"] as? NSNumber).flatMap(Self.wholeNumber).flatMap { $0 >= 0 && $0 <= 999 ? $0 : nil }
        return .failure(.answered(code, processed: processed))
    }
}
