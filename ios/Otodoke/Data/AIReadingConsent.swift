import Foundation
import PostgREST

/// App state, kept separate from the database's granted/declined vocabulary.
enum AIReadingDecision: Equatable, Sendable {
    case notDetermined
    case allowed
    case denied
}

enum AIReadingConsentContract {
    static let textVersion = "v1"
}

/// A successful read includes a real absence (.notDetermined). Transport/decoding failures never do.
/// A save succeeds only when the server confirms the requested decision with its own timestamp.
protocol AIReadingConsentStoring: Sendable {
    func load(for stamp: SessionStamp) async -> LoadResult<AIReadingDecision>
    func save(_ allowed: Bool, for stamp: SessionStamp) async -> LoadResult<AIReadingDecision>
}

/// A safe placeholder for previews or an integration whose server contract is unavailable.
struct UnavailableAIReadingConsentStore: AIReadingConsentStoring {
    func load(for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> { .failed }
    func save(_ allowed: Bool, for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> { .failed }
}

/// The signed-in person's PostgREST reads and set_ai_reading RPC. No retries or local persistence.
/// The JWT is captured for this user before building a request; a session changed during an await
/// cannot make an old write run as the newly signed-in person.
struct AIReadingConsentClient: AIReadingConsentStoring {
    private let database: @Sendable (SessionStamp) async -> PostgrestClient?
    private let isCurrent: @MainActor @Sendable (SessionStamp) -> Bool

    init(provider: SupabaseProvider, isCurrent: @escaping @MainActor @Sendable (SessionStamp) -> Bool) {
        self.isCurrent = isCurrent
        database = { stamp in
            guard await isCurrent(stamp), let session = try? await provider.auth.session,
                  session.user.id.uuidString.lowercased() == stamp.userID,
                  await isCurrent(stamp) else { return nil }
            return PostgrestClient(configuration: PostgrestClient.Configuration(
                url: provider.config.supabaseURL.appending(path: "rest/v1"),
                headers: ["apikey": provider.config.anonKey, "Authorization": "Bearer \(session.accessToken)"],
                fetch: { request in try await provider.urlSession.data(for: request) },
                retryEnabled: false
            ))
        }
    }

    #if DEBUG
    /// A wire-level test client. It uses the same PostgREST SDK and injected URLProtocol as the app.
    init(database: PostgrestClient, isCurrent: @escaping @MainActor @Sendable (SessionStamp) -> Bool) {
        self.isCurrent = isCurrent
        self.database = { _ in database }
    }
    #endif

    private enum StoredDecision: String, Decodable {
        case granted
        case declined

        var appDecision: AIReadingDecision { self == .granted ? .allowed : .denied }
    }

    private struct Stored: Decodable {
        let decision: StoredDecision
        let decidedAt: String
        let textVersion: String

        enum CodingKeys: String, CodingKey {
            case decision
            case decidedAt = "decided_at"
            case textVersion = "text_version"
        }
    }

    private struct Saved: Decodable {
        let decision: StoredDecision
        let decidedAt: String

        enum CodingKeys: String, CodingKey {
            case decision
            case decidedAt = "decided_at"
        }
    }

    private struct Parameters: Encodable {
        let decision: String
        let textVersion = AIReadingConsentContract.textVersion

        enum CodingKeys: String, CodingKey {
            case decision = "p_decision"
            case textVersion = "p_text_version"
        }
    }

    func load(for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> {
        guard await isCurrent(stamp), let database = await database(stamp), await isCurrent(stamp) else { return .failed }
        do {
            let response = try await database.from("ai_reading_consents")
                .select("decision, decided_at, text_version")
                .eq("user_id", value: stamp.userID)
                .execute()
            guard await isCurrent(stamp), !Task.isCancelled,
                  let rows = try? JSONDecoder().decode([Stored].self, from: response.data), rows.count <= 1 else { return .failed }
            // Zero rows is a legitimate existing/new user's first choice, never an implicit refusal.
            guard let row = rows.first else { return .loaded(.notDetermined) }
            guard Instant.micros(row.decidedAt) != nil else { return .failed }
            // A wording version alone does not invalidate an explicit choice in this release.
            return .loaded(row.decision.appDecision)
        } catch {
            return .failed
        }
    }

    func save(_ allowed: Bool, for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> {
        guard await isCurrent(stamp), let database = await database(stamp), await isCurrent(stamp) else { return .failed }
        let requested = allowed ? AIReadingDecision.allowed : .denied
        do {
            let response = try await database.rpc("set_ai_reading", params: Parameters(decision: allowed ? "granted" : "declined")).execute()
            guard await isCurrent(stamp), !Task.isCancelled,
                  let rows = try? JSONDecoder().decode([Saved].self, from: response.data), rows.count == 1,
                  let row = rows.first, row.decision.appDecision == requested,
                  Instant.micros(row.decidedAt) != nil else { return .failed }
            return .loaded(requested)
        } catch {
            // A lost response may already have saved the decision. Only a fresh read can confirm it;
            // this call never retries or presents the requested value as the server's answer.
            return .failed
        }
    }
}
