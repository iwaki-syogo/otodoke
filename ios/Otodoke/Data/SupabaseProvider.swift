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

extension KeychainSessionStorage {
    /// Deletes every item of this service. true when none is left (deleted, or there was none).
    @discardableResult
    func removeAll() -> Bool {
        let status = SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ] as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}

/// The Keychain outlives the app: deleting the app leaves the session, and installing it again would
/// open signed in (there is no sign-out button in this batch, so deleting the app is how people sign
/// out). A marker file in Application Support goes with the app: when it is missing, this is the first
/// launch of this install, and any session left in the Keychain is removed before anything reads it.
/// The Keychain is cleared only once the marker is written (CF3): when the marker cannot be made, the
/// Keychain is left alone, so a session saved now is not taken for a leftover on the next launch.
enum FreshInstall {
    enum Outcome: Equatable, Sendable {
        /// The marker was there: a later launch, nothing touched.
        case installed
        /// The marker was missing; it is written and the Keychain is clear.
        case cleared
        /// The marker could not be made (the folder or the file): the Keychain is left as it is.
        case markerFailed
        /// The marker was written but the Keychain could not be cleared: the marker is taken away
        /// again, so the clearing is tried on the next launch.
        case clearFailed
    }

    static var marker: URL {
        URL.applicationSupportDirectory.appending(path: "installed", directoryHint: .notDirectory)
    }

    /// Looks for the marker; when it is missing, writes it and then clears the Keychain.
    static func prepare(marker: URL = FreshInstall.marker, keychain: KeychainSessionStorage = KeychainSessionStorage()) -> Outcome {
        let files = FileManager.default
        guard !files.fileExists(atPath: marker.path(percentEncoded: false)) else { return .installed }
        do {
            try files.createDirectory(at: marker.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data().write(to: marker, options: .withoutOverwriting)
        } catch {
            return .markerFailed
        }
        guard keychain.removeAll() else {
            try? files.removeItem(at: marker)
            return .clearFailed
        }
        return .cleared
    }

    /// true when the leftovers were cleared (the marker was missing and could be made).
    @discardableResult
    static func clearLeftoverSession(marker: URL = FreshInstall.marker, keychain: KeychainSessionStorage = KeychainSessionStorage()) -> Bool {
        prepare(marker: marker, keychain: keychain) == .cleared
    }
}

/// supabase-swift's storage slot, filled by the app's SessionStorage.
private struct SessionStorageBridge: AuthLocalStorage {
    let storage: any SessionStorage

    func store(key: String, value: Data) throws { try storage.store(key: key, value: value) }
    func retrieve(key: String) throws -> Data? { try storage.retrieve(key: key) }
    func remove(key: String) throws { try storage.remove(key: key) }
}

/// Password confirmation returns a fresh token without storing an app session.
private struct RecoveryAuthStorage: AuthLocalStorage {
    func store(key: String, value: Data) throws {}
    func retrieve(key: String) throws -> Data? { nil }
    func remove(key: String) throws {}
}

final class SupabaseProvider: Sendable {
    let config: AppConfig
    let storage: any SessionStorage
    /// GoTrue (implicit flow: a confirmation link opened in any browser works).
    let auth: AuthClient
    /// PostgREST, always with the signed-in user's JWT (never the anon key alone). No automatic
    /// retries: a failed read shows 「読み込めませんでした」 and a write is never sent twice.
    let database: PostgrestClient

    /// A login request that got no answer, or a server error, on a call that must not be sent twice
    /// (making an account, the password sign-in, the confirmation mail again, signing out). supabase-swift retries POST requests on
    /// URLErrors and 5xx; this error type is not retried, so one press is one mail.
    enum NoRetry: Error, Equatable, Sendable {
        case noAnswer(URLError.Code)
        case server(status: Int)
    }

    /// The session every request of this provider goes through (also the Web's key endpoints, KeyAPIClient).
    let urlSession: URLSession

    init(config: AppConfig, urlSession: URLSession = .shared, storage: any SessionStorage) {
        self.config = config
        self.storage = storage
        self.urlSession = urlSession
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

    /// iOS-10: the session the app's provider uses for PostgREST and Auth. Mail bodies come back in its
    /// answers, so nothing of them may stay in a disk cache: ephemeral (memory only), with no cache at
    /// all on top. Made once, so every provider shares one connection pool.
    static func liveURLSession() -> URLSession { liveSession }

    private static let liveSession: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    /// The app's provider: the session without a disk cache and the Keychain.
    static func live(config: AppConfig) -> SupabaseProvider {
        SupabaseProvider(config: config, urlSession: liveURLSession(), storage: KeychainSessionStorage())
    }

    /// Uses the same CAPTCHA transport and one-POST policy without sharing app storage or event subscriptions.
    func makeRecoveryAuthClient() -> AuthClient {
        AuthClient(
            url: config.supabaseURL.appending(path: "auth/v1"),
            headers: ["apikey": config.anonKey],
            flowType: .implicit,
            redirectToURL: AppConfig.authRedirect,
            storageKey: "key-recovery-\(UUID().uuidString)",
            localStorage: RecoveryAuthStorage(),
            fetch: Self.authFetch(urlSession),
            autoRefreshToken: false,
            emitLocalSessionAsInitialSession: false
        )
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

    /// Token refreshes keep supabase-swift's retries; other POSTs (sign-up, the password sign-in, resend, logout)
    /// are sent once.
    private static func authFetch(_ urlSession: URLSession) -> AuthClient.FetchHandler {
        { request in
            let once = request.httpMethod == "POST" && !isRefresh(request)
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

    /// POST /token?grant_type=refresh_token.
    private static func isRefresh(_ request: URLRequest) -> Bool {
        guard let url = request.url, url.lastPathComponent == "token" else { return false }
        let grant = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "grant_type" }?.value
        return grant == "refresh_token"
    }
}
