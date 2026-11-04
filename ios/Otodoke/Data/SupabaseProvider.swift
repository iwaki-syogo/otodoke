// TDD-STUB(task 3): type stub written by the test architect so the test target compiles.
// Keep the names and shapes; replace the bodies with the implementation and delete this marker line.
// Holds the supabase-swift client: anon key + the user's JWT, every request through `urlSession`
// (tests pass a URLProtocol-stubbed session), the session kept in `storage` (Keychain in the app).

import Foundation

/// Where the auth session is kept. Bridge it to supabase-swift's local storage.
protocol SessionStorage: Sendable {
    func store(key: String, value: Data) throws
    func retrieve(key: String) throws -> Data?
    func remove(key: String) throws
}

/// The app's storage: the Keychain.
final class KeychainSessionStorage: SessionStorage {
    let service: String

    init(service: String = "com.iwakisyogo.otodoke.auth") {
        self.service = service
    }

    func store(key: String, value: Data) throws {}
    func retrieve(key: String) throws -> Data? { nil }
    func remove(key: String) throws {}
}

final class SupabaseProvider: Sendable {
    let config: AppConfig
    let storage: any SessionStorage

    init(config: AppConfig, urlSession: URLSession = .shared, storage: any SessionStorage) {
        self.config = config
        self.storage = storage
    }

    /// The app's provider: URLSession.shared and the Keychain.
    static func live(config: AppConfig) -> SupabaseProvider {
        SupabaseProvider(config: config, storage: KeychainSessionStorage())
    }

    /// The signed-in user's id (lowercase UUID text), or nil when signed out.
    func currentUserID() async -> String? { nil }
}
