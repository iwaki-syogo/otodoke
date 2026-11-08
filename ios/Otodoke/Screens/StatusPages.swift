// The delivered and cancelled pages as the 荷物 and カレンダー tabs open them (tasks 21, 22): the models come
// from MainScreens (one DataChanges for every screen), and each page tells the ScreenRefresher while it is
// shown (by token, in the tab that pushed it), so it reads again when the app comes back to the front
// (iOS-12). Kept apart from MainTabView.swift, which only hands these down through the environment.

import SwiftUI

/// Makes the pages' models for one sign-in.
@MainActor
final class StatusPages {
    let refresher: ScreenRefresher
    private let makeDelivered: () -> DeliveredModel
    private let makeCancelled: () -> CancelledModel

    init(refresher: ScreenRefresher, delivered: @escaping () -> DeliveredModel, cancelled: @escaping () -> CancelledModel) {
        self.refresher = refresher
        makeDelivered = delivered
        makeCancelled = cancelled
    }

    func delivered() -> DeliveredModel { makeDelivered() }
    func cancelled() -> CancelledModel { makeCancelled() }
}

extension MainScreens {
    /// The pages' models, told of the shared changes; the refresher of the tabs.
    var statusPages: StatusPages {
        StatusPages(refresher: refresher, delivered: { [unowned self] in delivered() }, cancelled: { [unowned self] in cancelled() })
    }
}

private struct StatusPagesKey: EnvironmentKey {
    static let defaultValue: StatusPages? = nil
}

extension EnvironmentValues {
    /// Set by MainTabView; nil in a screen shown on its own (the screenshots).
    var statusPages: StatusPages? {
        get { self[StatusPagesKey.self] }
        set { self[StatusPagesKey.self] = newValue }
    }
}

/// One appearance of a page: its model is made once, and the refresher knows it while it is shown (by
/// token, as the tabs' screens: a page pushed on `tab`'s root, so 1 deep; the details it opens 2 deep).
struct StatusPage<Model: AnyObject, Content: View>: View {
    let id: ScreenID
    let tab: MainTab
    let refresher: ScreenRefresher
    let refresh: @MainActor (Model) async -> Void
    let ifStale: @MainActor (Model) async -> Void
    @ViewBuilder let content: (Model) -> Content
    @State private var model: Model

    init(
        _ make: () -> Model,
        _ id: ScreenID,
        _ refresher: ScreenRefresher,
        in tab: MainTab,
        refresh: @escaping @MainActor (Model) async -> Void,
        ifStale: @escaping @MainActor (Model) async -> Void,
        @ViewBuilder content: @escaping (Model) -> Content
    ) {
        self.id = id
        self.tab = tab
        self.refresher = refresher
        self.refresh = refresh
        self.ifStale = ifStale
        self.content = content
        _model = State(initialValue: make())
    }

    var body: some View {
        let model = self.model
        let refresh = self.refresh
        let ifStale = self.ifStale
        content(model)
            // The page's links hand this to the detail they push (StatusPageGroups).
            .environment(\.detailDepth, id.depth + 1)
            .shownScreen(id, in: tab, refresher, refresh: { [weak model] in
                guard let model else { return }
                await refresh(model)
            }, ifStale: { [weak model] in
                guard let model else { return }
                await ifStale(model)
            })
    }
}
