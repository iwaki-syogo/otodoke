// TDD-STUB(task 12) — agreed API, placeholder bodies. Remove this marker once written.
// iOS-12: when the app comes back to the front, the screen shown is read again (only that one).

import Foundation

enum ScreenID: Hashable, Sendable {
    case parcels
    case detail(String)
    case calendar
    case spend
    case settings
}

@MainActor
final class ScreenRefresher {
    typealias Refresh = @MainActor () async -> Void

    init() {}

    func register(_ id: ScreenID, _ refresh: @escaping Refresh) {}
    func unregister(_ id: ScreenID) {}
    /// The screen in front now (a tab, or a detail pushed over the list).
    func shown(_ id: ScreenID) {}
    func hidden(_ id: ScreenID) {}
    /// scenePhase became active: the screen in front reads again, once.
    func sceneBecameActive() async {}
}
