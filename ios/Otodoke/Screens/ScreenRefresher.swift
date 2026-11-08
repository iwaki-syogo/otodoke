// iOS-12: when the app comes back to the front, the screen shown is read again (only that one).
// [N3] Each appearance of a screen gets its own token (a detail of one parcel may be open in two tabs);
// the front is the selected tab's top screen: the deepest on its stack (the root 0, a page pushed on it
// 1, a detail pushed on a delivered or cancelled page 2), and of two at the same depth the one that
// appeared later, whatever order the appear and disappear calls come in. A screen that disappears is
// let go. [N-new3] The older id-keyed API is gone: every screen and test tells the refresher by token.

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
        /// Reads again only when the screen is stale (its onAppear): what DataChanges moving calls.
        let refreshIfStale: Refresh?
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
    func appeared(_ id: ScreenID, in tab: MainTab, depth: Int? = nil, refresh: @escaping Refresh, refreshIfStale: Refresh? = nil) -> ScreenToken {
        lastToken += 1
        let token = ScreenToken(raw: lastToken)
        appearances[token] = Appearance(id: id, tab: tab, order: lastToken, depth: depth ?? id.depth, refresh: refresh, refreshIfStale: refreshIfStale)
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

    init() {}

    // MARK: coming back

    /// scenePhase became active: the screen in front reads again, once.
    func sceneBecameActive() async {
        guard let front, !refreshingTokens.contains(front.token) else { return }
        refreshingTokens.insert(front.token)
        defer { refreshingTokens.remove(front.token) }
        await front.appearance.refresh()
    }

    /// DataChanges moved (a long load or write finished while another screen was in front): the screen in
    /// front reads again when it is stale, as its onAppear would; the others wait for theirs. The models'
    /// fences keep a read already running from being doubled.
    func dataChanged() async {
        guard let refreshIfStale = front?.appearance.refreshIfStale else { return }
        await refreshIfStale()
    }
}

/// One appearance of a screen (a detail of one parcel may be open in two tabs at once).
struct ScreenToken: Hashable, Sendable {
    let raw: Int
}
