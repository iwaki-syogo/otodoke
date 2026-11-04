// Holds the supabase-swift client: anon key + the user's JWT, every request through `urlSession`
// (tests pass a URLProtocol-stubbed session), the session kept in `storage` (Keychain in the app).

import Auth
import Foundation
import PostgREST
import Security

/// Where the auth session is kept. Bridge it to supabase-swift's local storage.
protocol SessionStorage: Sendable {
    func store(key: String, value: Data) throws
    func retrieve(key: String) throws -> Data?
    func remove(key: String) throws
}

/// The app's storage: the Keychain. The session (with its refresh token) stays on this device: it is
/// readable after the first unlock (auto-refresh in the background) and never restored to another
/// device from a backup.
final class KeychainSessionStorage: SessionStorage {
    let service: String

    init(service: String = "com.iwakisyogo.otodoke.auth") {
        self.service = service
    }

    struct Failure: Error, Equatable {
        let status: OSStatus
    }

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    func store(key: String, value: Data) throws {
        let updated = SecItemUpdate(query(key) as CFDictionary, [kSecValueData as String: value] as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw Failure(status: updated) }
        var item = query(key)
        item[kSecValueData as String] = value
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(item as CFDictionary, nil)
        guard added == errSecSuccess else { throw Failure(status: added) }
    }

    func retrieve(key: String) throws -> Data? {
        var find = query(key)
        find[kSecReturnData as String] = true
        find[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        let status = SecItemCopyMatching(find as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure(status: status) }
        return result as? Data
    }

    func remove(key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
    }
}

/// supabase-swift's storage slot, filled by the app's SessionStorage.
private struct SessionStorageBridge: AuthLocalStorage {
    let storage: any SessionStorage

    func store(key: String, value: Data) throws { try storage.store(key: key, value: value) }
    func retrieve(key: String) throws -> Data? { try storage.retrieve(key: key) }
    func remove(key: String) throws { try storage.remove(key: key) }
}

final class SupabaseProvider: Sendable {
    let config: AppConfig
    let storage: any SessionStorage
    /// GoTrue (implicit flow: a login link opened in any browser works, the 8-digit code is unaffected).
    let auth: AuthClient
    /// PostgREST, always with the signed-in user's JWT (never the anon key alone). No automatic
    /// retries: a failed read shows 「読み込めませんでした」 and a write is never sent twice.
    let database: PostgrestClient

    /// A login request that got no answer, or a server error, on a call that must not be sent twice
    /// (sending the code, verifying it, signing out). supabase-swift retries POST requests on
    /// URLErrors and 5xx; this error type is not retried, so one press is one mail.
    enum NoRetry: Error, Equatable, Sendable {
        case noAnswer(URLError.Code)
        case server(status: Int)
    }

    init(config: AppConfig, urlSession: URLSession = .shared, storage: any SessionStorage) {
        self.config = config
        self.storage = storage
        let auth = AuthClient(
            url: config.supabaseURL.appending(path: "auth/v1"),
            headers: ["apikey": config.anonKey],
            flowType: .implicit,
            redirectToURL: AppConfig.authRedirect,
            storageKey: Self.storageKey(for: config),
            localStorage: SessionStorageBridge(storage: storage),
            fetch: Self.authFetch(urlSession),
            autoRefreshToken: true,
            emitLocalSessionAsInitialSession: true
        )
        self.auth = auth
        database = PostgrestClient(configuration: PostgrestClient.Configuration(
            url: config.supabaseURL.appending(path: "rest/v1"),
            headers: ["apikey": config.anonKey],
            fetch: { request in
                // Refreshes an expired token first; with no session this throws (sessionMissing).
                let token = try await auth.session.accessToken
                var request = request
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                return try await urlSession.data(for: request)
            },
            retryEnabled: false
        ))
    }

    /// The app's provider: URLSession.shared and the Keychain.
    static func live(config: AppConfig) -> SupabaseProvider {
        SupabaseProvider(config: config, storage: KeychainSessionStorage())
    }

    /// The signed-in user's id (lowercase UUID text), or nil when signed out.
    func currentUserID() async -> String? {
        auth.currentSession?.user.id.uuidString.lowercased()
    }

    /// Drops the stored session on this device (used when signing out could not clear it).
    func clearStoredSession() {
        try? storage.remove(key: Self.storageKey(for: config))
    }

    /// sb-<project ref>-auth-token, as supabase-js names it.
    static func storageKey(for config: AppConfig) -> String {
        let ref = config.supabaseURL.host()?.split(separator: ".").first.map(String.init) ?? "otodoke"
        return "sb-\(ref)-auth-token"
    }

    /// Token refreshes keep supabase-swift's retries; other POSTs (code, verify, logout) are sent once.
    private static func authFetch(_ urlSession: URLSession) -> AuthClient.FetchHandler {
        { request in
            let once = request.httpMethod == "POST" && request.url?.lastPathComponent != "token"
            let answer: (Data, URLResponse)
            do {
                answer = try await urlSession.data(for: request)
            } catch let error as URLError where once {
                throw NoRetry.noAnswer(error.code)
            }
            if once, let http = answer.1 as? HTTPURLResponse, (500...599).contains(http.statusCode) {
                throw NoRetry.server(status: http.statusCode)
            }
            return answer
        }
    }
}
