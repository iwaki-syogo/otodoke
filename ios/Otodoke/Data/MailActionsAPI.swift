// The Web's two mail endpoints, so 「これは荷物」 and 「読み取る」 finish inside the app (no Safari):
//   POST /api/mail/mark-parcel   { "id": "<screen_events.id>" }  -> 200 { ok: true, outcome }
//   POST /api/mail/read-waiting  { }                             -> 200 { ok: true, read, over_limit, busy, stopped }
// (docs/api/mail.md; none of them is a failure. `stopped` and `over_limit` are said as the Web says them; busy: the app only reads
//  again. A server without `stopped` is an older one: it is told nothing of, as before)
// The same shape as the sample endpoints (docs/api/demo.md): POST, JSON, `Authorization: Bearer <access token>`
// with no freshness rule, `Cache-Control: no-store`; a failure is `{ ok: false, code }`. A request is never sent
// again by the client: a second press is a second request the person made.

import Foundation

/// What 「これは荷物」 came to on the server (the Web's markWronglyDropped outcome).
enum MarkParcelOutcome: String, Equatable, Sendable {
    /// The sender is remembered: its next mail is checked by Claude.
    case remembered
    /// A domain many people use (gmail.com, ...): not remembered.
    case shared
    /// A mail forwarded by hand: not remembered.
    case forwarded
    /// The person's own address: not remembered.
    case own
}

/// Why a call did not come to its answer.
enum MailAPIFailure: Error, Equatable, Sendable {
    /// 401: no session, or Supabase Auth refused the token.
    case unauthorized
    /// 400
    case invalidInput
    /// 404 (mark-parcel): no dropped mail of this user with that id.
    case notFound
    /// 500 (mark-parcel): the database failed.
    case markFailed
    /// 503: Supabase Auth could not be asked.
    case unavailable
    /// read-waiting: some mail could not be read (`read_failed`).
    case readFailed
    /// The server did not answer (offline, a reset, a refusal that is not the endpoint's JSON).
    case network
    /// No way to know whether the server did it: the request ran out of time or was cancelled, or a 200 that is not
    /// the endpoint's answer. The caller reads the data again and says nothing.
    case unknownResult
}

/// What a 200 of read-waiting said that the person is told.
struct ReadWaitingResult: Equatable, Sendable {
    /// Reading is stopped on the server (`stopped: true`): trying again does not help.
    var stopped = false
    /// The daily allowance ran out (`over_limit: true`), the rest keep waiting.
    var overLimit = false
}

protocol MailActionsAPI: Sendable {
    func markParcel(id: String, accessToken: String) async throws(MailAPIFailure) -> MarkParcelOutcome
    /// Reads up to 20 waiting mails with Claude on the server: it takes a while (MailActionsClient.readTimeout).
    func readWaiting(accessToken: String) async throws(MailAPIFailure) -> ReadWaitingResult
}

struct MailActionsClient: MailActionsAPI {
    /// The answer of mark-parcel comes at once.
    static let markTimeout: TimeInterval = 30
    /// read-waiting answers only at the end of up to 20 mails read with Claude (the server stops at 300 s).
    static let readTimeout: TimeInterval = 310

    let baseURL: URL
    let session: URLSession
    let markTimeout: TimeInterval
    let readTimeout: TimeInterval

    init(baseURL: URL = AppConfig.webBase, session: URLSession, markTimeout: TimeInterval = Self.markTimeout, readTimeout: TimeInterval = Self.readTimeout) {
        self.baseURL = baseURL
        self.session = session
        self.markTimeout = markTimeout
        self.readTimeout = readTimeout
    }

    func markParcel(id: String, accessToken: String) async throws(MailAPIFailure) -> MarkParcelOutcome {
        let answer = try await post("mark-parcel", ["id": id], timeout: markTimeout, accessToken: accessToken)
        guard let name = answer["outcome"] as? String, let outcome = MarkParcelOutcome(rawValue: name) else { throw .unknownResult }
        return outcome
    }

    /// A body without a boolean `stopped` comes from a server that does not know the field: nothing is said then
    /// (not even the limit), as before. Only JSON `true` / `false` counts (not 1 / 0).
    func readWaiting(accessToken: String) async throws(MailAPIFailure) -> ReadWaitingResult {
        let answer = try await post("read-waiting", [:], timeout: readTimeout, accessToken: accessToken)
        guard Self.isJSONBool(answer["stopped"]) else { return ReadWaitingResult() }
        return ReadWaitingResult(stopped: KeyAPIClient.isJSONTrue(answer["stopped"]), overLimit: KeyAPIClient.isJSONTrue(answer["over_limit"]))
    }

    private static func isJSONBool(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        return CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    /// The connection broke after the request may have gone out: whether the server did the work is not known.
    /// (notConnectedToInternet and cannotConnectToHost are not here: nothing was sent.)
    private static let mayHaveBeenSent: Set<URLError.Code> = [
        .networkConnectionLost, .secureConnectionFailed, .badServerResponse, .cannotParseResponse, .zeroByteResource,
    ]

    /// `{ ok: true, ... }` on 200; the code of `{ ok: false, code }` otherwise (an unknown code, or an answer that is
    /// not the endpoint's JSON, is .network; a 200 without `ok: true` is .unknownResult).
    private func post(_ endpoint: String, _ body: [String: String], timeout: TimeInterval, accessToken: String) async throws(MailAPIFailure) -> [String: Any] {
        var request = URLRequest(url: baseURL.appending(path: "api/mail/\(endpoint)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = timeout
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { throw .invalidInput }
        request.httpBody = data
        let reply: (Data, URLResponse)
        do {
            reply = try await session.data(for: request, delegate: KeyAPIClient.NoRedirect())
        } catch let error as URLError where error.code == .timedOut || error.code == .cancelled {
            throw .unknownResult
        } catch is CancellationError {
            throw .unknownResult
        } catch let error as URLError where Self.mayHaveBeenSent.contains(error.code) {
            throw .unknownResult
        } catch {
            throw .network
        }
        guard let http = reply.1 as? HTTPURLResponse else { throw .network }
        guard let object = (try? JSONSerialization.jsonObject(with: reply.0)) as? [String: Any] else {
            // A 5xx that is not JSON (a gateway: 502, 504): the request got there, so the work may be done.
            throw http.statusCode >= 500 ? .unknownResult : .network
        }
        if http.statusCode == 200, KeyAPIClient.isJSONTrue(object["ok"]) { return object }
        // The code is read whatever the status (read_failed may come with a 200 or an error status).
        switch object["code"] as? String {
        case "unauthorized": throw .unauthorized
        case "invalid_input": throw .invalidInput
        case "not_found": throw .notFound
        case "mark_failed": throw .markFailed
        case "unavailable": throw .unavailable
        case "read_failed": throw .readFailed
        default: throw http.statusCode == 200 ? .unknownResult : .network
        }
    }
}
