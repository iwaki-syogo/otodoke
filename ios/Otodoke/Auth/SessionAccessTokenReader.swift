import Auth
import Foundation

/// Reads a token for a generation captured by its caller; a refreshed token may still belong to that generation.
struct SessionAccessTokenReader: Sendable {
    private let session: @Sendable () async throws -> Session
    private let isCurrent: @MainActor @Sendable (SessionStamp) -> Bool

    init(provider: SupabaseProvider, isCurrent: @escaping @MainActor @Sendable (SessionStamp) -> Bool) {
        session = { try await provider.auth.session }
        self.isCurrent = isCurrent
    }

    #if DEBUG
    init(session: @escaping @Sendable () async throws -> Session, isCurrent: @escaping @MainActor @Sendable (SessionStamp) -> Bool) {
        self.session = session
        self.isCurrent = isCurrent
    }
    #endif

    func read(for stamp: SessionStamp?) async -> String? {
        guard let stamp, await isCurrent(stamp),
              let session = try? await session(),
              session.user.id.uuidString.lowercased() == stamp.userID,
              await isCurrent(stamp) else { return nil }
        return session.accessToken
    }
}
