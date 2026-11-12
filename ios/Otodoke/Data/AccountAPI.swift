import Foundation

enum AccountAPIFailure: Error, Equatable, Sendable {
    case unauthorized, invalidInput, deleteFailed, unavailable, network
}

protocol AccountDeleting: Sendable {
    func deleteAccount(accessToken: String) async throws(AccountAPIFailure)
}

/// The native counterpart of the Web's confirmation form. No redirect and no automatic retry.
struct AccountAPIClient: AccountDeleting {
    let baseURL: URL
    let session: URLSession

    init(baseURL: URL = AppConfig.webBase, session: URLSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func deleteAccount(accessToken: String) async throws(AccountAPIFailure) {
        var request = URLRequest(url: baseURL.appending(path: "api/account/delete"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 30
        request.httpBody = Data(#"{"confirm":"delete-account"}"#.utf8)
        let reply: (Data, URLResponse)
        do { reply = try await session.data(for: request, delegate: KeyAPIClient.NoRedirect()) }
        catch { throw .network }
        guard let http = reply.1 as? HTTPURLResponse,
              let object = (try? JSONSerialization.jsonObject(with: reply.0)) as? [String: Any]
        else { throw .network }
        if http.statusCode == 200, KeyAPIClient.isJSONTrue(object["ok"]) { return }
        switch (http.statusCode, object["code"] as? String) {
        case (401, "unauthorized"): throw .unauthorized
        case (400, "invalid_input"): throw .invalidInput
        case (500, "delete_failed"): throw .deleteFailed
        case (503, "unavailable"): throw .unavailable
        default: throw .network
        }
    }
}
