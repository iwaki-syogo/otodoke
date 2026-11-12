import Foundation

enum SettingsMailAPIFailure: Error, Equatable, Sendable {
    case unauthorized, invalidInput, unavailable, forgetFailed, dismissFailed, network, unknownResult
}

/// Independent of the reading-consent and read-waiting protocols.
protocol SettingsMailActionsAPI: Sendable {
    func forgetSender(domain: String, accessToken: String) async throws(SettingsMailAPIFailure)
    func dismissIntake(limitedAt: String, accessToken: String) async throws(SettingsMailAPIFailure)
}

struct SettingsMailActionsClient: SettingsMailActionsAPI {
    let baseURL: URL
    let session: URLSession
    let timeout: TimeInterval

    init(baseURL: URL = AppConfig.webBase, session: URLSession, timeout: TimeInterval = 30) {
        self.baseURL = baseURL
        self.session = session
        self.timeout = timeout
    }

    func forgetSender(domain: String, accessToken: String) async throws(SettingsMailAPIFailure) {
        guard !domain.isEmpty, domain.utf16.count <= 255 else { throw .invalidInput }
        // The value shown by the reader is the database condition, not a newly normalized domain.
        try await post("forget-sender", body: ["domain": domain], accessToken: accessToken)
    }

    func dismissIntake(limitedAt: String, accessToken: String) async throws(SettingsMailAPIFailure) {
        guard Instant.micros(limitedAt) != nil else { throw .invalidInput }
        // Validate only: keep the server's fractional seconds and time-zone spelling unchanged.
        try await post("dismiss-intake", body: ["limited_at": limitedAt], accessToken: accessToken)
    }

    private func post(_ endpoint: String, body: [String: String], accessToken: String) async throws(SettingsMailAPIFailure) {
        var request = URLRequest(url: baseURL.appending(path: "api/mail/\(endpoint)"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = timeout
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { throw .invalidInput }
        request.httpBody = data
        let reply: (Data, URLResponse)
        do {
            reply = try await session.data(for: request, delegate: KeyAPIClient.NoRedirect())
        } catch is CancellationError {
            throw .unknownResult
        } catch let error as URLError where Self.uncertain.contains(error.code) {
            throw .unknownResult
        } catch {
            throw .network
        }
        guard !Task.isCancelled else { throw .unknownResult }
        guard let http = reply.1 as? HTTPURLResponse else { throw .unknownResult }
        guard http.statusCode == 200 || !(200...299).contains(http.statusCode) else { throw .unknownResult }
        guard let object = (try? JSONSerialization.jsonObject(with: reply.0)) as? [String: Any] else {
            throw http.statusCode == 200 || http.statusCode >= 500 ? .unknownResult : .network
        }
        if http.statusCode == 200, KeyAPIClient.isJSONTrue(object["ok"]) { return }
        // A malformed success cannot be turned into a definite outcome by its `code` field.
        guard http.statusCode != 200 else { throw .unknownResult }
        switch (http.statusCode, object["code"] as? String) {
        case (401, "unauthorized"): throw .unauthorized
        case (400, "invalid_input"): throw .invalidInput
        case (503, "unavailable"): throw .unavailable
        case (500, "forget_failed"): throw .forgetFailed
        case (500, "dismiss_failed"): throw .dismissFailed
        default: throw http.statusCode >= 500 ? .unknownResult : .network
        }
    }

    private static let uncertain: Set<URLError.Code> = [
        .timedOut, .cancelled, .networkConnectionLost, .secureConnectionFailed,
        .badServerResponse, .cannotParseResponse, .zeroByteResource,
    ]
}
