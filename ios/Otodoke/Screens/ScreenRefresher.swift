// iOS-12: when the app comes back to the front, the screen shown is read again (only that one).
// [N3] Each appearance of a screen gets its own token (a detail of one parcel may be open in two tabs);
// the front is the selected tab's top screen: the deepest on its stack (the root 0, a page pushed on it
// 1, a detail pushed on a delivered or cancelled page 2), and of two at the same depth the one that
// appeared later, whatever order the appear and disappear calls come in. A screen that disappears is
// let go. The older API (register / shown / hidden / unregister) is not used by the app any more; it
// stays only for RefreshWiringTests and ScreenRefresherOrderTests (moving them needs a test change
// approval, N-new3), and is read only when no screen appeared by token.

import Foundation

enum ScreenID: Hashable, Sendable {
    case parcels
    case detail(String)
    case calendar
    case spend
    case settings
    /// The delivered and cancelled pages (tasks 21, 22).
    case delivered
    case cancelled

    /// How deep the screen sits on its tab's stack when the caller does not say: a tab's root 0, a
    /// detail or a delivered / cancelled page pushed on it 1.
    var depth: Int {
        switch self {
        case .detail, .delivered, .cancelled: 1
        case .parcels, .calendar, .spend, .settings: 0
        }
    }
}

@MainActor
final class ScreenRefresher {
    typealias Refresh = @MainActor () async -> Void

    // MARK: by token (the app)

    private struct Appearance {
        let id: ScreenID
        let tab: MainTab
        /// The order it appeared in (larger is later).
        let order: Int
        /// On the tab's stack: the root 0; deeper is over it.
        let depth: Int
        let refresh: Refresh
    }

    private var appearances: [ScreenToken: Appearance] = [:]
    private var lastToken = 0
    private var selected: MainTab?
    /// The appearances being read again for a coming back: a second coming back meanwhile does not read
    /// them once more.
    private var refreshingTokens: Set<ScreenToken> = []

    /// The TabView's selection.
    func select(_ tab: MainTab) {
        selected = tab
    }

    /// A screen of `tab` appeared (its root, or a screen pushed on its stack, `depth` deep: `id.depth`
    /// when nil); `refresh` is kept until `disappeared` with the token given back.
    func appeared(_ id: ScreenID, in tab: MainTab, depth: Int? = nil, refresh: @escaping Refresh) -> ScreenToken {
        lastToken += 1
        let token = ScreenToken(raw: lastToken)
        appearances[token] = Appearance(id: id, tab: tab, order: lastToken, depth: depth ?? id.depth, refresh: refresh)
        return token
    }

    /// That appearance is over: its refresh is let go (nothing piles up).
    func disappeared(_ token: ScreenToken) {
        appearances[token] = nil
    }

    /// The selected tab's top screen (all tabs before any selection).
    private var front: (token: ScreenToken, appearance: Appearance)? {
        appearances
            .filter { selected == nil || $0.value.tab == selected }
            .max { a, b in
                a.value.depth != b.value.depth ? a.value.depth < b.value.depth : a.value.order < b.value.order
            }
            .map { (token: $0.key, appearance: $0.value) }
    }

    // MARK: by id (the older API)

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

    // MARK: coming back

    /// scenePhase became active: the screen in front reads again, once.
    func sceneBecameActive() async {
        if !appearances.isEmpty {
            guard let front, !refreshingTokens.contains(front.token) else { return }
            refreshingTokens.insert(front.token)
            defer { refreshingTokens.remove(front.token) }
            await front.appearance.refresh()
            return
        }
        guard let id = shownStack.last, let refresh = refreshes[id], !refreshing.contains(id) else { return }
        refreshing.insert(id)
        defer { refreshing.remove(id) }
        await refresh()
    }
}

/// One appearance of a screen (a detail of one parcel may be open in two tabs at once).
struct ScreenToken: Hashable, Sendable {
    let raw: Int
}
