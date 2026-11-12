// DEBUG only: a provider that already holds a signed-in session and reaches no network, for preview
// scenes whose model checks the signed-in user before reading. Release builds contain none of this.

#if DEBUG
import Auth
import Foundation

enum SignedInPreviewSupport {
    static let userID = "00000000-0000-4000-8000-000000049100"

    /// A provider whose stored session is valid for years and whose every request fails at once.
    static func makeProvider() -> SupabaseProvider {
        let config = AppConfig(supabaseURL: URL(string: "https://signed-in-preview.invalid")!, anonKey: "preview", inboundDomain: "preview.invalid")
        let storage = MemoryStorage()
        let expiresAt = Date().timeIntervalSince1970 + 10 * 365 * 24 * 3600
        let reply: [String: Any] = [
            "access_token": "preview-access-token", "token_type": "bearer", "expires_in": 3600,
            "expires_at": expiresAt, "refresh_token": "preview-refresh",
            "user": ["id": userID, "aud": "authenticated", "role": "authenticated", "email": "preview@example.test",
                     "app_metadata": ["provider": "email", "providers": ["email"]], "user_metadata": [String: String](),
                     "identities": [String](), "created_at": "2026-11-01T00:00:00Z", "updated_at": "2026-11-01T00:00:00Z", "is_anonymous": false],
        ]
        if let data = try? JSONSerialization.data(withJSONObject: reply),
           let session = try? AuthClient.Configuration.jsonDecoder.decode(Session.self, from: data),
           let stored = try? AuthClient.Configuration.jsonEncoder.encode(session) {
            try? storage.store(key: SupabaseProvider.storageKey(for: config), value: stored)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.protocolClasses = [UnreachableURLProtocol.self]
        return SupabaseProvider(config: config, urlSession: URLSession(configuration: configuration), storage: storage)
    }

    private final class MemoryStorage: SessionStorage, @unchecked Sendable {
        private let lock = NSLock()
        private var values: [String: Data] = [:]

        func store(key: String, value: Data) throws { lock.withLock { values[key] = value } }
        func retrieve(key: String) throws -> Data? { lock.withLock { values[key] } }
        func remove(key: String) throws { lock.withLock { _ = values.removeValue(forKey: key) } }
    }

    /// Answers every request with an immediate connection failure, so nothing leaves the process.
    private final class UnreachableURLProtocol: URLProtocol, @unchecked Sendable {
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() { client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet)) }
        override func stopLoading() {}
    }
}
#endif
