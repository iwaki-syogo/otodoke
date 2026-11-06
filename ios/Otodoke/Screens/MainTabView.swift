// The tabs after sign-in, in the order and with the names of the Web's tab-bar:
// 荷物 / カレンダー / 支出 / 設定. Every screen shares one DataChanges with the writer (CX1): a write on one
// tab makes the others read again when next shown. Back in front from the background, the screen
// shown reads again, and only that one (iOS-12).

import SwiftUI

enum MainTab: CaseIterable, Hashable, Sendable {
    case parcels, calendar, spend, settings

    /// 荷物 / カレンダー / 支出 / 設定 (the Web's tab-bar).
    var title: String {
        switch self {
        case .parcels: "荷物"
        case .calendar: "カレンダー"
        case .spend: "支出"
        case .settings: "設定"
        }
    }

    /// The SF Symbol closest to the Web's icon.
    var systemImage: String {
        switch self {
        case .parcels: "shippingbox"
        case .calendar: "calendar"
        case .spend: "yensign"
        case .settings: "slider.horizontal.3"
        }
    }
}

/// The models of the tabs, made once per sign-in, with one DataChanges and one ScreenRefresher.
@MainActor
final class MainScreens {
    let changes: DataChanges
    let refresher = ScreenRefresher()
    let list: ParcelListModel
    let calendar: CalendarModel
    let spend: SpendModel
    let settings: SettingsModel
    private let makeDetail: (String) -> ParcelDetailModel

    init(
        changes: DataChanges,
        list: ParcelListModel,
        calendar: CalendarModel,
        spend: SpendModel,
        settings: SettingsModel,
        detail: @escaping (String) -> ParcelDetailModel
    ) {
        self.changes = changes
        self.list = list
        self.calendar = calendar
        self.spend = spend
        self.settings = settings
        self.makeDetail = detail
        list.changes = changes
    }

    /// The app's: the signed-in session's provider; the writer publishes to the DataChanges every
    /// screen reads.
    static func live(auth: AuthService) -> MainScreens {
        let changes = DataChanges()
        let reader = ParcelReader(provider: auth.provider)
        let writer = ParcelWriter(provider: auth.provider, changes: changes)
        let today: @Sendable () -> String = { Format.todayJst(now: Date()) }
        let screens = MainScreens(
            changes: changes,
            list: .live(reader: reader, writer: writer),
            calendar: CalendarModel(reader: reader, changes: changes, today: today),
            spend: SpendModel(reader: reader, writer: writer, changes: changes, today: today),
            settings: .live(auth: auth, changes: changes),
            detail: { id in ParcelDetailModel(id: id, reader: reader, writer: writer, today: today) }
        )
        screens.attachKeys(auth: auth)
        return screens
    }

    /// The opened key's store (also AuthService.cleanup), the one UnlockModel every detail uses, and the
    /// settings switch. Set by `live(auth:)` (attachKeys, MainScreens+Keys.swift).
    var keys: OpenKeyStore?
    var unlock: UnlockModel?
    var faceID: FaceIDSwitch?

    /// The delivered page's model, told of the changes.
    func delivered() -> DeliveredModel {
        DeliveredModel(reader: StatusListReader(provider: list.reader.provider), changes: changes)
    }

    /// The cancelled page's model, told of the changes.
    func cancelled() -> CancelledModel {
        CancelledModel(reader: StatusListReader(provider: list.reader.provider), changes: changes)
    }

    /// A parcel's detail model, told of the changes.
    func detail(_ id: String) -> ParcelDetailModel {
        let model = makeDetail(id)
        model.changes = changes
        return model
    }
}

struct MainTabView: View {
    @State private var selection: MainTab
    @State private var screens: MainScreens
    /// The app went to the background since it was last in front.
    @State private var wasInBackground = false
    @Environment(\.scenePhase) private var scenePhase

    init(auth: AuthService) {
        self.init(screens: .live(auth: auth))
    }

    /// With models made elsewhere (the DEBUG screen check): the other tabs read through the list's
    /// reader and writer.
    init(listModel: ParcelListModel, detailModel: ((String) -> ParcelDetailModel)? = nil) {
        let reader = listModel.reader
        let writer = listModel.writer
        let changes = writer.changes ?? DataChanges()
        let today: @Sendable () -> String = { Format.todayJst(now: Date()) }
        self.init(screens: MainScreens(
            changes: changes,
            list: listModel,
            calendar: CalendarModel(reader: reader, changes: changes, today: today),
            spend: SpendModel(reader: reader, writer: writer, changes: changes, today: today),
            settings: .live(auth: AuthService(provider: reader.provider), changes: changes),
            detail: detailModel ?? { id in ParcelDetailModel(id: id, reader: reader, writer: writer, today: today) }
        ))
    }

    init(screens: MainScreens, selection: MainTab = .parcels) {
        _screens = State(initialValue: screens)
        _selection = State(initialValue: selection)
    }

    var body: some View {
        TabView(selection: $selection) {
            ForEach(MainTab.allCases, id: \.self) { tab in
                screen(tab)
                    .tabItem { Label(tab.title, systemImage: tab.systemImage) }
                    .tag(tab)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                wasInBackground = true
                // CX2: the opened key and every opened mail go; work in flight is cancelled.
                screens.keys?.wentToBackground()
            case .active:
                // Back in front (not a system sheet over the app): the screen shown reads again.
                guard wasInBackground else { return }
                wasInBackground = false
                let refresher = screens.refresher
                Task { await refresher.sceneBecameActive() }
            default:
                break
            }
        }
        // The delivered and cancelled pages the 荷物 and カレンダー tabs open (StatusPages.swift).
        .environment(\.statusPages, screens.statusPages)
    }

    @ViewBuilder
    private func screen(_ tab: MainTab) -> some View {
        let screens = self.screens
        switch tab {
        case .parcels:
            let list = screens.list
            ParcelListView(model: list, openSettings: { selection = .settings }) { id in
                TrackedDetail(screens: screens, id: id)
            }
            .shownScreen(.parcels, screens.refresher) { await list.load() }
        case .calendar:
            let calendar = screens.calendar
            CalendarView(model: calendar) { id in
                TrackedDetail(screens: screens, id: id)
            }
            .shownScreen(.calendar, screens.refresher) { await calendar.sceneBecameActive() }
        case .spend:
            let spend = screens.spend
            SpendView(model: spend) { id in
                TrackedDetail(screens: screens, id: id)
            }
            .shownScreen(.spend, screens.refresher) { await spend.sceneBecameActive() }
        case .settings:
            let settings = screens.settings
            SettingsView(model: settings)
                .shownScreen(.settings, screens.refresher) { await settings.sceneBecameActive() }
        }
    }
}

/// A parcel's detail opened from a tab, in front while it is shown.
private struct TrackedDetail: View {
    let refresher: ScreenRefresher
    @State private var model: ParcelDetailModel

    init(screens: MainScreens, id: String) {
        refresher = screens.refresher
        _model = State(initialValue: screens.detail(id))
    }

    var body: some View {
        let model = self.model
        ParcelDetailView(model: model)
            .shownScreen(.detail(model.id), refresher) { [weak model] in await model?.load() }
    }
}

private extension View {
    /// Tells the refresher while this screen is shown, and how it reads again.
    func shownScreen(_ id: ScreenID, _ refresher: ScreenRefresher, refresh: @escaping ScreenRefresher.Refresh) -> some View {
        onAppear {
            refresher.register(id, refresh)
            refresher.shown(id)
        }
        .onDisappear { refresher.hidden(id) }
    }
}
