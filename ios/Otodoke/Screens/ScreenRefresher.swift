// iOS-12: when the app comes back to the front, the screen shown is read again (only that one).
// The screens say when they appear and disappear; the one that appeared last and is still shown is the
// one in front (a detail pushed over the list is in front of the list).

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

    /// More than this many shown at once only happens when appearances are missed: the oldest go.
    private static let maxShown = 16

    private var refreshes: [ScreenID: Refresh] = [:]
    /// The screens shown, oldest first; the last is in front. The same id may be in twice (a detail of
    /// one parcel open in two tabs): each `hidden` takes out the older one, as the screen that goes
    /// is the one that appeared before (the new tab may appear before the old one disappears).
    private var shownStack: [ScreenID] = []
    /// The screens being read again for a coming back: a second coming back meanwhile does not read
    /// them once more.
    private var refreshing: Set<ScreenID> = []

    init() {}

    /// The read again of a screen. A second register of the same id replaces the first (the screen
    /// that appeared last is the one shown).
    func register(_ id: ScreenID, _ refresh: @escaping Refresh) {
        refreshes[id] = refresh
    }

    func unregister(_ id: ScreenID) {
        refreshes[id] = nil
    }

    /// The screen in front now (a tab, or a detail pushed over the list).
    func shown(_ id: ScreenID) {
        guard shownStack.last != id else { return }
        shownStack.append(id)
        if shownStack.count > Self.maxShown {
            shownStack.removeFirst(shownStack.count - Self.maxShown)
        }
    }

    func hidden(_ id: ScreenID) {
        guard let i = shownStack.firstIndex(of: id) else { return }
        shownStack.remove(at: i)
    }

    /// scenePhase became active: the screen in front reads again, once.
    func sceneBecameActive() async {
        guard let id = shownStack.last, let refresh = refreshes[id], !refreshing.contains(id) else { return }
        refreshing.insert(id)
        defer { refreshing.remove(id) }
        await refresh()
    }
}

// TDD-STUB(review-1): [N3] Screens told apart by a token per appearance; the front comes from the tab
// selected and what is stacked on it (a pushed detail is over its tab's root), not from the order the
// appear and disappear calls come in. Names and signatures are the contract; the bodies do nothing.

/// One appearance of a screen (a detail of one parcel may be open in two tabs at once).
struct ScreenToken: Hashable, Sendable {
    let raw: Int
}

extension ScreenRefresher {
    /// The TabView's selection.
    func select(_ tab: MainTab) {
        // TDD-STUB(review-1)
    }

    /// A screen of `tab` appeared (its root, or a detail pushed on its stack); `refresh` is kept until
    /// `disappeared` with the token given back.
    func appeared(_ id: ScreenID, in tab: MainTab, refresh: @escaping Refresh) -> ScreenToken {
        ScreenToken(raw: 0) // TDD-STUB(review-1)
    }

    /// That appearance is over: its refresh is let go (nothing piles up).
    func disappeared(_ token: ScreenToken) {
        // TDD-STUB(review-1)
    }
}
