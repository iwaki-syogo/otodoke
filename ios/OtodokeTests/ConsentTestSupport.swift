import Foundation
@testable import Otodoke

/// Pre-consent suites opt into their known-allowed baseline. Production defaults always load consent.
extension AIReadingConsentModel {
    @MainActor
    static func allowedForTests() -> AIReadingConsentModel {
        let session = SessionGeneration()
        session.follow(userID: "known-allowed-test")
        return AIReadingConsentModel(store: KnownAllowedConsentStore(), session: session,
                                     loadFailureMessage: SettingsModel.failedText, saveFailureMessage: ManualParcelText.failed)
    }
}

private struct KnownAllowedConsentStore: AIReadingConsentStoring {
    func load(for stamp: SessionStamp) async -> LoadResult<AIReadingDecision> { .loaded(.allowed) }
    func save(_ allowed: Bool, for stamp: SessionStamp) async -> LoadResult<AIReadingConsentSaveReceipt> {
        .loaded(AIReadingConsentSaveReceipt(decision: allowed ? .allowed : .denied, decidedAt: "2026-11-12T00:00:00.000001+00:00", stamp: stamp))
    }
}
