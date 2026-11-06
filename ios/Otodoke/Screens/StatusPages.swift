// The delivered and cancelled pages as the 荷物 and カレンダー tabs open them (tasks 21, 22): the models come
// from MainScreens (one DataChanges for every screen), and each page tells the ScreenRefresher while it is
// shown, so it reads again when the app comes back to the front (iOS-12). Kept apart from MainTabView.swift,
// which only hands these down through the environment.

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

/// One appearance of a page: its model is made once, and the refresher knows it while it is shown.
struct StatusPage<Model: AnyObject, Content: View>: View {
    let id: ScreenID
    let refresher: ScreenRefresher
    let refresh: @MainActor (Model) async -> Void
    @ViewBuilder let content: (Model) -> Content
    @State private var model: Model

    init(
        _ make: () -> Model,
        _ id: ScreenID,
        _ refresher: ScreenRefresher,
        refresh: @escaping @MainActor (Model) async -> Void,
        @ViewBuilder content: @escaping (Model) -> Content
    ) {
        self.id = id
        self.refresher = refresher
        self.refresh = refresh
        self.content = content
        _model = State(initialValue: make())
    }

    var body: some View {
        let model = self.model
        let refresh = self.refresh
        content(model)
            .onAppear {
                refresher.register(id) { [weak model] in
                    guard let model else { return }
                    await refresh(model)
                }
                refresher.shown(id)
            }
            .onDisappear { refresher.hidden(id) }
    }
}
